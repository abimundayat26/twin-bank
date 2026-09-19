"""In-memory store of recent simulation results, so GET /explain/{simulation_id} can
return them again.

Results live in process memory and reset when the server restarts, like twin_store.
Only the newest MAX_STORED are kept. Nothing here calculates money.
"""

from collections import OrderedDict

from backend.schemas import SimulationResponse

MAX_STORED = 100

simulations: OrderedDict[str, SimulationResponse] = OrderedDict()


def save(response: SimulationResponse) -> None:
    simulations[response.simulation_id] = response
    simulations.move_to_end(response.simulation_id)
    while len(simulations) > MAX_STORED:
        simulations.popitem(last=False)


def get(simulation_id: str) -> SimulationResponse | None:
    return simulations.get(simulation_id)


def reset() -> None:
    simulations.clear()
