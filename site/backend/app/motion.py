"""Motion-model enrichment for /api/rt/vehicles (Ant Farm v3 W1-server).

Given the freshest per-vehicle snapshot (realtime.get_vehicles), add — per bus, only where
honestly resolvable — the additive fields the client needs to glide buses ALONG their route
between the ~31 s MTA reports:

  shape_id         the route x direction shape the bus was projected onto
  route_offset_ft  nearest-point projection of the GPS onto that shape (distance travelled
                   along the route, in the SAME ft space as derive2's speed table)
  speed_est_fps    blended speed estimate (see below)
  speed_basis      how speed_est_fps was resolved: observed | segment | route | default

Honesty guards (mirroring derive2/trajectories.py's monotonic-offset logic):
  * off-shape: projected perpendicular distance > OFF_SHAPE_FT (200 ft) -> OMIT shape_id +
    route_offset_ft (counted as `omitted_off_shape`). MTA BusTime positions are shape-snapped
    so this is rare and flags a genuine reroute / wrong-shape assignment.
  * non-monotonic: the along-shape offset jumped BACKWARD by > MONO_BACKTRACK_FT (500 ft)
    between the bus's previous and latest ping -> OMIT shape fields (`omitted_non_monotonic`)
    — the projection landed on the wrong lobe of a looping/branched route.

speed_est_fps blend (first that is available/sane wins):
  observed  displacement(prev->latest ping) / Δt, kept only if 1..90 fps (SPEED band)
  segment   per (route, direction, half-mile offset bin) median from derive2's speed table
  route     per-route median from derive2's speed table
  default   SPEED_DEFAULT_FPS (~8 mph) citywide floor

Costs: one grouped, vectorised nearest-point pass over the shape LUT — no per-request GTFS
read, no new service. The speed table is a tiny parquet loaded once (mtime-refreshed).
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

from . import busshapes, config

OFF_SHAPE_FT = 200.0
MONO_BACKTRACK_FT = 500.0
SEG_BIN_FT = 2640.0          # keep identical to derive2 _common.SEG_BIN_FT
SPEED_MIN_FPS = 1.0
SPEED_MAX_FPS = 90.0
SPEED_DEFAULT_FPS = 12.0

# last-enrichment timing (ms), exposed in the payload meta + readable for perf reports.
_last_ms: float = 0.0

_speed_tbl: dict[str, Any] = {"sig": None, "segment": {}, "route": {}}


def _speed_files() -> tuple[Path, Path]:
    base = config.DERIVED_ROOT / "route_segment_speeds"
    return base / "segment-000.parquet", base / "route-000.parquet"


def _speed_sig() -> tuple:
    seg_p, rte_p = _speed_files()
    def s(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except OSError:
            return 0.0
    return (s(seg_p), s(rte_p))


def _load_speed_table() -> dict[str, Any]:
    """Load derive2's per-route x segment speed table into lookup dicts (mtime-cached)."""
    sig = _speed_sig()
    if _speed_tbl["sig"] == sig:
        return _speed_tbl
    seg_p, rte_p = _speed_files()
    segment: dict[tuple[str, int, int], float] = {}
    route: dict[str, float] = {}
    if seg_p.exists() or rte_p.exists():
        import duckdb
        con = duckdb.connect()
        try:
            if seg_p.exists():
                for r, d, b, fps in con.execute(
                    f"SELECT route_id, direction_id, seg_bin, median_fps "
                    f"FROM read_parquet('{seg_p.as_posix()}')"
                ).fetchall():
                    segment[(str(r), int(d), int(b))] = float(fps)
            if rte_p.exists():
                for r, fps in con.execute(
                    f"SELECT route_id, median_fps FROM read_parquet('{rte_p.as_posix()}')"
                ).fetchall():
                    route[str(r)] = float(fps)
        finally:
            con.close()
    _speed_tbl.update(sig=sig, segment=segment, route=route)
    return _speed_tbl


def enrich(data: dict[str, Any]) -> dict[str, Any]:
    """Add motion fields to a get_vehicles() payload IN PLACE and return it."""
    global _last_ms
    t0 = time.perf_counter()
    vehicles = data.get("vehicles") or []
    prev = data.pop("_prev", None) or {}   # {vehicle_id: (lat, lon, ts)} — archive only
    n = len(vehicles)
    summary = {
        "n": n, "with_shape": 0,
        "omitted_off_shape": 0, "omitted_non_monotonic": 0, "omitted_no_lut": 0,
        "speed_basis": {"observed": 0, "segment": 0, "route": 0, "default": 0},
    }
    if n == 0:
        data["motion"] = summary
        _last_ms = round((time.perf_counter() - t0) * 1000, 2)
        data.setdefault("meta", {})["motion_ms"] = _last_ms
        return data

    lut = busshapes.get_lut()
    spd = _load_speed_table()
    seg_speed, route_speed = spd["segment"], spd["route"]

    lat = np.array([v.get("lat") for v in vehicles], dtype=np.float64)
    lon = np.array([v.get("lon") for v in vehicles], dtype=np.float64)
    fx, fy = busshapes.to_feet(lat, lon)

    # previous ping (archive only) -> feet + Δt, for observed speed and the monotonic guard
    plat = np.full(n, np.nan); plon = np.full(n, np.nan); pts = np.full(n, np.nan)
    have_prev = np.zeros(n, dtype=bool)
    for i, v in enumerate(vehicles):
        pv = prev.get(v.get("vehicle_id"))
        if pv is not None and pv[0] is not None and pv[1] is not None and pv[2] is not None:
            plat[i], plon[i], pts[i] = pv[0], pv[1], pv[2]
            have_prev[i] = True
    pfx = np.full(n, np.nan); pfy = np.full(n, np.nan)
    if have_prev.any():
        m = have_prev
        pfx[m], pfy[m] = busshapes.to_feet(lat=plat[m], lon=plon[m])

    # ---- observed speed (displacement / Δt), sane band only ---------------------------
    speed = np.full(n, np.nan)
    basis = np.array([None] * n, dtype=object)
    now = time.time()
    with np.errstate(invalid="ignore", divide="ignore"):
        cur_ts = np.array([v.get("timestamp") or now for v in vehicles], dtype=np.float64)
        dt = cur_ts - pts
        dist = np.hypot(fx - pfx, fy - pfy)
        obs = dist / dt
    ok_obs = have_prev & (dt > 0) & (dt < 900) & np.isfinite(obs) & \
             (obs >= SPEED_MIN_FPS) & (obs <= SPEED_MAX_FPS)
    speed[ok_obs] = obs[ok_obs]
    basis[ok_obs] = "observed"

    # ---- project onto the route shape (grouped by route_id) ---------------------------
    route_ids = [str(v.get("route_id")) if v.get("route_id") is not None else None
                 for v in vehicles]
    dir_ids = [v.get("direction_id") for v in vehicles]
    by_route: dict[str, list[int]] = {}
    for i, r in enumerate(route_ids):
        if r is not None:
            by_route.setdefault(r, []).append(i)

    offset_out = np.full(n, np.nan)
    perp_out = np.full(n, np.nan)
    prev_offset_out = np.full(n, np.nan)
    shape_out: list[Any] = [None] * n
    chosen_dir = np.full(n, -1, dtype=int)
    dir_arr = np.array([d if d is not None else -99 for d in dir_ids])

    def _assign(gi: np.ndarray, e: dict, d: int) -> None:
        """Project latest + prev pings of buses `gi` onto shape entry `e` in one call."""
        if len(gi) == 0:
            return
        M = len(gi)
        allx = np.concatenate([fx[gi], pfx[gi]])
        ally = np.concatenate([fy[gi], pfy[gi]])
        off_all, perp_all = busshapes.project(e, allx, ally)
        offset_out[gi] = off_all[:M]
        perp_out[gi] = perp_all[:M]
        poff = off_all[M:]
        prev_offset_out[gi] = np.where(np.isfinite(pfx[gi]), poff, np.nan)
        chosen_dir[gi] = d
        sid = e["shape_id"]
        for i in gi:
            shape_out[i] = sid

    for r, idxs in by_route.items():
        avail = [d for d in (lut["route_dirs"].get(r) or []) if (r, d) in lut["shapes"]]
        if not avail:
            summary["omitted_no_lut"] += len(idxs)
            continue
        ii = np.array(idxs)
        gdir = dir_arr[ii]
        # Trust the declared direction: project each declared-dir group ONCE. Only buses whose
        # declared direction has no shape (or is missing) are resolved against all directions.
        ambiguous = np.ones(len(ii), dtype=bool)
        for d in avail:
            ambiguous &= (gdir != d)
        for d in avail:
            gi = ii[gdir == d]
            _assign(gi, lut["shapes"][(r, d)], d)
        amb = ii[ambiguous]
        if len(amb) and len(avail) == 1:
            _assign(amb, lut["shapes"][(r, avail[0])], avail[0])
        elif len(amb):
            best_perp = np.full(len(amb), np.inf)
            for d in avail:
                o, p = busshapes.project(lut["shapes"][(r, d)], fx[amb], fy[amb])
                take = p < best_perp
                if take.any():
                    gi = amb[take]
                    _assign(gi, lut["shapes"][(r, d)], d)
                    best_perp[take] = p[take]

    # ---- guards (vectorised) ---------------------------------------------------------
    have_proj = np.isfinite(offset_out)
    off_shape = have_proj & (perp_out > OFF_SHAPE_FT)
    non_mono = (have_proj & ~off_shape & np.isfinite(prev_offset_out)
                & (offset_out < prev_offset_out - MONO_BACKTRACK_FT))
    keep_shape = have_proj & ~off_shape & ~non_mono
    summary["omitted_off_shape"] = int(off_shape.sum())
    summary["omitted_non_monotonic"] = int(non_mono.sum())
    summary["with_shape"] = int(keep_shape.sum())

    # ---- assemble fields (single write pass; python scalars, no numpy per-elem) -------
    offset_l = offset_out.tolist()
    speed_l = speed.tolist()
    keep_l = keep_shape.tolist()
    cdir_l = chosen_dir.tolist()
    sb = summary["speed_basis"]
    for i, v in enumerate(vehicles):
        if keep_l[i]:
            v["shape_id"] = shape_out[i]
            v["route_offset_ft"] = round(offset_l[i], 1)
        b = basis[i]
        if b is None:  # speed fallback: segment -> route -> default
            r = route_ids[i]
            if keep_l[i]:
                key = (r, cdir_l[i], int(offset_l[i] // SEG_BIN_FT))
                fps = seg_speed.get(key)
                if fps is not None:
                    speed_l[i] = fps; b = "segment"
            if b is None and r is not None and r in route_speed:
                speed_l[i] = route_speed[r]; b = "route"
            if b is None:
                speed_l[i] = SPEED_DEFAULT_FPS; b = "default"
        v["speed_est_fps"] = round(float(speed_l[i]), 2)
        v["speed_basis"] = b
        sb[b] += 1

    data["motion"] = summary
    _last_ms = round((time.perf_counter() - t0) * 1000, 2)
    data.setdefault("meta", {})["motion_ms"] = _last_ms
    return data


def last_ms() -> float:
    return _last_ms
