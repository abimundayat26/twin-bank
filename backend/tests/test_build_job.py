"""The batch twin build: the same twin as POST /twin/build, from a file."""

import tomllib
from datetime import date
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from backend import build_job
from backend.fixtures import FIXTURES_DIR, load_twin
from backend.main import app
from backend.schemas import FinancialTwin, OneTimeObligation

TRANSACTIONS = FIXTURES_DIR / "transactions.json"
BACKEND_DIR = Path(__file__).resolve().parents[1]


def run(tmp_path, *extra: str) -> tuple[int, FinancialTwin | None]:
    out = tmp_path / "twin.json"
    code = build_job.main(["--transactions", str(TRANSACTIONS), "--out", str(out), *extra])
    twin = FinancialTwin.model_validate_json(out.read_text()) if out.exists() else None
    return code, twin


def endpoint_build(**body) -> FinancialTwin:
    response = TestClient(app).post("/twin/build", json={"user_id": "alex", **body})
    assert response.status_code == 200, response.text
    return FinancialTwin.model_validate(response.json())


def test_the_job_builds_the_same_twin_as_the_endpoint(tmp_path):
    code, twin = run(tmp_path)
    assert code == 0
    assert twin == endpoint_build()


def test_as_of_limits_the_history_like_the_endpoint(tmp_path):
    code, twin = run(tmp_path, "--as-of", "2026-03-31")
    assert code == 0
    assert twin.as_of == date(2026, 3, 31)
    assert twin == endpoint_build(as_of="2026-03-31")


def test_a_build_is_handed_to_tracking(tmp_path, monkeypatch):
    logged = []
    monkeypatch.setattr(build_job, "log_twin_build", logged.append)
    _, twin = run(tmp_path)
    assert logged == [twin]


@pytest.mark.parametrize(
    "content, reason",
    [
        (None, "Cannot read"),
        ("not json", "Cannot read"),
        ("{}", "JSON list"),
        ('[{"nonsense": 1}]', "unknown shape"),
        ("[]", "no history"),
    ],
)
def test_bad_input_fails_clearly_and_writes_nothing(tmp_path, capsys, monkeypatch, content, reason):
    logged = []
    monkeypatch.setattr(build_job, "log_twin_build", logged.append)
    source = tmp_path / "transactions.json"
    if content is not None:
        source.write_text(content)
    out = tmp_path / "twin.json"

    code = build_job.main(["--transactions", str(source), "--out", str(out)])

    assert code == 1
    assert reason.lower() in capsys.readouterr().err.lower()
    assert not out.exists()
    assert logged == []


# --- The twin on file ---------------------------------------------------------


def test_twin_flag_sets_the_twin_that_is_rebuilt(tmp_path):
    """On Databricks the fixtures are not installed, so the twin comes in as a file."""
    on_file = load_twin().model_copy(update={"display_name": "Alex (uploaded)"})
    path = tmp_path / "twin_on_file.json"
    path.write_text(on_file.model_dump_json())
    code, twin = run(tmp_path, "--twin", str(path))
    assert code == 0
    assert twin.display_name == "Alex (uploaded)"
    assert twin.goals == on_file.goals


@pytest.mark.parametrize("content, reason", [(None, "Cannot read"), ("{}", "not a FinancialTwin")])
def test_a_bad_twin_file_fails_clearly(tmp_path, capsys, content, reason):
    path = tmp_path / "twin_on_file.json"
    if content is not None:
        path.write_text(content)
    code, twin = run(tmp_path, "--twin", str(path))
    assert code == 1
    assert twin is None
    assert reason.lower() in capsys.readouterr().err.lower()


def test_the_cli_entry_point_fails_the_process(tmp_path, monkeypatch):
    missing = tmp_path / "missing.json"
    out = tmp_path / "twin.json"
    monkeypatch.setattr("sys.argv", ["twin-build-job", "--transactions", str(missing), "--out", str(out)])
    with pytest.raises(SystemExit) as exit_info:
        build_job.cli()
    assert exit_info.value.code == 1


# --- The Databricks bundle ----------------------------------------------------


def bundle_task() -> dict:
    bundle = yaml.safe_load((BACKEND_DIR / "databricks.yml").read_text())
    (task,) = bundle["resources"]["jobs"]["twin_build"]["tasks"]
    return task["python_wheel_task"]


def test_the_bundle_entry_point_is_the_build_job_cli():
    scripts = tomllib.loads((BACKEND_DIR / "pyproject.toml").read_text())["project"]["scripts"]
    task = bundle_task()
    assert task["package_name"] == "backend"
    assert scripts[task["entry_point"]] == "backend.build_job:cli"


def test_the_bundle_parameters_are_ones_the_job_accepts():
    params = [p.replace("${var.volume}", "/Volumes/v") for p in bundle_task()["parameters"]]
    args = build_job.arg_parser().parse_args(params)
    assert args.twin is not None, "an installed wheel has no fixture twin to fall back on"


# --- Declared one-time obligations across a rebuild --------------------------------

TUITION = OneTimeObligation(
    id="one_tuition",
    name="Spring tuition",
    amount=1200,
    due_date=date(2027, 1, 15),
    account_id="acc_checking",
)


def test_a_rebuild_keeps_a_confirmed_obligation(tmp_path):
    """The critical case: these are declared, so recomputing must not wipe them."""
    twin_file = tmp_path / "twin-on-file.json"
    owed = load_twin().model_copy(update={"one_time_obligations": [TUITION]})
    twin_file.write_text(owed.model_dump_json())

    _, rebuilt = run(tmp_path, "--twin", str(twin_file))

    assert rebuilt.one_time_obligations == [TUITION]


def test_a_rebuild_never_invents_an_obligation_from_transactions(tmp_path):
    """A year of rent and tuition-sized transfers must still produce none of these."""
    _, rebuilt = run(tmp_path)
    assert rebuilt.one_time_obligations == []
    # The detector found plenty of *recurring* structure from the same history.
    assert rebuilt.obligations


def test_an_obligation_whose_account_is_gone_is_kept_not_dropped(tmp_path):
    """C3, undefined in the spec. The money is still owed.

    Dropping it would quietly flatter the forecast; the simulator falls back to
    checking, and PUT /twin/{id}/goals refuses to accept a new one like this.
    """
    twin_file = tmp_path / "twin-on-file.json"
    dangling = TUITION.model_copy(update={"account_id": "acc_closed"})
    owed = load_twin().model_copy(update={"one_time_obligations": [dangling]})
    twin_file.write_text(owed.model_dump_json())

    _, rebuilt = run(tmp_path, "--twin", str(twin_file))

    assert rebuilt.one_time_obligations == [dangling]
