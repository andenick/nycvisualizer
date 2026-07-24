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

# --- Bus Observatory (S5) data roots ---------------------------------------
# derive2 outputs (hourly-refreshed) + its GTFS static cache, both under the platform root.
DERIVED_ROOT: Path = _path_env("NYCV_DERIVED_ROOT", PLATFORM_ROOT / "realtime" / "derived")
DERIVE2_CACHE: Path = _path_env(
    "NYCV_DERIVE2_CACHE", PLATFORM_ROOT / "realtime" / "derive2" / "cache"
)
# Analysis outputs tree:  Jane/Outputs/NYCPlatform/  (two levels up from the platform root).
NYC_OUTPUTS_ROOT: Path = _path_env(
    "NYCV_OUTPUTS_ROOT", PLATFORM_ROOT.parents[1] / "Outputs" / "NYCPlatform"
)
BUS_OUTPUTS_DIR: Path = _path_env("NYCV_BUS_OUTPUTS", NYC_OUTPUTS_ROOT / "bus")
OBS_PRECOMPUTE_DIR: Path = _path_env("NYCV_OBS_PRECOMPUTE", BUS_OUTPUTS_DIR / "obs")
SAI_DIR: Path = _path_env("NYCV_SAI_DIR", NYC_OUTPUTS_ROOT / "sai")
# NYC is EDT (UTC-4) for the whole archive window (no DST transition inside it).
NYC_UTC_OFFSET_S = int(os.environ.get("NYCV_UTC_OFFSET_S", "-14400"))

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

# --- Capacity guards (F3) --------------------------------------------------
# In-process TTL cache on the RT poll payloads (/api/rt/vehicles, /api/rt/subway):
# the expensive duckdb/parquet read runs at most once per TTL regardless of how
# many users are polling -> origin cost is O(1) in concurrent users. Matched to
# the Cache-Control s-maxage the endpoints emit so on-box freshness == edge freshness.
RT_CACHE_TTL_S = int(os.environ.get("NYCV_RT_CACHE_TTL_S", "10"))
# Concurrent-SSE ceiling (PER WORKER). Over cap -> 429 + Retry-After; clients fall
# back to the (edge-cached) poll path. With uvicorn --workers N the effective total
# ceiling is N * SSE_MAX (each worker counts only its own streams).
SSE_MAX = int(os.environ.get("NYCV_SSE_MAX", "200"))

# GTFS-RT / SIRI endpoints (BusTime).
GTFSRT_VEHICLES_URL = "https://gtfsrt.prod.obanyc.com/vehiclePositions"
GTFSRT_ALERTS_URL = "https://gtfsrt.prod.obanyc.com/alerts"
SIRI_STOP_MONITORING_URL = "https://bustime.mta.info/api/siri/stop-monitoring.json"

# ---------------------------------------------------------------------------
# OTP routing engine (isochrones).  The browser NEVER talks to OTP directly;
# only this backend does, over the internal docker network.  In production
# OTP_URL points at the `nycvis-otp` container on homelab_default; for local
# dev it is an ssh-tunnel to the box (e.g. http://localhost:8080) or absent.
# If OTP is unreachable the isochrone endpoint returns 503 (never fake polygons).
OTP_URL: str = os.environ.get("OTP_URL", "http://nycvis-otp:8080").rstrip("/")
OTP_TIMEOUT_S: float = float(os.environ.get("OTP_TIMEOUT_S", "20"))

# Departure-time windows for isochrones. Anchored to the next weekday within the
# GTFS service span (overridable so the anchor can be moved when feeds roll over).
ISOCHRONE_DEPART_DATE: str = os.environ.get("ISOCHRONE_DEPART_DATE", "")  # "" -> next weekday
ISOCHRONE_TZ_OFFSET: str = os.environ.get("ISOCHRONE_TZ_OFFSET", "-04:00")  # America/New_York (EDT)
ISOCHRONE_DEPART_TIMES = {
    "weekday_8am": "08:00:00",
    "noon": "12:00:00",
    "evening": "18:00:00",
}
ISOCHRONE_CACHE_DIR: Path = _path_env(
    "ISOCHRONE_CACHE_DIR", DATA_ROOT / "cache" / "isochrone"
)

# ---------------------------------------------------------------------------
# Renter's Map (S7).  A precomputed per-H3-res-10-cell grid + per-BBL building
# aggregates (analysis/renters/build_renters_grid.py) plus live PLUTO / subway /
# SAI-bus-stop lookups against the geo DB, and the GeoSearch geocoder for
# address -> coordinates + BBL.  The browser never talks to any of these directly.
# ---------------------------------------------------------------------------
JANE_GEO_DB: Path = _path_env("NYCV_GEO_DB", PLATFORM_ROOT / "db" / "jane_geo.duckdb")
RENTERS_OUTPUTS_DIR: Path = _path_env("NYCV_RENTERS_DIR", NYC_OUTPUTS_ROOT / "renters")
RENTERS_GRID: Path = _path_env("NYCV_RENTERS_GRID", RENTERS_OUTPUTS_DIR / "renters_grid.parquet")
RENTERS_HPD_BBL: Path = _path_env(
    "NYCV_RENTERS_HPD_BBL", RENTERS_OUTPUTS_DIR / "hpd_open_violations_by_bbl.parquet"
)
RENTERS_DOB_BBL: Path = _path_env(
    "NYCV_RENTERS_DOB_BBL", RENTERS_OUTPUTS_DIR / "dob_permits_5y_by_bbl.parquet"
)
RENTERS_LANDLORD_BBL: Path = _path_env(
    "NYCV_RENTERS_LANDLORD_BBL", RENTERS_OUTPUTS_DIR / "landlord_portfolio_by_bbl.parquet"
)
# SAI bus-stop scores parquet (already used by obs; re-exposed for the profile detail).
RENTERS_SAI: Path = _path_env("NYCV_RENTERS_SAI", SAI_DIR / "sai_scores.parquet")
# res-8 45-min job-access isochrone grid — source of the approximate-polygon fallback.
RENTERS_ISO_GRID: Path = _path_env(
    "NYCV_RENTERS_ISO_GRID", PLATFORM_ROOT / "analysis" / "access" / "isochrone_grid_45min.parquet"
)
# Keyless CityGeocoder (GeoSearch) — returns BBL + BIN that join to PLUTO/HPD/DOB.
GEOSEARCH_URL: str = os.environ.get(
    "NYCV_GEOSEARCH_URL", "https://geosearch.planninglabs.nyc/v2/search"
)
GEOSEARCH_TIMEOUT_S: float = float(os.environ.get("NYCV_GEOSEARCH_TIMEOUT_S", "8"))
# Nearest-building search radius (feet, EPSG:2263) and cap.
RENTERS_BUILDING_RADIUS_FT: float = float(os.environ.get("NYCV_RENTERS_BLDG_RADIUS_FT", "246"))  # 75 m
RENTERS_STOP_RADIUS_FT: float = float(os.environ.get("NYCV_RENTERS_STOP_RADIUS_FT", "1312"))  # 400 m
