"""TwinBank API. /twin returns the mock fixture plus the user's answers; /simulate runs the Monte Carlo simulation."""

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend import twin_store
from backend.fixtures import load_raw_transactions
from backend.ingest.build import latest_transaction_date, rebuild
from backend.ingest.normalize import normalize_all
from backend.schemas import (
    ClarificationResponseRequest,
    FinancialTwin,
    MinimumBalanceRequest,
    SimulationRequest,
    SimulationResponse,
    TwinBuildRequest,
)
from backend.simulation import SimulationError, run_simulation

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
    return rebuild(twin, transactions, as_of)


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
        return run_simulation(twin, request, seed=SIMULATION_SEED)
    except SimulationError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
