"""Runtime capacity guards (F3): RT payload TTL cache, viewport bbox filter, and a
concurrent-SSE ceiling. All state is in-process (per uvicorn worker).

Why these exist: the RT poll endpoints re-read parquet/GTFS-RT via duckdb on every
request (no shared connection), so origin CPU scaled ~linearly with concurrent users
and p95 crossed 5 s below 50 users. The TTL single-flight cache collapses that to one
recompute per TTL regardless of load; bbox trims payload for immersive viewports; the
SSE limiter keeps long-lived streams from exhausting the worker.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Optional

from . import config


class TTLCache:
    """Single-flight, time-based cache for one expensive synchronous producer.

    Concurrent callers during a miss await a SINGLE recompute (no thundering herd):
    the underlying fn runs at most once per ``ttl`` seconds no matter how many
    requests arrive, making origin work O(1) in concurrent users.
    """

    def __init__(self, fn: Callable[[], Any], ttl: float) -> None:
        self._fn = fn
        self._ttl = ttl
        self._ts = 0.0
        self._data: Any = None
        self._lock = asyncio.Lock()

    async def get(self) -> Any:
        now = time.time()
        data = self._data
        if data is not None and (now - self._ts) < self._ttl:
            return data
        async with self._lock:
            # Re-check under the lock: a concurrent caller may have refreshed it.
            now = time.time()
            if self._data is not None and (now - self._ts) < self._ttl:
                return self._data
            fresh = await asyncio.to_thread(self._fn)
            self._data = fresh
            self._ts = now
            return fresh


BBox = tuple[float, float, float, float]  # (min_lon, min_lat, max_lon, max_lat)


def parse_bbox(raw: Optional[str]) -> Optional[BBox]:
    """Parse a ``?bbox=minLon,minLat,maxLon,maxLat`` string.

    Returns None if absent or malformed (caller then serves the full payload) — the
    filter is strictly additive, so a bad bbox never breaks a client.
    """
    if not raw:
        return None
    parts = raw.split(",")
    if len(parts) != 4:
        return None
    try:
        min_lon, min_lat, max_lon, max_lat = (float(p) for p in parts)
    except ValueError:
        return None
    if min_lon > max_lon or min_lat > max_lat:
        return None
    return (min_lon, min_lat, max_lon, max_lat)


def filter_bbox(payload: dict[str, Any], list_key: str, bbox: Optional[BBox]) -> dict[str, Any]:
    """Return a shallow copy of ``payload`` with ``list_key`` clipped to ``bbox``.

    The cached payload is NEVER mutated (a shared object). Items lacking lat/lon are
    dropped (treated as out of viewport). ``count`` is recomputed and a
    ``bbox_filtered`` flag is set so the client/meta can see the payload is partial.
    """
    if bbox is None:
        return payload
    min_lon, min_lat, max_lon, max_lat = bbox
    items = payload.get(list_key) or []
    kept = [
        it
        for it in items
        if it.get("lat") is not None
        and it.get("lon") is not None
        and min_lat <= it["lat"] <= max_lat
        and min_lon <= it["lon"] <= max_lon
    ]
    out = dict(payload)
    out[list_key] = kept
    out["count"] = len(kept)
    out["bbox_filtered"] = True
    return out


class SSELimiter:
    """Per-worker concurrent-SSE ceiling.

    ``try_acquire`` and ``release`` bracket a stream's lifetime; the check and the
    increment are not separated by an ``await`` so the single-threaded event loop needs
    no lock. Over cap, the caller returns 429 + Retry-After and the client falls back
    to the (edge-cached) poll path.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.active = 0

    def try_acquire(self) -> bool:
        if self.active >= self.limit:
            return False
        self.active += 1
        return True

    def release(self) -> None:
        if self.active > 0:
            self.active -= 1


# Shared per-worker SSE ceiling across all stream endpoints (vehicles, subway, wall).
sse_limiter = SSELimiter(config.SSE_MAX)
