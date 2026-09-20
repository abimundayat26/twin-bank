"""TwinBank API. /twin returns the mock fixture plus the user's answers; /simulate runs the Monte Carlo simulation
and /explain/{simulation_id} returns a recent simulation again."""

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend import simulation_store
from backend import twin_store
from backend.fixtures import load_raw_transactions
from backend.ingest.build import latest_transaction_date, rebuild
from backend.ingest.normalize import normalize_all
from backend.llm_goal_compiler import compile_goals_auto
from backend.schemas import (
    ClarificationResponseRequest,
    DeclaredGoalsRequest,
    FinancialTwin,
    GoalCompileRequest,
    GoalCompileResponse,
    MinimumBalanceRequest,
    OptimizationRequest,
    OptimizationResponse,
    SimulationRequest,
    SimulationResponse,
    TwinBuildRequest,
)
from backend.simulation import SimulationError, run_simulation
from backend.simulation.optimize import run_optimization
from backend.tracking import log_twin_build

# Optional: fix the Monte Carlo seed so demo numbers repeat. Unset means fresh randomness.
SIMULATION_SEED = int(seed) if (seed := os.getenv("SIMULATION_SEED")) else None

app = FastAPI(title="TwinBank API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def twin_for(user_id: str) -> FinancialTwin:
    twin = twin_store.get_twin()
    if user_id != twin.user_id:
        raise HTTPException(status_code=404, detail=f"No twin for user '{user_id}'")
    return twin


@app.get("/twin/{user_id}", response_model=FinancialTwin)
def get_twin(user_id: str) -> FinancialTwin:
    return twin_for(user_id)


@app.post("/twin/build", response_model=FinancialTwin)
def build_twin(request: TwinBuildRequest) -> FinancialTwin:
    """Rebuild a twin's observed structure from the user's transaction history.

    The result is returned, not stored: `GET /twin/{user_id}` keeps serving the
    twin on file, so a detector that reads the history differently cannot break
    the demo.

    **Intentionally backend-only. There is no UI entry point, and that is a
    decision rather than an omission.**

    `SPEC.md` section 9 notes this is the one endpoint the frontend does not use.
    It stays that way because of the line above: a build returns a twin and
    changes nothing. A "Rebuild" control would therefore either show the user a
    twin the app is not using, or look like it refreshed something when it did
    not, and `frontend/SPEC.md` section 3.5 rules that out directly -- refresh or
    rebuild controls "may be added only after the backend exposes an
    authenticated, well-defined operation", and until then the page "must not
    simulate a refresh in local frontend state". This operation is neither
    authenticated nor persistent.

    What it is for is the pipeline: it is how `backend.ingest` is exercised over
    real input, how a build gets logged to MLflow, and the seam the Databricks
    job and the Nessie path build through. `README.md` shows the curl.

    Giving it a UI needs two things first: somewhere for the result to go, and
    something deciding who may ask for it. Until both exist, wiring it up would
    be dishonest rather than merely premature.
    """
    twin = twin_for(request.user_id)
    # The seam Phase 3 replaces: the same transactions, fetched from Nessie.
    transactions = normalize_all(load_raw_transactions())
    as_of = request.as_of or latest_transaction_date(transactions)
    if as_of is None:
        raise HTTPException(
            status_code=422, detail=f"No transaction history for user '{request.user_id}'"
        )
    if request.accounts is not None:
        twin = twin.model_copy(update={"accounts": request.accounts})
    # A twin as of a past date must not see what happened after it.
    built = rebuild(twin, [t for t in transactions if t.date <= as_of], as_of)
    # The observed builder must not infer declarations. Reapply every confirmed
    # answer from twin_store; compiler drafts never reach this point (PER-9).
    built = twin_store.apply_answers(built)
    log_twin_build(built)
    return built


@app.put("/twin/{user_id}/minimum-balance", response_model=FinancialTwin)
def set_minimum_balance(user_id: str, request: MinimumBalanceRequest) -> FinancialTwin:
    twin_for(user_id)
    return twin_store.set_minimum_checking_balance(request.amount)


@app.post("/clarifications/respond", response_model=FinancialTwin)
def respond_to_clarification(request: ClarificationResponseRequest) -> FinancialTwin:
    twin_for(request.user_id)
    try:
        return twin_store.declare_category(request.obligation_id, request.category)
    except twin_store.UnknownObligation as e:
        raise HTTPException(
            status_code=422, detail=f"Unknown obligation_id '{request.obligation_id}'"
        ) from e


@app.post("/simulate", response_model=SimulationResponse)
def simulate(request: SimulationRequest) -> SimulationResponse:
    twin = twin_for(request.user_id)
    try:
        response = run_simulation(twin, request, seed=SIMULATION_SEED)
    except SimulationError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    simulation_store.save(response)
    return response


@app.get("/explain/{simulation_id}", response_model=SimulationResponse)
def explain(simulation_id: str) -> SimulationResponse:
    """The stored result of a recent /simulate call, explanation included."""
    response = simulation_store.get(simulation_id)
    if response is None:
        raise HTTPException(
            status_code=404, detail=f"Unknown or expired simulation_id '{simulation_id}'"
        )
    return response


@app.post("/optimize", response_model=OptimizationResponse)
def optimize(request: OptimizationRequest) -> OptimizationResponse:
    twin = twin_for(request.user_id)
    try:
        return run_optimization(twin, request, seed=SIMULATION_SEED)
    except SimulationError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.post("/goals/compile", response_model=GoalCompileResponse)
def compile_goal_text(request: GoalCompileRequest) -> GoalCompileResponse:
    """Drafts only. Saving them is a separate PUT /twin/{user_id}/goals, after the user confirms."""
    twin = twin_for(request.user_id)
    return compile_goals_auto(
        twin.user_id,
        request.text,
        twin.as_of,
        accounts=twin.accounts,
        detected=twin.obligations,
    )


@app.put("/twin/{user_id}/goals", response_model=FinancialTwin)
def set_goals(user_id: str, request: DeclaredGoalsRequest) -> FinancialTwin:
    twin_for(user_id)
    try:
        return twin_store.set_goals(
            request.goals, request.constraints, request.one_time_obligations
        )
    except twin_store.InvalidDeclaration as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
