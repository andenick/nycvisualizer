"""Realtime subway (NYCT + SIR) train positions.

NYCT GTFS-RT reports trains by STATION, not lat/lon: each vehicle row carries a
target/current stop_id (child id with N/S suffix), current_stop_seq, and a
current_status (0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO). We resolve
positions against the GTFS static:

- STOPPED_AT            -> the station's coordinates. positional_basis="station"
                           (an observed at-station report).
- IN_TRANSIT_TO/INCOMING-> interpolated along the trip's GTFS shape between the
                           previous station in the trip's stop sequence and the
                           target station. The fraction travelled is estimated
                           from elapsed time since the vehicle `timestamp` vs the
                           scheduled inter-station time (midpoint fallback when
                           the schedule join fails). positional_basis="interpolated"
                           — an honest estimate, exposed as such by the API.

Archive-first (poller parquet under REALTIME_ARCHIVE/subway_*), with a per-feed
key-free live GTFS-RT fallback when a feed's archive is stale.
"""
from __future__ import annotations

import hashlib
import math
import os
import pickle
import time
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any

import duckdb

from . import config

# The 8 NYCT line-group vehicle feeds + SIR archived by the poller.
SUBWAY_FEEDS = [
    "subway_gtfs",  # 1 2 3 4 5 6 7 + 42 St shuttle (GS)
    "subway_ace",   # A C E + Rockaway shuttle (H)
    "subway_bdfm",  # B D F M + Franklin Av shuttle (FS)
    "subway_g",
    "subway_jz",
    "subway_l",
    "subway_nqrw",
    "subway_si",    # Staten Island Railway
]

_RT_BASE = os.environ.get(
    "NYCV_SUBWAY_RT_BASE", "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds"
)
FEED_URLS: dict[str, str] = {
    "subway_gtfs": f"{_RT_BASE}/nyct%2Fgtfs",
    "subway_ace": f"{_RT_BASE}/nyct%2Fgtfs-ace",
    "subway_bdfm": f"{_RT_BASE}/nyct%2Fgtfs-bdfm",
    "subway_g": f"{_RT_BASE}/nyct%2Fgtfs-g",
    "subway_jz": f"{_RT_BASE}/nyct%2Fgtfs-jz",
    "subway_l": f"{_RT_BASE}/nyct%2Fgtfs-l",
    "subway_nqrw": f"{_RT_BASE}/nyct%2Fgtfs-nqrw",
    "subway_si": f"{_RT_BASE}/nyct%2Fgtfs-si",
}

ROUTE_TO_FEED: dict[str, str] = {
    **{r: "subway_gtfs" for r in ["1", "2", "3", "4", "5", "6", "6X", "7", "7X", "GS", "S"]},
    **{r: "subway_ace" for r in ["A", "C", "E", "H"]},
    **{r: "subway_bdfm" for r in ["B", "D", "F", "FX", "M", "FS"]},
    "G": "subway_g",
    "J": "subway_jz",
    "Z": "subway_jz",
    "L": "subway_l",
    **{r: "subway_nqrw" for r in ["N", "Q", "R", "W"]},
    "SI": "subway_si",
    "SIR": "subway_si",
}

_live_cache: dict[str, dict[str, Any]] = {}  # feed -> {ts, rows, as_of}
_static: dict[str, Any] | None = None


# --------------------------------------------------------------------------- static
def _subway_gtfs_dir() -> Path:
    return config.GTFS_STATIC_ROOT / "gtfs_subway" / "gtfs"


def _parse_gtfs_time(t: str | None) -> int | None:
    """HH:MM:SS (may exceed 24h) -> seconds."""
    if not t:
        return None
    try:
        h, m, s = t.strip().split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
    except Exception:
        return None


def _load_static() -> dict[str, Any]:
    """Load and cache stations, shapes, and per-shape stop sequences."""
    global _static
    if _static is not None:
        return _static
    gdir = _subway_gtfs_dir()
    stations: dict[str, dict[str, Any]] = {}
    child2parent: dict[str, str] = {}
    shapes: dict[str, list[tuple[float, float]]] = {}
    shape_seq: dict[str, list[dict[str, Any]]] = {}
    shape_route: dict[str, str] = {}
    station_routes: dict[str, set[str]] = {}

    if not (gdir / "stops.txt").exists():
        _static = {
            "stations": stations, "child2parent": child2parent, "shapes": shapes,
            "shape_seq": shape_seq, "shape_route": shape_route, "station_routes": station_routes,
        }
        return _static

    con = duckdb.connect()
    try:
        for sid, name, lat, lon, loc, parent in con.execute(
            f"""
            SELECT stop_id, stop_name, CAST(stop_lat AS DOUBLE), CAST(stop_lon AS DOUBLE),
                   location_type, parent_station
            FROM read_csv_auto('{(gdir / "stops.txt").as_posix()}', header=true, all_varchar=true)
            """
        ).fetchall():
            if parent:
                child2parent[sid] = parent
            else:
                stations[sid] = {"id": sid, "name": name, "lat": lat, "lon": lon}

        for shape_id, lat, lon in con.execute(
            f"""
            SELECT shape_id, CAST(shape_pt_lat AS DOUBLE), CAST(shape_pt_lon AS DOUBLE)
            FROM read_csv_auto('{(gdir / "shapes.txt").as_posix()}', header=true, all_varchar=true)
            ORDER BY shape_id, CAST(shape_pt_sequence AS BIGINT)
            """
        ).fetchall():
            shapes.setdefault(shape_id, []).append((lat, lon))

        # Representative trip per shape -> its ordered stop sequence + scheduled times.
        rows = con.execute(
            f"""
            WITH rep AS (
                SELECT shape_id, min(trip_id) AS trip_id, min(route_id) AS route_id
                FROM read_csv_auto('{(gdir / "trips.txt").as_posix()}', header=true, all_varchar=true)
                WHERE shape_id IS NOT NULL AND shape_id <> ''
                GROUP BY shape_id
            )
            SELECT rep.shape_id, rep.route_id, st.stop_id, st.arrival_time,
                   CAST(st.stop_sequence AS BIGINT)
            FROM read_csv_auto('{(gdir / "stop_times.txt").as_posix()}', header=true, all_varchar=true) st
            JOIN rep ON st.trip_id = rep.trip_id
            ORDER BY rep.shape_id, CAST(st.stop_sequence AS BIGINT)
            """
        ).fetchall()
        for shape_id, route_id, stop_id, arr, seq in rows:
            shape_route[shape_id] = route_id
            parent = child2parent.get(stop_id, stop_id)
            shape_seq.setdefault(shape_id, []).append(
                {"stop_id": stop_id, "parent": parent, "arr_s": _parse_gtfs_time(arr), "seq": int(seq)}
            )
            if parent in stations and route_id:
                station_routes.setdefault(parent, set()).add(route_id)
    finally:
        con.close()

    _static = {
        "stations": stations, "child2parent": child2parent, "shapes": shapes,
        "shape_seq": shape_seq, "shape_route": shape_route, "station_routes": station_routes,
    }
    return _static


def get_station_catalog() -> list[dict[str, Any]]:
    st = _load_static()
    out = []
    for sid, s in st["stations"].items():
        routes = sorted(st["station_routes"].get(sid, set()))
        if not routes:
            continue  # skip parents never served by a rep trip (non-subway rows)
        out.append({**s, "routes": routes})
    out.sort(key=lambda s: s["name"])
    return out


# --------------------------------------------------------------- geometry helpers
def _dist2(a: tuple[float, float], b: tuple[float, float]) -> float:
    # equirectangular squared distance — fine at NYC scale for nearest-vertex search
    dy = a[0] - b[0]
    dx = (a[1] - b[1]) * 0.7547  # cos(40.7 deg)
    return dy * dy + dx * dx


def _nearest_vertex(poly: list[tuple[float, float]], pt: tuple[float, float]) -> int:
    best, bi = float("inf"), 0
    for i, p in enumerate(poly):
        d = _dist2(p, pt)
        if d < best:
            best, bi = d, i
    return bi


@lru_cache(maxsize=4096)
def _subpath(shape_id: str, prev_parent: str, tgt_parent: str) -> tuple[tuple[float, float], ...]:
    """Sub-polyline of the shape between two stations (inclusive), in travel order."""
    st = _load_static()
    poly = st["shapes"].get(shape_id)
    a = st["stations"].get(prev_parent)
    b = st["stations"].get(tgt_parent)
    if not poly or not a or not b:
        pts = []
        if a:
            pts.append((a["lat"], a["lon"]))
        if b:
            pts.append((b["lat"], b["lon"]))
        return tuple(pts)
    ia = _nearest_vertex(poly, (a["lat"], a["lon"]))
    ib = _nearest_vertex(poly, (b["lat"], b["lon"]))
    if ia == ib:
        return ((a["lat"], a["lon"]), (b["lat"], b["lon"]))
    seg = poly[ia : ib + 1] if ia < ib else list(reversed(poly[ib : ia + 1]))
    return tuple(seg)


def _seg_for_client(path: tuple[tuple[float, float], ...]) -> list[list[float]]:
    """Round + decimate an inter-station sub-polyline for the wire.

    The frontend lays the ~160 m train worm ALONG this segment (so it follows the
    track, not a straight line through buildings) and animates the fraction along
    it. Coordinates rounded to 5 dp (~1.1 m); capped to ~28 vertices (inter-station
    hops are short) to keep the whole-fleet payload small.
    """
    if not path or len(path) < 2:
        return []
    pts = [[round(p[0], 5), round(p[1], 5)] for p in path]
    # drop consecutive duplicates left by rounding
    out = [pts[0]]
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    if len(out) <= 28:
        return out
    # uniform decimation, always keeping the two endpoints
    step = (len(out) - 1) / 27.0
    dec = [out[round(i * step)] for i in range(28)]
    dec[-1] = out[-1]
    return dec


def _point_along(path: tuple[tuple[float, float], ...], frac: float) -> tuple[float, float] | None:
    if not path:
        return None
    if len(path) == 1:
        return path[0]
    lengths = []
    total = 0.0
    for i in range(len(path) - 1):
        d = math.sqrt(_dist2(path[i], path[i + 1]))
        lengths.append(d)
        total += d
    if total <= 0:
        return path[0]
    target = frac * total
    acc = 0.0
    for i, d in enumerate(lengths):
        if acc + d >= target:
            t = (target - acc) / d if d > 0 else 0.0
            return (
                path[i][0] + (path[i + 1][0] - path[i][0]) * t,
                path[i][1] + (path[i + 1][1] - path[i][1]) * t,
            )
        acc += d
    return path[-1]


# --------------------------------------------------- precomputed stop-pair seg LUT
# The per-request nearest-vertex scan of a full shape (via _subpath) resolved a seg
# for only ~22% of in-transit trains: the RT feed reports a train's *next* stop, and
# for terminal-approach trains that stop is the FIRST stop of the trip's shape, so
# there was no previous station to draw a segment from. We precompute, ONCE at
# startup (cached to disk, keyed by a GTFS-static fingerprint), the decimated shape
# sub-polyline for every (route, prev_child_stop, target_child_stop) adjacent pair,
# plus a canonical-predecessor table so ANY (route, target_stop) — including trips
# whose shape_id we can't parse — can resolve a previous station. This lifts seg
# coverage to >99% of in-transit trains without changing the wire contract.
_seg_lut: dict[str, Any] | None = None


def _gtfs_fingerprint() -> str:
    """Cheap-but-robust fingerprint of the subway GTFS static feed.

    Content-hashes the three small files (stops/trips/shapes) and folds in size+mtime
    of the large stop_times.txt, so any feed swap busts the on-disk LUT cache.
    """
    gdir = _subway_gtfs_dir()
    h = hashlib.sha256()
    for name in ("stops.txt", "trips.txt", "shapes.txt"):
        p = gdir / name
        h.update(name.encode())
        h.update(p.read_bytes() if p.exists() else b"-")
    big = gdir / "stop_times.txt"
    if big.exists():
        stt = big.stat()
        h.update(f"stop_times:{stt.st_size}:{int(stt.st_mtime_ns)}".encode())
    return h.hexdigest()[:16]


def _seg_lut_cache_path(fp: str) -> Path:
    return config.DATA_ROOT / "cache" / f"subway_seg_lut_{fp}.pkl"


def _build_seg_lut() -> dict[str, Any]:
    """Precompute stop-pair sub-polylines + canonical predecessors from GTFS static."""
    st = _load_static()
    child2parent = st["child2parent"]
    stations = st["stations"]
    gdir = _subway_gtfs_dir()

    pair_seg: dict[tuple[str, str, str], list[list[float]]] = {}
    prev_lut: dict[tuple[str, str], str] = {}

    if not (gdir / "stop_times.txt").exists():
        return {"pair_seg": pair_seg, "prev_lut": prev_lut}

    con = duckdb.connect()
    try:
        rows = con.execute(
            f"""
            WITH tr AS (
                SELECT trip_id, route_id, shape_id
                FROM read_csv_auto('{(gdir / "trips.txt").as_posix()}', header=true, all_varchar=true)
            )
            SELECT st.trip_id, tr.route_id, tr.shape_id, st.stop_id,
                   CAST(st.stop_sequence AS BIGINT) AS seq
            FROM read_csv_auto('{(gdir / "stop_times.txt").as_posix()}', header=true, all_varchar=true) st
            JOIN tr ON st.trip_id = tr.trip_id
            ORDER BY st.trip_id, seq
            """
        ).fetchall()
    finally:
        con.close()

    # Group rows into per-trip ordered stop lists.
    trips: dict[str, list[tuple[str, str | None, str, int]]] = defaultdict(list)
    for trip_id, route_id, shape_id, stop_id, seq in rows:
        if route_id:
            trips[trip_id].append((route_id, shape_id, stop_id, int(seq)))

    # (route, prev_child, tgt_child) -> Counter(shape) ; pick canonical shape per pair.
    pair_shape: dict[tuple[str, str, str], Counter] = defaultdict(Counter)
    fwd_prev: dict[tuple[str, str], Counter] = defaultdict(Counter)      # (route,tgt)->prev
    origin_prev: dict[tuple[str, str], Counter] = defaultdict(Counter)   # (route,origin)->neighbor
    for trip_id, stlist in trips.items():
        stlist.sort(key=lambda x: x[3])
        for i, (route, shape, stop, _seq) in enumerate(stlist):
            if i >= 1:
                pstop = stlist[i - 1][2]
                fwd_prev[(route, stop)][pstop] += 1
                if shape:
                    pair_shape[(route, pstop, stop)][shape] += 1
            elif len(stlist) > 1:
                # Origin terminal: its physical neighbour is the 2nd stop. A train
                # reported IN_TRANSIT_TO / INCOMING_AT the terminal rides this track.
                nxt = stlist[1][2]
                origin_prev[(route, stop)][nxt] += 1
                if shape:
                    pair_shape[(route, nxt, stop)][shape] += 1

    # Canonical predecessor per (route, target): forward adjacency wins, else terminal.
    for key, c in fwd_prev.items():
        prev_lut[key] = c.most_common(1)[0][0]
    for key, c in origin_prev.items():
        prev_lut.setdefault(key, c.most_common(1)[0][0])

    # Decimated shape sub-polyline per (route, prev_child, target_child).
    for (route, pstop, tstop), c in pair_shape.items():
        shape_id = c.most_common(1)[0][0]
        pp = child2parent.get(pstop, pstop)
        tp = child2parent.get(tstop, tstop)
        if pp not in stations or tp not in stations:
            continue
        seg = _seg_for_client(_subpath(shape_id, pp, tp))
        if len(seg) >= 2:
            pair_seg[(route, pstop, tstop)] = seg

    return {"pair_seg": pair_seg, "prev_lut": prev_lut}


def _load_seg_lut() -> dict[str, Any]:
    """Load the stop-pair seg LUT (disk cache keyed by GTFS fingerprint; build once)."""
    global _seg_lut
    if _seg_lut is not None:
        return _seg_lut
    fp = _gtfs_fingerprint()
    cache = _seg_lut_cache_path(fp)
    if cache.exists():
        try:
            with cache.open("rb") as fh:
                _seg_lut = pickle.load(fh)
            return _seg_lut
        except Exception:
            pass  # corrupt cache -> rebuild
    _seg_lut = _build_seg_lut()
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        # Drop stale fingerprints so the cache dir doesn't accumulate.
        for old in cache.parent.glob("subway_seg_lut_*.pkl"):
            if old != cache:
                old.unlink(missing_ok=True)
        with cache.open("wb") as fh:
            pickle.dump(_seg_lut, fh, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        pass  # cache is an optimisation; never fatal
    return _seg_lut


# ------------------------------------------------------------------ position logic
def _resolve_train(row: dict[str, Any], now: float) -> dict[str, Any] | None:
    """RT row -> positioned train dict, or None if the station is unresolvable."""
    st = _load_static()
    stations = st["stations"]
    child2parent = st["child2parent"]

    stop_id = row.get("stop_id")
    if not stop_id:
        return None
    parent = child2parent.get(stop_id, stop_id)
    tgt = stations.get(parent)
    if tgt is None:
        return None

    trip_id = row.get("trip_id") or ""
    route_id = row.get("route_id")
    status_code = row.get("current_status")
    ts = row.get("timestamp")
    shape_id = trip_id.split("_", 1)[1] if "_" in trip_id else None

    base = {
        "trip_id": trip_id,
        "route_id": route_id,
        "feed": row.get("feed"),
        "stop_id": parent,
        "stop_name": tgt["name"],
        "prev_stop_name": None,
        "timestamp": int(ts) if ts is not None else None,
    }

    # STOPPED_AT -> observed at the station.
    if status_code == 1:
        return {**base, "lat": tgt["lat"], "lon": tgt["lon"],
                "status": "at_station", "positional_basis": "station"}

    status = "approaching" if status_code == 0 else "in_transit"

    # --- Resolve the previous stop (child id) + scheduled hop time. --------------
    # (a) Prefer the train's OWN trip shape sequence — most accurate for express vs
    #     local. For a terminal-approach train (target is the trip's first stop) the
    #     physical neighbour is the SECOND stop, so fall back to idx+1.
    # (b) Otherwise use the precomputed route-level canonical predecessor, which also
    #     covers trips whose shape_id we can't parse.
    prev_child = None
    sched_s = None
    seq = st["shape_seq"].get(shape_id or "", [])
    if seq:
        idx = next((i for i, e in enumerate(seq) if e["stop_id"] == stop_id), None)
        if idx is None:
            idx = next((i for i, e in enumerate(seq) if e["parent"] == parent), None)
        if idx is not None:
            if idx >= 1:
                prev_child = seq[idx - 1]["stop_id"]
                a0, a1 = seq[idx - 1]["arr_s"], seq[idx]["arr_s"]
                if a0 is not None and a1 is not None and a1 > a0:
                    sched_s = a1 - a0
            elif len(seq) > 1:  # terminal-origin target -> use the 2nd stop as neighbour
                prev_child = seq[idx + 1]["stop_id"]

    lut = _load_seg_lut()
    if prev_child is None and route_id:
        prev_child = lut["prev_lut"].get((route_id, stop_id))

    prev_parent = child2parent.get(prev_child, prev_child) if prev_child else None
    if not prev_parent or prev_parent == parent:
        # No usable previous station -> estimate AT the target (honestly interpolated).
        return {**base, "lat": tgt["lat"], "lon": tgt["lon"],
                "status": status, "positional_basis": "interpolated"}

    prev_st = st["stations"].get(prev_parent)
    if prev_st:
        base["prev_stop_name"] = prev_st["name"]

    # Fraction travelled: elapsed since last vehicle report vs scheduled hop time.
    frac = 0.5
    if sched_s and ts:
        elapsed = max(0.0, min(now - float(ts), 900.0))
        frac = max(0.05, min(elapsed / float(sched_s), 0.95))
    if status_code == 0:  # INCOMING_AT — nearly there
        frac = max(frac, 0.85)

    # --- Segment: precomputed shape sub-polyline -> straight glide -> no seg. -----
    seg = lut["pair_seg"].get((route_id, prev_child, stop_id)) if route_id else None
    seg_basis = "shape"
    if not seg or len(seg) < 2:
        # Honest fallback: a straight line between the two station coords. Short
        # (adjacent stations), still animates, flagged so the client can style it.
        if prev_st:
            seg = [[round(prev_st["lat"], 5), round(prev_st["lon"], 5)],
                   [round(tgt["lat"], 5), round(tgt["lon"], 5)]]
            seg_basis = "straight"
        else:
            seg = None

    if seg:
        pos = _point_along(seg, frac) or (tgt["lat"], tgt["lon"])
        return {**base, "lat": pos[0], "lon": pos[1],
                "status": status, "positional_basis": "interpolated",
                "seg": seg, "frac": round(frac, 4), "seg_basis": seg_basis}
    # Only reaches here if the previous station coord is unknown.
    return {**base, "lat": tgt["lat"], "lon": tgt["lon"],
            "status": status, "positional_basis": "interpolated"}


# ------------------------------------------------------------------- data sources
def _newest_partition_files(feed: str) -> list[str]:
    base = config.REALTIME_ARCHIVE / feed
    if not base.exists():
        return []
    for d in sorted(base.glob("date=*"), reverse=True):
        for h in sorted(d.glob("hour=*"), reverse=True):
            files = list(h.glob("*.parquet"))
            if files:
                return [p.as_posix() for p in files]
    return []


_ARCHIVE_COLS = "feed, poll_ts, trip_id, route_id, stop_id, current_stop_seq, current_status, timestamp"


def _feed_from_archive(feed: str) -> dict[str, Any] | None:
    files = _newest_partition_files(feed)
    if not files:
        return None
    lst = ",".join("'" + f + "'" for f in files)
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"""
            WITH t AS (SELECT {_ARCHIVE_COLS} FROM read_parquet([{lst}])),
                 m AS (SELECT max(poll_ts) AS mx FROM t)
            SELECT t.*, (SELECT mx FROM m) AS as_of
            FROM t, m
            WHERE t.poll_ts >= m.mx - 90 AND t.stop_id IS NOT NULL
            QUALIFY row_number() OVER (
                PARTITION BY trip_id ORDER BY coalesce(timestamp, poll_ts) DESC
            ) = 1
            """
        ).fetchall()
        cols = [d[0] for d in con.description]
    finally:
        con.close()
    if not rows:
        return None
    recs = [dict(zip(cols, r)) for r in rows]
    as_of = int(recs[0]["as_of"])
    return {"as_of": as_of, "source": "archive", "rows": recs}


def _feed_from_live(feed: str) -> dict[str, Any] | None:
    """Key-free NYCT GTFS-RT fetch, cached 31s per feed. Returns vehicle + trip_update rows."""
    now = time.time()
    hit = _live_cache.get(feed)
    if hit and (now - hit["ts"]) < config.LIVE_CACHE_TTL_S:
        return hit["data"]
    url = FEED_URLS.get(feed)
    if not url:
        return None
    try:
        import httpx
        from google.transit import gtfs_realtime_pb2  # type: ignore

        r = httpx.get(url, timeout=20.0)
        r.raise_for_status()
        fm = gtfs_realtime_pb2.FeedMessage()
        fm.ParseFromString(r.content)
        as_of = int(fm.header.timestamp) if fm.header.timestamp else int(now)
        rows = []
        trip_updates = []
        for ent in fm.entity:
            if ent.HasField("vehicle"):
                v = ent.vehicle
                rows.append(
                    {
                        "feed": feed,
                        "poll_ts": as_of,
                        "trip_id": v.trip.trip_id or ent.id,
                        "route_id": v.trip.route_id or None,
                        "stop_id": v.stop_id or None,
                        "current_stop_seq": v.current_stop_sequence if v.HasField("current_stop_sequence") else None,
                        "current_status": v.current_status if v.HasField("current_status") else None,
                        "timestamp": int(v.timestamp) if v.timestamp else None,
                    }
                )
            elif ent.HasField("trip_update"):
                tu = ent.trip_update
                stus = [
                    {
                        "stop_id": s.stop_id,
                        "arrival": int(s.arrival.time) if s.HasField("arrival") and s.arrival.time else None,
                        "departure": int(s.departure.time) if s.HasField("departure") and s.departure.time else None,
                    }
                    for s in tu.stop_time_update
                ]
                trip_updates.append(
                    {"trip_id": tu.trip.trip_id, "route_id": tu.trip.route_id or None, "stops": stus}
                )
        data = {"as_of": as_of, "source": "live", "rows": rows, "trip_updates": trip_updates}
        _live_cache[feed] = {"ts": now, "data": data}
        return data
    except Exception:
        return None


# ---------------------------------------------------------------------- public API
def get_subway() -> dict[str, Any]:
    """Latest positioned state per active trip across all subway feeds."""
    now = time.time()
    trains: list[dict[str, Any]] = []
    feeds_meta: dict[str, Any] = {}
    n_station = n_interp = 0
    overall_as_of: int | None = None
    sources = set()

    for feed in SUBWAY_FEEDS:
        data = _feed_from_archive(feed)
        stale = data is None or (now - data["as_of"]) > config.STALE_AFTER_S
        if stale:
            live = _feed_from_live(feed)
            if live is not None and (data is None or live["as_of"] >= data["as_of"]):
                data = live
                stale = (now - data["as_of"]) > config.STALE_AFTER_S
        if data is None:
            feeds_meta[feed] = {"as_of": None, "source": "none", "count": 0, "stale": True}
            continue
        cnt = 0
        for row in data["rows"]:
            t = _resolve_train(row, now)
            if t is None:
                continue
            trains.append(t)
            cnt += 1
            if t["positional_basis"] == "station":
                n_station += 1
            else:
                n_interp += 1
        feeds_meta[feed] = {"as_of": data["as_of"], "source": data["source"], "count": cnt, "stale": stale}
        sources.add(data["source"])
        if overall_as_of is None or data["as_of"] > overall_as_of:
            overall_as_of = data["as_of"]

    source = "none" if not sources else (sources.pop() if len(sources) == 1 else "mixed")
    any_stale = any(m["stale"] for m in feeds_meta.values())
    return {
        "as_of": overall_as_of,
        "source": source,
        "count": len(trains),
        "stale": any_stale,
        "feeds": feeds_meta,
        "positional": {"station": n_station, "interpolated": n_interp},
        "trains": trains,
    }


def get_station_arrivals(station_id: str) -> dict[str, Any]:
    """Next arrivals at a station from the relevant line-group feeds' trip updates
    (key-free live fetch, cached 31s per feed)."""
    st = _load_static()
    routes = sorted(st["station_routes"].get(station_id, set()))
    feeds = sorted({ROUTE_TO_FEED[r] for r in routes if r in ROUTE_TO_FEED}) or list(SUBWAY_FEEDS)
    now = time.time()
    arrivals: list[dict[str, Any]] = []
    for feed in feeds:
        live = _feed_from_live(feed)
        if not live:
            continue
        for tu in live.get("trip_updates", []):
            for s in tu["stops"]:
                parent = st["child2parent"].get(s["stop_id"], s["stop_id"])
                if parent != station_id:
                    continue
                t = s["arrival"] or s["departure"]
                if t is None or t < now - 30:
                    continue
                direction = "N" if s["stop_id"].endswith("N") else ("S" if s["stop_id"].endswith("S") else "")
                arrivals.append(
                    {
                        "route": tu["route_id"],
                        "trip_id": tu["trip_id"],
                        "direction": direction,
                        "eta_seconds": int(t - now),
                    }
                )
    arrivals.sort(key=lambda a: a["eta_seconds"])
    name = st["stations"].get(station_id, {}).get("name")
    return {"station_id": station_id, "station_name": name, "routes": routes, "arrivals": arrivals[:16]}
