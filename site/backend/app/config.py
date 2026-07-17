"""Runtime configuration for the nycvisualizer backend.

All paths and keys come from the environment / a .env file — NEVER hardcoded.
Defaults are resolved RELATIVE to this file's location so the app is portable
(no absolute workspace paths in committed source). The platform root is the
NYCPlatform directory: app/ -> backend/ -> site/ -> NYCPlatform/.
"""
from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - dotenv optional
    load_dotenv = None  # type: ignore

# app/ -> backend/ -> site/ -> NYCPlatform/
PLATFORM_ROOT = Path(__file__).resolve().parents[3]

# Load .env from the platform root (holds server-side keys), then any process env wins.
if load_dotenv is not None:
    env_path = os.environ.get("NYCV_ENV_FILE", str(PLATFORM_ROOT / ".env"))
    if Path(env_path).exists():
        load_dotenv(env_path, override=False)


def _path_env(name: str, default: Path) -> Path:
    v = os.environ.get(name)
    return Path(v) if v else default


# Data + realtime roots (relative-by-default; overridable via env for any deploy).
DATA_ROOT: Path = _path_env("DATA_ROOT", PLATFORM_ROOT / "data")
REALTIME_ARCHIVE: Path = _path_env("REALTIME_ARCHIVE", PLATFORM_ROOT / "realtime" / "archive")
GTFS_STATIC_ROOT: Path = _path_env(
    "GTFS_STATIC_ROOT", DATA_ROOT / "raw" / "transit_static"
)

# Server-side credentials — never sent to the client.
MTA_BUSTIME_KEY: str = os.environ.get("MTA_BUSTIME_KEY", "")

# CORS: the Vite dev origin(s). Comma-separated env override.
CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
).split(",")

# Realtime freshness / rate discipline.
STALE_AFTER_S = int(os.environ.get("NYCV_STALE_AFTER_S", "300"))  # archive stale threshold
LIVE_CACHE_TTL_S = int(os.environ.get("NYCV_LIVE_CACHE_TTL_S", "31"))  # BusTime 30s floor
SSE_INTERVAL_S = int(os.environ.get("NYCV_SSE_INTERVAL_S", "30"))

# GTFS-RT / SIRI endpoints (BusTime).
GTFSRT_VEHICLES_URL = "https://gtfsrt.prod.obanyc.com/vehiclePositions"
GTFSRT_ALERTS_URL = "https://gtfsrt.prod.obanyc.com/alerts"
SIRI_STOP_MONITORING_URL = "https://bustime.mta.info/api/siri/stop-monitoring.json"
