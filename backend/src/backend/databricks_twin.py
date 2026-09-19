"""Read back the twin the Databricks build job wrote.

The Databricks job (`backend.build_job`, deployed by `databricks.yml`) writes a
built twin to a Unity Catalog volume. This module fetches that file over the
Databricks Files API so `twin_source` can serve it. It is the edge of the
system, like the Nessie client: it speaks HTTP and validates the shape, and
does no money maths.

Off unless asked for. It needs `USE_MOCKS=false` and all three of
`DATABRICKS_TWIN_PATH`, `DATABRICKS_HOST` and `DATABRICKS_TOKEN`; anything less
means not configured, and the fixtures stay in charge. Env is read inside
functions, never at import time, as in `nessie.config`.

The token never appears in an error message.
"""

import os
from dataclasses import dataclass

import httpx
from pydantic import ValidationError

from backend.nessie.config import use_mocks
from backend.schemas import FinancialTwin

DEFAULT_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class DatabricksConfig:
    host: str
    token: str
    twin_path: str
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS


class DatabricksError(RuntimeError):
    """The twin could not be fetched, or what came back is not a twin."""


def load_config() -> DatabricksConfig | None:
    """The configured reader, or None when Databricks is not set up (the normal case)."""
    if use_mocks():
        return None
    host = (os.getenv("DATABRICKS_HOST") or "").strip().rstrip("/")
    token = (os.getenv("DATABRICKS_TOKEN") or "").strip()
    twin_path = (os.getenv("DATABRICKS_TWIN_PATH") or "").strip()
    if not (host and token and twin_path):
        return None
    if not host.startswith("https://"):
        host = f"https://{host}"
    return DatabricksConfig(host=host, token=token, twin_path=twin_path)


def redact(text: str, token: str) -> str:
    return text.replace(token, "***") if token else text


def fetch_twin(config: DatabricksConfig, transport: httpx.BaseTransport | None = None) -> FinancialTwin:
    """Download the twin file from the volume and validate it."""
    url = f"{config.host}/api/2.0/fs/files/{config.twin_path.lstrip('/')}"
    try:
        with httpx.Client(timeout=config.timeout_seconds, transport=transport) as client:
            response = client.get(url, headers={"Authorization": f"Bearer {config.token}"})
    except httpx.HTTPError as e:
        raise DatabricksError(
            f"Could not reach Databricks for {config.twin_path}: {redact(str(e), config.token)}"
        ) from e
    if response.status_code >= 400:
        raise DatabricksError(f"Databricks returned {response.status_code} for {config.twin_path}")
    try:
        return FinancialTwin.model_validate_json(response.content)
    except ValidationError as e:
        raise DatabricksError(f"{config.twin_path} is not a FinancialTwin: {e}") from e
