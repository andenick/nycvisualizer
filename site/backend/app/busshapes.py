"""Bus route -> shape LUT (built once at API startup, disk-cached by GTFS fingerprint).

The motion model (motion.py) projects each live bus's GPS position onto its route's
canonical shape to derive a `route_offset_ft` (distance travelled along the route). This
module builds, ONCE per GTFS-static vintage, the geometry that projection needs — mirroring
the subway stop-pair seg LUT pattern in subway.py (content-fingerprinted pickle under
DATA_ROOT/cache, rebuilt only when the feed changes):

  per (route_id, direction_id):
    * the canonical shape polyline (the most-detailed shape the route runs in that
      direction), decimated with a Ramer-Douglas-Peucker pass in EPSG:2263 FEET so the
      projection maths is planar and offsets are in feet (matching derive2's speed table)
    * cumulative FULL-shape offset (ft) carried on the kept vertices, so a projected
      `route_offset_ft` stays in the same space as derive2's `offset_ft` (its seg_bin keys
      line up) even though the polyline is decimated
    * a rounded lat/lon copy of the decimated polyline for a client that wants to draw the
      exact line the offset is measured against (/api/rt/route_shapes)

Route -> feed ownership is by trips.txt (a route is operated by exactly one bus feed;
verified 1:1), the same rule gtfs.py uses. NO absolute workspace paths — everything hangs
off config (public-repo hygiene).
"""
from __future__ import annotations

import hashlib
import math
import pickle
import time
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
from pyproj import Transformer

from . import config

# EPSG:2263 = NY State Plane Long Island (US survey feet) — planar ft math, as in derive2.
_TF = Transformer.from_crs("EPSG:4326", "EPSG:2263", always_xy=True)

BUS_GTFS_FEEDS = [
    "gtfs_bus_bronx",
    "gtfs_bus_brooklyn",
    "gtfs_bus_manhattan",
    "gtfs_bus_mta_bus_company",
    "gtfs_bus_queens",
    "gtfs_bus_staten_island",
]

RDP_TOLERANCE_FT = 15.0   # decimation tolerance — BusTime positions are shape-snapped, so
                          # 15 ft keeps projected offsets accurate to a few ft citywide.
MAX_SHAPE_VERTS = 400     # hard cap per polyline (keeps the per-request projection cheap)

_lut: dict[str, Any] | None = None


# --------------------------------------------------------------------------- geometry
def _rdp_mask(x: np.ndarray, y: np.ndarray, tol: float) -> np.ndarray:
    """Iterative Ramer-Douglas-Peucker; returns a boolean keep-mask over the input verts."""
    n = len(x)
    keep = np.zeros(n, dtype=bool)
    if n == 0:
        return keep
    keep[0] = keep[-1] = True
    if n <= 2:
        return keep
    stack = [(0, n - 1)]
    tol2 = tol * tol
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay, bx, by = x[a], y[a], x[b], y[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        px = x[a + 1:b] - ax
        py = y[a + 1:b] - ay
        if seg2 <= 0:
            d2 = px * px + py * py
        else:
            cross = px * dy - py * dx
            d2 = (cross * cross) / seg2
        k = int(np.argmax(d2))
        if d2[k] > tol2:
            idx = a + 1 + k
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return keep


def _decimate(latlon: list[tuple[float, float]]) -> dict[str, Any] | None:
    """lat/lon polyline -> decimated feet geometry + full-shape cumulative offsets."""
    if len(latlon) < 2:
        return None
    lat = np.array([p[0] for p in latlon], dtype=np.float64)
    lon = np.array([p[1] for p in latlon], dtype=np.float64)
    x, y = _TF.transform(lon, lat)
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    # full-shape cumulative distance (ft) at every original vertex
    seg = np.hypot(np.diff(x), np.diff(y))
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    shape_len = float(cum[-1])
    if shape_len <= 0:
        return None
    keep = _rdp_mask(x, y, RDP_TOLERANCE_FT)
    ki = np.flatnonzero(keep)
    if len(ki) > MAX_SHAPE_VERTS:  # uniform thin-out, always keep both endpoints
        sel = np.linspace(0, len(ki) - 1, MAX_SHAPE_VERTS).round().astype(int)
        ki = np.unique(ki[sel])
    fx, fy, fcum = x[ki], y[ki], cum[ki]
    # precompute per-segment geometry ONCE (removes per-projection setup at request time)
    x0 = fx[:-1]; y0 = fy[:-1]
    vx = fx[1:] - x0; vy = fy[1:] - y0
    vlen2 = vx * vx + vy * vy
    inv_vlen2 = 1.0 / np.where(vlen2 <= 0, 1e-9, vlen2)
    seg_arc = fcum[1:] - fcum[:-1]
    return {
        "fx": fx, "fy": fy, "cum": fcum, "shape_len_ft": shape_len,
        "x0": x0, "y0": y0, "vx": vx, "vy": vy, "inv_vlen2": inv_vlen2,
        "seg_arc": seg_arc, "cum0": fcum[:-1],
        "latlon": [[round(float(lat[i]), 5), round(float(lon[i]), 5)] for i in ki],
        "n_verts": int(len(ki)),
    }


def project(entry: dict[str, Any], px: np.ndarray, py: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Project points (feet arrays) onto a decimated shape entry.

    Returns (offset_ft, perp_ft) — nearest-point along-shape offset (in FULL-shape space via
    the carried cumulative offsets) and perpendicular distance. Vectorised M points x S segs,
    using the entry's precomputed per-segment geometry.
    """
    x0 = entry["x0"]; y0 = entry["y0"]; vx = entry["vx"]; vy = entry["vy"]
    inv_vlen2 = entry["inv_vlen2"]; seg_arc = entry["seg_arc"]; cum0 = entry["cum0"]
    # M x S
    dx = px[:, None] - x0[None, :]
    dy = py[:, None] - y0[None, :]
    t = (dx * vx[None, :] + dy * vy[None, :]) * inv_vlen2[None, :]
    np.clip(t, 0.0, 1.0, out=t)
    ex = dx - t * vx[None, :]      # residual to the projected point (reuses dx/dy)
    ey = dy - t * vy[None, :]
    d2 = ex * ex + ey * ey
    j = np.argmin(d2, axis=1)
    rows = np.arange(len(px))
    perp = np.sqrt(d2[rows, j])
    offset = cum0[j] + t[rows, j] * seg_arc[j]
    return offset, perp


# --------------------------------------------------------------------------- build
def _bus_gtfs_dir(feed: str) -> Path:
    return config.GTFS_STATIC_ROOT / feed / "gtfs"


def _fingerprint() -> str:
    """Content fingerprint over the bus feeds' small files + size/mtime of stop_times."""
    h = hashlib.sha256()
    for feed in BUS_GTFS_FEEDS:
        gdir = _bus_gtfs_dir(feed)
        for name in ("trips.txt", "shapes.txt", "routes.txt"):
            p = gdir / name
            h.update(f"{feed}/{name}".encode())
            h.update(p.read_bytes() if p.exists() else b"-")
    return h.hexdigest()[:16]


def _cache_path(fp: str) -> Path:
    return config.DATA_ROOT / "cache" / f"bus_shape_lut_{fp}.pkl"


def _build() -> dict[str, Any]:
    """Per (route_id, direction_id) canonical decimated shape from the 6 bus feeds."""
    shapes: dict[tuple[str, int], dict[str, Any]] = {}
    routes_seen: set[str] = set()
    con = duckdb.connect()
    try:
        for feed in BUS_GTFS_FEEDS:
            gdir = _bus_gtfs_dir(feed)
            trips_txt = (gdir / "trips.txt")
            shapes_txt = (gdir / "shapes.txt")
            if not trips_txt.exists() or not shapes_txt.exists():
                continue
            # (route, direction) -> the shape_id with the most points (most detailed variant)
            rows = con.execute(
                f"""
                WITH tr AS (
                    SELECT route_id, CAST(direction_id AS INTEGER) AS direction_id, shape_id
                    FROM read_csv_auto('{trips_txt.as_posix()}', header=true, all_varchar=true)
                    WHERE route_id IS NOT NULL AND shape_id IS NOT NULL AND shape_id <> ''
                ),
                sc AS (
                    SELECT shape_id, count(*) AS n
                    FROM read_csv_auto('{shapes_txt.as_posix()}', header=true, all_varchar=true)
                    GROUP BY shape_id
                )
                SELECT tr.route_id, tr.direction_id, tr.shape_id, sc.n
                FROM tr JOIN sc ON sc.shape_id = tr.shape_id
                """
            ).fetchall()
            best: dict[tuple[str, int], tuple[str, int]] = {}
            for route_id, direction_id, shape_id, n in rows:
                d = int(direction_id) if direction_id is not None else 0
                key = (route_id, d)
                cur = best.get(key)
                if cur is None or int(n) > cur[1]:
                    best[key] = (shape_id, int(n))
            # a route is owned by exactly one feed (verified 1:1) — skip if already built
            wanted = {k: v for k, v in best.items() if k[0] not in routes_seen}
            if not wanted:
                continue
            shape_ids = sorted({sid for sid, _ in wanted.values()})
            in_list = ",".join("'" + s.replace("'", "''") + "'" for s in shape_ids)
            pts = con.execute(
                f"""
                SELECT shape_id, CAST(TRIM(shape_pt_lat) AS DOUBLE) lat,
                       CAST(TRIM(shape_pt_lon) AS DOUBLE) lon
                FROM read_csv_auto('{shapes_txt.as_posix()}', header=true, all_varchar=true)
                WHERE shape_id IN ({in_list})
                ORDER BY shape_id, CAST(shape_pt_sequence AS BIGINT)
                """
            ).fetchall()
            by_shape: dict[str, list[tuple[float, float]]] = {}
            for sid, lat, lon in pts:
                if lat is not None and lon is not None:
                    by_shape.setdefault(sid, []).append((lat, lon))
            for (route_id, d), (shape_id, _n) in wanted.items():
                geom = _decimate(by_shape.get(shape_id, []))
                if geom is None:
                    continue
                geom["shape_id"] = shape_id
                shapes[(route_id, d)] = geom
                routes_seen.add(route_id)
    finally:
        con.close()

    # index: route_id -> list of available direction ids
    route_dirs: dict[str, list[int]] = {}
    for (route_id, d) in shapes:
        route_dirs.setdefault(route_id, []).append(d)
    for r in route_dirs:
        route_dirs[r].sort()
    return {
        "built_at": int(time.time()),
        "shapes": shapes,
        "route_dirs": route_dirs,
        "n_route_dirs": len(shapes),
        "n_routes": len(route_dirs),
    }


def get_lut() -> dict[str, Any]:
    """Load the bus shape LUT (disk cache keyed by GTFS fingerprint; build once)."""
    global _lut
    if _lut is not None:
        return _lut
    fp = _fingerprint()
    cache = _cache_path(fp)
    if cache.exists():
        try:
            with cache.open("rb") as fh:
                _lut = pickle.load(fh)
            return _lut
        except Exception:
            pass  # corrupt cache -> rebuild
    _lut = _build()
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        for old in cache.parent.glob("bus_shape_lut_*.pkl"):
            if old != cache:
                old.unlink(missing_ok=True)
        with cache.open("wb") as fh:
            pickle.dump(_lut, fh, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        pass  # cache is an optimisation; never fatal
    return _lut


def to_feet(lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x, y = _TF.transform(lon, lat)
    return np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)


def route_shape_latlon(route_id: str, direction_id: int | None = None) -> dict[str, Any]:
    """Client-facing: the exact decimated lat/lon polyline(s) route_offset_ft is measured
    against, with cumulative offset_ft per vertex (so a client can place a bus at its
    route_offset_ft unambiguously). Returns all directions when direction_id is None."""
    lut = get_lut()
    dirs = lut["route_dirs"].get(route_id, [])
    if direction_id is not None:
        dirs = [direction_id] if direction_id in dirs else []
    out = []
    for d in dirs:
        e = lut["shapes"].get((route_id, d))
        if not e:
            continue
        out.append({
            "direction_id": d,
            "shape_id": e["shape_id"],
            "shape_len_ft": round(e["shape_len_ft"], 1),
            "n_verts": e["n_verts"],
            "polyline": e["latlon"],
            "offset_ft": [round(float(c), 1) for c in e["cum"]],
        })
    return {"route_id": route_id, "directions": out}
