"""Minimal OTP isochrone client for the batch grid driver.

Talks to a reachable OTP instance (via an ssh-tunnel to the box container in dev,
or the internal container URL in prod). Tries the TravelTime sandbox endpoint first,
then the LegacyRestApi isochrone endpoint. Returns a shapely geometry (the reachable
polygon) or raises. NEVER fabricates geometry.
"""
from __future__ import annotations

import httpx
from shapely.geometry import shape
from shapely.ops import unary_union

DEFAULT_TZ = "-04:00"  # America/New_York EDT (summer schedule anchor)


class OTPError(RuntimeError):
    pass


def _parse_fc(gj: dict):
    if not isinstance(gj, dict) or "features" not in gj or not gj["features"]:
        raise OTPError("empty or non-GeoJSON isochrone response")
    geoms = [shape(f["geometry"]) for f in gj["features"] if f.get("geometry")]
    if not geoms:
        raise OTPError("no geometries in isochrone response")
    g = unary_union(geoms)
    if g.is_empty:
        raise OTPError("empty isochrone geometry")
    return g


def fetch_isochrone(
    base_url: str,
    lat: float,
    lon: float,
    minutes: int,
    depart_date: str,
    depart_hhmm: str,
    *,
    walk_speed: float = 1.33,
    timeout: float = 30.0,
    tz: str = DEFAULT_TZ,
):
    """Return a shapely (Multi)Polygon of the reachable area. Raises OTPError on failure."""
    base = base_url.rstrip("/")
    secs = minutes * 60

    # 1) TravelTime sandbox endpoint (OTP 2.x ext.traveltime).
    tt_url = f"{base}/otp/traveltime/isochrone"
    tt_params = {
        "location": f"{lat},{lon}",
        "time": f"{depart_date}T{depart_hhmm}:00{tz}",
        "modes": "WALK,TRANSIT",
        "arriveBy": "false",
        "cutoff": f"{minutes}m",
        "walkSpeed": walk_speed,
    }
    try:
        r = httpx.get(tt_url, params=tt_params, timeout=timeout)
        if r.status_code == 200 and r.headers.get("content-type", "").startswith(
            ("application/json", "application/geo")
        ):
            return _parse_fc(r.json())
    except Exception:
        pass

    # 2) LegacyRestApi isochrone endpoint (OTP1-style, restored via LegacyRestApi).
    lg_url = f"{base}/otp/routers/default/isochrone"
    lg_params = {
        "fromPlace": f"{lat},{lon}",
        "mode": "WALK,TRANSIT",
        "date": depart_date,
        "time": depart_hhmm,
        "cutoffSec": secs,
        "walkSpeed": walk_speed,
        "arriveBy": "false",
    }
    try:
        r = httpx.get(lg_url, params=lg_params, timeout=timeout)
    except Exception as e:
        raise OTPError(f"OTP unreachable: {e}") from e
    if r.status_code != 200:
        raise OTPError(f"OTP isochrone HTTP {r.status_code}: {r.text[:200]}")
    return _parse_fc(r.json())
