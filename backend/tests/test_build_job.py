"""The batch twin build: the same twin as POST /twin/build, from a file."""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from backend import build_job
from backend.fixtures import FIXTURES_DIR
from backend.main import app
from backend.schemas import FinancialTwin

TRANSACTIONS = FIXTURES_DIR / "transactions.json"


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
