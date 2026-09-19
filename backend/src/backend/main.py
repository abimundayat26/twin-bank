"""TwinBank API. Phase 1: /twin and /simulate return mock fixtures."""

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.fixtures import load_simulation, load_twin
from backend.schemas import FinancialTwin, SimulationRequest, SimulationResponse

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


@app.get("/twin/{user_id}", response_model=FinancialTwin)
def get_twin(user_id: str) -> FinancialTwin:
    twin = load_twin()
    if user_id != twin.user_id:
        raise HTTPException(status_code=404, detail=f"No twin for user '{user_id}'")
    return twin


@app.post("/simulate", response_model=SimulationResponse)
def simulate(request: SimulationRequest) -> SimulationResponse:
    # Phase 1: request is validated but the result is a fixed mock.
    if request.user_id != load_twin().user_id:
        raise HTTPException(status_code=404, detail=f"No twin for user '{request.user_id}'")
    return load_simulation()
