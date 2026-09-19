"""TwinBank API. /twin returns the mock fixture plus the user's answers; /simulate runs the Monte Carlo simulation."""

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend import twin_store
from backend.schemas import (
    ClarificationResponseRequest,
    FinancialTwin,
    MinimumBalanceRequest,
    OptimizationRequest,
    OptimizationResponse,
    SimulationRequest,
    SimulationResponse,
)
from backend.simulation import SimulationError, run_simulation
from backend.simulation.optimize import run_optimization

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


@app.post("/optimize", response_model=OptimizationResponse)
def optimize(request: OptimizationRequest) -> OptimizationResponse:
    twin = twin_for(request.user_id)
    try:
        return run_optimization(twin, request, seed=SIMULATION_SEED)
    except SimulationError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
