"""Transit isochrone API — thin, honest proxy over OTP's TravelTime sandbox.

The browser calls `/api/isochrone?lat&lon&minutes=30|45|60&depart=weekday_8am|noon|evening`;
this backend snaps the origin to an H3 res-9 cell (so nearby requests share a cache
entry), asks the internal OTP instance for a WALK+TRANSIT travel-time isochrone, and
returns GeoJSON polygons.

Honesty contract: if OTP is unreachable or errors, we return HTTP 503 with a plain
message — we NEVER synthesize or interpolate a polygon. A cached-then-cold two-tier
cache (in-process LRU + on-disk JSON) keeps repeat/precomputed origins fast.
"""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from datetime import date, timedelta
from typing import Any

import httpx

from . import config

# In-process LRU over the on-disk cache. Values are the parsed GeoJSON dicts.
_MEM_LRU: "OrderedDict[str, dict]" = OrderedDict()
_MEM_LRU_MAX = 512


class OTPUnavailable(RuntimeError):
    """Raised when OTP cannot be reached or returns an error — surfaced as 503."""


def _depart_date() -> str:
    """The weekday date isochrones are anchored to (YYYY-MM-DD)."""
    if config.ISOCHRONE_DEPART_DATE:
        return config.ISOCHRONE_DEPART_DATE
    d = date.today()
    # Advance to the next weekday (skip Sat/Sun) so the schedule is a service day.
    d = d + timedelta(days=1)
    while d.weekday() >= 5:  # 5=Sat, 6=Sun
        d = d + timedelta(days=1)
    return d.isoformat()


def _iso_time(depart: str) -> str:
    hhmmss = config.ISOCHRONE_DEPART_TIMES.get(depart)
    if hhmmss is None:
        raise ValueError(f"unknown depart window: {depart!r}")
    return f"{_depart_date()}T{hhmmss}{config.ISOCHRONE_TZ_OFFSET}"


def snap_h3(lat: float, lon: float, res: int = 9) -> str:
    """Snap an origin to an H3 cell so nearby requests hit the same cache key."""
    import h3

    return h3.latlng_to_cell(lat, lon, res)


def _cache_key(h3_cell: str, minutes: int, depart: str) -> str:
    raw = f"{h3_cell}|{minutes}|{depart}|{_depart_date()}"
    return hashlib.sha1(raw.encode()).hexdigest()


def _disk_path(key: str):
    return config.ISOCHRONE_CACHE_DIR / f"{key}.json"


def _cache_get(key: str) -> dict | None:
    if key in _MEM_LRU:
        _MEM_LRU.move_to_end(key)
        return _MEM_LRU[key]
    p = _disk_path(key)
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
        _mem_put(key, data)
        return data
    return None


def _mem_put(key: str, data: dict) -> None:
    _MEM_LRU[key] = data
    _MEM_LRU.move_to_end(key)
    while len(_MEM_LRU) > _MEM_LRU_MAX:
        _MEM_LRU.popitem(last=False)


def _cache_put(key: str, data: dict) -> None:
    _mem_put(key, data)
    try:
        config.ISOCHRONE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _disk_path(key).write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass  # cache is best-effort; never fail the request on a write error


def _fetch_otp(lat: float, lon: float, minutes: int, depart: str) -> dict:
    """Call OTP's TravelTime isochrone endpoint. Raises OTPUnavailable on any failure."""
    url = f"{config.OTP_URL}/otp/traveltime/isochrone"
    params = {
        "location": f"{lat},{lon}",
        "time": _iso_time(depart),
        "modes": "WALK,TRANSIT",
        "arriveBy": "false",
        "cutoff": f"{minutes}m",
    }
    try:
        r = httpx.get(url, params=params, timeout=config.OTP_TIMEOUT_S)
    except Exception as e:  # connection refused, DNS, timeout
        raise OTPUnavailable(f"OTP unreachable at {config.OTP_URL}: {e}") from e
    if r.status_code != 200:
        raise OTPUnavailable(f"OTP returned HTTP {r.status_code}")
    try:
        gj = r.json()
    except Exception as e:
        raise OTPUnavailable(f"OTP returned non-JSON: {e}") from e
    if not isinstance(gj, dict) or gj.get("type") != "FeatureCollection":
        raise OTPUnavailable("OTP returned an unexpected payload (not GeoJSON)")
    return gj


def get_isochrone(lat: float, lon: float, minutes: int, depart: str) -> dict:
    """Return a GeoJSON FeatureCollection isochrone. Cached on snapped origin+params.

    Raises OTPUnavailable if OTP cannot serve it (caller maps to 503).
    Raises ValueError on bad params (caller maps to 400).
    """
    if depart not in config.ISOCHRONE_DEPART_TIMES:
        raise ValueError(f"depart must be one of {list(config.ISOCHRONE_DEPART_TIMES)}")
    if minutes not in (30, 45, 60):
        raise ValueError("minutes must be 30, 45, or 60")
    if not (40.3 <= lat <= 41.0 and -74.4 <= lon <= -73.6):
        raise ValueError("origin outside the NYC service area")

    cell = snap_h3(lat, lon, 9)
    key = _cache_key(cell, minutes, depart)
    cached = _cache_get(key)
    if cached is not None:
        out = dict(cached)
        out.setdefault("_meta", {})["cache"] = "hit"
        return out

    # Snap query point to the H3 cell centroid so all cache-sharing origins agree.
    import h3

    clat, clon = h3.cell_to_latlng(cell)
    gj = _fetch_otp(clat, clon, minutes, depart)
    gj["_meta"] = {
        "origin_snapped_h3_9": cell,
        "origin_lat": clat,
        "origin_lon": clon,
        "minutes": minutes,
        "depart": depart,
        "depart_datetime": _iso_time(depart),
        "modes": "WALK,TRANSIT",
        "engine": "OpenTripPlanner",
        "cache": "miss",
    }
    _cache_put(key, gj)
    return gj
