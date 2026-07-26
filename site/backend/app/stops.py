"""Stop cards + distance ALONG the bus route (W11 stage 2).

Two endpoints, both `fetch-on-click, never eagerly`:

  GET /api/stops/card?stop_id=…[&routes=…]   everything we honestly hold about one stop
  GET /api/stops/along?stops=a,b,c[&routes=…] distance along the route between consecutive
                                             stops, per (route, direction), never averaged

WHY THIS IS SERVER-SIDE
-----------------------
Projecting a stop onto a route shape needs the full shape geometry. Doing it in the
browser would force route geometry into memory *for measurement* rather than for drawing —
the opposite of what a page whose freeze was a rendering-cost problem should do. Here it is
one cheap request per selection change and the client holds nothing (W13.2).

WHAT THE ALONG-ROUTE NUMBER ACTUALLY IS
---------------------------------------
`realtime/derive2/cache/stop_offsets.parquet` already carries, for every (shape, stop), the
cumulative distance of that stop from the start of the shape in **EPSG:2263 US survey
feet** — the same measurement space live vehicle offsets use, produced by projecting each
stop onto the shape with `line_locate_point`. 36,895 rows, and it covers **683 of the 683
canonical (route, direction) shapes with no gaps**. So the distance a bus travels between
two stops is a subtraction of two floats we already have. Nothing is estimated here.

THREE HONESTY RULES, ENFORCED IN CODE
-------------------------------------
1. **Per direction, always. Never averaged across directions.** Service is not symmetric,
   and a mean of the two directions is a number that describes no bus. Every row this
   module returns is keyed by (route_id, direction_id).
2. **Never present one distance as another.** If two stops share no route, or the user
   picked them against the direction of travel, the response says so in words and returns
   no along-route figure. The caller renders that sentence instead of a number.
3. **Static geometry only.** Nothing here reads a live vehicle position. Stop coordinates
   are good to ~0.4 ft; the live feed's floor is ~160–200 ft. Mixing them would import a
   400–600x error into an otherwise exact number.
"""
from __future__ import annotations

import time
from functools import lru_cache
from typing import Any

import duckdb
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from . import config
from .obs import _archive_meta, _cache_file, _part_files, _qualifying_dates

router = APIRouter(prefix="/api/stops", tags=["stops"])

# Rounded to the nearest 10 ft everywhere it is presented, for the same reason the client
# does: a GTFS stop coordinate is one surveyed point standing for a ~40 ft kerbside zone.
ROUND_FT = 10

# Minimum observed gaps in an hour cell before that hour may be named the "worst hour"
# (mirrors autostats' MIN_HOUR_HEADWAYS). Below this the callout is null, not invented.
MIN_WORST_HOUR_N = 20

_ttl: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: float, fn):
    now = time.time()
    hit = _ttl.get(key)
    if hit is not None and (now - hit[0]) < ttl:
        return hit[1]
    val = fn()
    _ttl[key] = (now, val)
    return val


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    return con


def _q(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _plist(paths: list[str]) -> str:
    return "[" + ",".join(_q(p) for p in paths) + "]"


def _round10(v: float | None) -> float | None:
    return None if v is None else round(v / ROUND_FT) * ROUND_FT


# --------------------------------------------------------------------------- #
# shape -> (route, direction, headsign): built once, cached for the process
# --------------------------------------------------------------------------- #
BUS_FEEDS = (
    "gtfs_bus_bronx",
    "gtfs_bus_brooklyn",
    "gtfs_bus_manhattan",
    "gtfs_bus_queens",
    "gtfs_bus_staten_island",
    "gtfs_bus_mta_bus_company",
)


@lru_cache(maxsize=1)
def _shape_index() -> dict[str, dict[str, Any]]:
    """shape_id -> {route_id, direction_id, headsign, n_trips}.

    The headsign is the one riders read on the front of the bus, so it is the right label
    for a direction: "Along the Bx12, toward FORDHAM PLAZA" is a planner's sentence where
    "direction_id = 0" is not. Built from the GTFS `trips.txt` of all six bus feeds, taking
    the most-used headsign per shape. Falls back to derive2's `trip_meta` (which carries
    route/direction but no headsign) for any shape the feeds do not describe.
    """
    out: dict[str, dict[str, Any]] = {}
    con = _con()
    try:
        for feed in BUS_FEEDS:
            trips = config.GTFS_STATIC_ROOT / feed / "gtfs" / "trips.txt"
            if not trips.exists():
                continue
            rows = con.execute(
                f"""
                SELECT shape_id, route_id, CAST(direction_id AS INTEGER) AS d,
                       any_value(trip_headsign) AS headsign, count(*) AS n
                FROM read_csv_auto({_q(trips.as_posix())}, header=true, all_varchar=true)
                WHERE shape_id IS NOT NULL AND shape_id <> ''
                GROUP BY shape_id, route_id, d
                """
            ).fetchall()
            for shape_id, route_id, d, headsign, n in rows:
                cur = out.get(shape_id)
                if cur is None or int(n) > cur["n_trips"]:
                    out[shape_id] = {
                        "route_id": route_id,
                        "direction_id": int(d) if d is not None else None,
                        "headsign": (headsign or "").strip() or None,
                        "n_trips": int(n),
                    }
    finally:
        con.close()
    return out


def _tidy(s: str) -> str:
    """GTFS headsigns and stop names are shouted ALL CAPS. Title-case them for a card,
    but leave the connective words lower ("Inwood Bway-207 St via Pelham") — this is the
    real headsign a rider reads, abbreviations and all, not a rewrite of it."""
    t = s.title()
    for w in (" Via ", " And ", " To ", " At "):
        t = t.replace(w, w.lower())
    return t


def _direction_label(shape_id: str, terminal_name: str | None) -> str | None:
    info = _shape_index().get(shape_id)
    if info and info.get("headsign"):
        return "toward " + _tidy(str(info["headsign"]))
    if terminal_name:
        return "toward " + _tidy(terminal_name)
    return None


# --------------------------------------------------------------------------- #
# stop offsets
# --------------------------------------------------------------------------- #
def _offsets_for(con, stop_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """stop_id -> [{shape_id, stop_seq, offset_ft}] over every shape that serves it."""
    if not stop_ids:
        return {}
    ids = ",".join(_q(s) for s in stop_ids)
    rows = con.execute(
        f"""SELECT stop_id, shape_id, stop_seq, stop_offset_ft
            FROM read_parquet({_q(_cache_file("stop_offsets"))})
            WHERE stop_id IN ({ids})"""
    ).fetchall()
    out: dict[str, list[dict[str, Any]]] = {}
    for stop_id, shape_id, seq, off in rows:
        out.setdefault(stop_id, []).append(
            {"shape_id": shape_id, "stop_seq": int(seq) if seq is not None else None,
             "offset_ft": float(off)}
        )
    return out


@lru_cache(maxsize=4096)
def _terminal_name(shape_id: str) -> str | None:
    """Last stop on a shape — the fallback direction label when GTFS has no headsign.
    Cached: it is static per feed vintage, and an uncached call per candidate was
    measured at ~0.5 s for a three-stop chain."""
    con = _con()
    try:
        row = con.execute(
            f"""SELECT s.stop_name
                FROM read_parquet({_q(_cache_file("stop_offsets"))}) so
                LEFT JOIN read_parquet({_q(_cache_file("stops"))}) s ON s.stop_id = so.stop_id
                WHERE so.shape_id = ? ORDER BY so.stop_offset_ft DESC LIMIT 1""",
            [shape_id],
        ).fetchone()
    finally:
        con.close()
    return row[0] if row and row[0] else None


def _stop_names(con, stop_ids: list[str]) -> dict[str, str]:
    if not stop_ids:
        return {}
    ids = ",".join(_q(s) for s in stop_ids)
    rows = con.execute(
        f"""SELECT stop_id, stop_name FROM read_parquet({_q(_cache_file("stops"))})
            WHERE stop_id IN ({ids})"""
    ).fetchall()
    return {r[0]: r[1] for r in rows}


# --------------------------------------------------------------------------- #
# /api/stops/along
# --------------------------------------------------------------------------- #
DirKey = tuple  # (route_id, direction_id)


def _leg_candidates(a: str, b: str, offs: dict, routes: set[str] | None
                    ) -> tuple[dict[DirKey, dict[str, Any]], dict[DirKey, dict[str, Any]]]:
    """(forward, backward) candidates for one consecutive pair, keyed by
    (route_id, direction_id) — the grain everything downstream is reported at.

    A route can have several shape variants (BX12 alone has short-turns and an SBS
    variant); we keep the busiest shape per (route, direction), because that is the one a
    planner means when they say "the Bx12".
    """
    sa = {o["shape_id"]: o for o in offs.get(a, [])}
    sb = {o["shape_id"]: o for o in offs.get(b, [])}
    fwd: dict[DirKey, dict[str, Any]] = {}
    bwd: dict[DirKey, dict[str, Any]] = {}
    for shape_id in sorted(set(sa) & set(sb)):
        info = _shape_index().get(shape_id) or {}
        route_id = info.get("route_id")
        if route_id is None:
            continue
        if routes is not None and route_id not in routes:
            continue
        key = (route_id, info.get("direction_id"))
        d = sb[shape_id]["offset_ft"] - sa[shape_id]["offset_ft"]
        seq_a, seq_b = sa[shape_id]["stop_seq"], sb[shape_id]["stop_seq"]
        cand = {
            "route_id": route_id,
            "direction_id": info.get("direction_id"),
            "shape_id": shape_id,
            "along_ft": _round10(abs(d)),
            "stops_between": (abs(seq_b - seq_a) if seq_a is not None and seq_b is not None
                              else None),
            "n_trips": int(info.get("n_trips", 0)),
        }
        bucket = fwd if d > 0 else bwd
        cur = bucket.get(key)
        if cur is None or cand["n_trips"] > cur["n_trips"]:
            bucket[key] = cand
    return fwd, bwd


def _label(c: dict[str, Any]) -> dict[str, Any]:
    c = dict(c)
    c["direction_label"] = _direction_label(c["shape_id"], _terminal_name(c["shape_id"]))
    c.pop("n_trips", None)
    return c


def _along_payload(stop_ids: list[str], routes: set[str] | None) -> dict[str, Any]:
    t0 = time.time()
    con = _con()
    try:
        offs = _offsets_for(con, stop_ids)
        names = _stop_names(con, stop_ids)
    finally:
        con.close()

    pairs = [(stop_ids[i - 1], stop_ids[i]) for i in range(1, len(stop_ids))]
    cands = [_leg_candidates(a, b, offs, routes) for a, b in pairs]

    # THE HEADLINE RULE. "Along the route" may lead ONLY when one (route, direction)
    # carries a bus across EVERY leg in the chain, in the direction the stops were picked.
    # A chain that changes route has no along-route distance — summing two routes' offsets
    # would be a number nothing travels — and one picked against the direction of travel is
    # reported as exactly that, never silently flipped.
    common: set[DirKey] = set(cands[0][0]) if cands else set()
    for f, _ in cands[1:]:
        common &= set(f)
    chain_key: DirKey | None = None
    if common:
        chain_key = max(common, key=lambda k: sum(f[k]["n_trips"] for f, _ in cands))

    legs: list[dict[str, Any]] = []
    for (a, b), (fwd, bwd) in zip(pairs, cands):
        base = {"from_stop": a, "to_stop": b, "from_name": names.get(a), "to_name": names.get(b)}
        if chain_key is not None:
            legs.append({**base, **_label(fwd[chain_key]), "note": None})
            continue
        if fwd:
            best = max(fwd.values(), key=lambda c: c["n_trips"])
            legs.append({**base, **_label(best),
                         "note": "this leg is on a different route from the others"
                                 if len(pairs) > 1 else None})
            continue
        if bwd:
            alt = _label(max(bwd.values(), key=lambda c: c["n_trips"]))
            legs.append({
                **base, "along_ft": None, "route_id": alt["route_id"],
                "direction_id": alt["direction_id"], "direction_label": alt["direction_label"],
                "shape_id": alt["shape_id"], "stops_between": alt["stops_between"],
                "opposite_direction_ft": alt["along_ft"],
                "note": (f"these stops are on the {alt['route_id']} but in the opposite "
                         f"direction — the bus travels {alt['along_ft']:,.0f} ft "
                         f"{alt['direction_label'] or 'the other way'}"),
            })
            continue
        legs.append({**base, "along_ft": None, "route_id": None, "direction_id": None,
                     "direction_label": None, "shape_id": None, "stops_between": None,
                     "note": "these two stops are not both on any one bus route"})

    if chain_key is not None:
        total = _round10(sum(lg["along_ft"] for lg in legs))
        head = legs[0]
        return {
            "stops": stop_ids, "stop_names": names, "legs": legs,
            "total_along_ft": total,
            "route_id": chain_key[0], "direction_id": chain_key[1],
            "direction_label": head.get("direction_label"),
            "note": None,
            "basis": _BASIS, "rounding_ft": ROUND_FT,
            "elapsed_ms": round((time.time() - t0) * 1000, 1),
        }

    # The whole chain runs the other way: one route and direction carries a bus across
    # every leg, but from the last stop to the first. That is a real, useful answer — so
    # offer it, labelled as the opposite direction, rather than silently flipping the sign.
    common_bwd: set[DirKey] = set(cands[0][1]) if cands else set()
    for _, bk in cands[1:]:
        common_bwd &= set(bk)
    opposite_total = None
    opposite_key: DirKey | None = None
    if common_bwd:
        opposite_key = max(common_bwd, key=lambda k: sum(bk[k]["n_trips"] for _, bk in cands))
        opposite_total = _round10(sum(bk[opposite_key]["along_ft"] for _, bk in cands))

    if not pairs:
        note = "add a second stop to measure along a route"
    elif opposite_key is not None:
        lbl = _direction_label(cands[0][1][opposite_key]["shape_id"],
                               _terminal_name(cands[0][1][opposite_key]["shape_id"]))
        note = (f"you picked these against the direction of travel — the {opposite_key[0]} "
                f"runs {opposite_total:,.0f} ft {lbl or 'the other way'}")
    elif any(lg.get("opposite_direction_ft") for lg in legs):
        note = next(lg["note"] for lg in legs if lg.get("opposite_direction_ft"))
    elif any(lg["along_ft"] is not None for lg in legs):
        note = "these stops aren't all on one route, so there is no single along-route distance"
    else:
        note = "these stops aren't all on one route"
    return {
        "stops": stop_ids, "stop_names": names, "legs": legs,
        "total_along_ft": None, "route_id": None, "direction_id": None,
        "direction_label": None, "note": note,
        "opposite_direction_total_ft": opposite_total,
        "opposite_route_id": opposite_key[0] if opposite_key else None,
        "opposite_direction_id": opposite_key[1] if opposite_key else None,
        "basis": _BASIS, "rounding_ft": ROUND_FT,
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


_BASIS = ("static GTFS stop positions projected onto the route shape (EPSG:2263, US survey "
          "feet); never derived from live vehicle positions")


@router.get("/along")
async def stops_along(stops: str, routes: str | None = None) -> JSONResponse:
    ids = [s.strip() for s in stops.split(",") if s.strip()][:12]
    if len(ids) < 2:
        return JSONResponse({"error": "pass at least two stop ids"}, status_code=400)
    rset = {r.strip() for r in routes.split(",") if r.strip()} if routes else None
    key = f"along|{','.join(ids)}|{routes or ''}"
    # The key space is finite and static per feed vintage, so this caches extremely well.
    return JSONResponse(_cached(key, 900, lambda: _along_payload(ids, rset)))


# --------------------------------------------------------------------------- #
# /api/stops/card
# --------------------------------------------------------------------------- #
# Fields the six NYC bus GTFS feeds simply do not publish. Named here, with the reason,
# so the card can render `not captured` with an explanation rather than an empty cell —
# a planner has to be able to tell "none" from "unknown".
NOT_CAPTURED = {
    "stop_code": ("the NYC bus feeds publish no stop_code column; the stop_id shown IS the "
                  "code riders text and BusTime uses"),
    "wheelchair_boarding": "the NYC bus feeds publish no wheelchair_boarding column",
    "stop ridership": "MTA publishes bus ridership by route, not by stop",
    "shelter dimensions": "the stop inventory records shelter presence, not size",
}


def _sai_for(con, stop_id: str) -> dict[str, Any] | None:
    path = config.RENTERS_SAI
    if not path.exists():
        return None
    # NOTE ON THE POPULATION FIELD. `sai_scores` carries BOTH `pop_400m` (people, a
    # count — median 7,771 citywide) and `walkshed_population` (that count rescaled to a
    # 0-100 subscore that feeds the index). They are not the same quantity and the
    # subscore looks like a plausible headcount at a glance, so the card reads the RAW
    # count and says "people". Showing 95 under "people within 400 m" would have been a
    # silently wrong number.
    row = con.execute(
        f"""SELECT sai, sai_pctile, shelter_100ft, ramps_150ft, sidewalk_sqft_400m,
                   pop_400m, jobs_400m, safety, comfort, borough
            FROM read_parquet({_q(path.as_posix())})
            WHERE CAST(stop_id AS VARCHAR) = ? LIMIT 1""",
        [stop_id],
    ).fetchone()
    if not row:
        return None
    return {
        "sai": row[0], "sai_pctile": row[1],
        "sheltered": None if row[2] is None else bool(row[2] > 0),
        "ramps_150ft": row[3], "sidewalk_sqft_400m": row[4],
        "people_400m": row[5], "jobs_400m": row[6],
        "safety": row[7], "comfort": row[8],
        "borough": row[9],
    }


def _service_rows(con, stop_id: str, dates: list[str]) -> list[dict[str, Any]]:
    """One row per (route, direction) observed at this stop — NEVER pooled across
    directions. Also carries the worst hour, which is one number with high signal."""
    files = _part_files("observed_headways", dates, stem="part-000")
    if not files:
        return []
    # `MIN_WORST_HOUR_N` mirrors autostats' MIN_HOUR_HEADWAYS: a "worst hour" chosen from
    # a 2 a.m. cell holding three observed gaps is noise wearing the clothes of a finding.
    # Hours below the bar still count toward the stop's totals; they just cannot win the
    # worst-hour callout, and if no hour clears the bar the callout is null (rendered
    # `not captured`) rather than invented.
    rows = con.execute(
        f"""
        WITH h AS (
            SELECT route_id, direction_id, local_hour,
                   median(median_headway_s)       AS obs_s,
                   median(sched_median_headway_s) AS sch_s,
                   median(bunching_index)         AS bunch,
                   median(headway_deviation_s)    AS dev_s,
                   sum(n_headways)                AS n,
                   count(DISTINCT local_date)     AS days,
                   bool_or(preliminary)           AS prelim
            FROM read_parquet({_plist(files)})
            WHERE stop_id = ?
            GROUP BY route_id, direction_id, local_hour
        )
        SELECT route_id, direction_id,
               median(obs_s), median(sch_s), median(bunch), sum(n), max(days),
               bool_or(prelim),
               arg_max(CASE WHEN n >= {MIN_WORST_HOUR_N} THEN local_hour END,
                       CASE WHEN n >= {MIN_WORST_HOUR_N} THEN coalesce(dev_s, -1e9) END),
               max(CASE WHEN n >= {MIN_WORST_HOUR_N} THEN dev_s END)
        FROM h GROUP BY route_id, direction_id
        """,
        [stop_id],
    ).fetchall()
    out = []
    for r in rows:
        out.append({
            "route_id": r[0],
            "direction_id": int(r[1]) if r[1] is not None else None,
            "observed_headway_min": round(r[2] / 60.0, 1) if r[2] is not None else None,
            "scheduled_headway_min": round(r[3] / 60.0, 1) if r[3] is not None else None,
            "bunching_index": round(r[4], 2) if r[4] is not None else None,
            "n_headways": int(r[5]) if r[5] is not None else None,
            "observed_days": int(r[6]) if r[6] is not None else None,
            "preliminary": bool(r[7]),
            "worst_hour": int(r[8]) if r[8] is not None else None,
            "worst_hour_deviation_min": round(r[9] / 60.0, 1) if r[9] is not None else None,
        })
    return out


def _spacing_rows(con, stop_id: str, routes: set[str] | None) -> list[dict[str, Any]]:
    """Per (route, direction): where this stop sits on the shape, and the gap to the stop
    before and after it. Stop spacing along the corridor is the single most-asked planning
    number, and it falls straight out of the same offsets."""
    mine = con.execute(
        f"""SELECT shape_id, stop_seq, stop_offset_ft
            FROM read_parquet({_q(_cache_file("stop_offsets"))}) WHERE stop_id = ?""",
        [stop_id],
    ).fetchall()
    # ONE row per (route, direction), not per shape variant. A route can have half a dozen
    # shapes (short-turns, an SBS variant, a Sunday pattern) and they share one observed
    # headway series — emitting a row each would repeat the same number under several
    # different headsigns and read as if it were per-variant evidence. Keep the busiest.
    best_shape: dict[DirKey, tuple[str, int, Any, Any]] = {}
    for shape_id, seq, off in mine:
        info = _shape_index().get(shape_id) or {}
        rid = info.get("route_id")
        if rid is None or (routes is not None and rid not in routes):
            continue
        key = (rid, info.get("direction_id"))
        n = int(info.get("n_trips", 0))
        if key not in best_shape or n > best_shape[key][1]:
            best_shape[key] = (shape_id, n, seq, off)

    out = []
    for (route_id, _dir), (shape_id, _n, seq, off) in best_shape.items():
        info = _shape_index().get(shape_id) or {}
        nbr = con.execute(
            f"""SELECT so.stop_id, s.stop_name, so.stop_offset_ft
                FROM read_parquet({_q(_cache_file("stop_offsets"))}) so
                LEFT JOIN read_parquet({_q(_cache_file("stops"))}) s ON s.stop_id = so.stop_id
                WHERE so.shape_id = ? ORDER BY so.stop_offset_ft""",
            [shape_id],
        ).fetchall()
        idx = next((i for i, n in enumerate(nbr) if n[0] == stop_id), None)
        prev_n = nbr[idx - 1] if idx is not None and idx > 0 else None
        next_n = nbr[idx + 1] if idx is not None and idx + 1 < len(nbr) else None
        out.append({
            "route_id": route_id,
            "direction_id": info.get("direction_id"),
            "direction_label": _direction_label(shape_id, nbr[-1][1] if nbr else None),
            "shape_id": shape_id,
            "stop_seq": int(seq) if seq is not None else None,
            "offset_ft": _round10(float(off)),
            "prev_stop_name": prev_n[1] if prev_n else None,
            "prev_spacing_ft": _round10(float(off) - float(prev_n[2])) if prev_n else None,
            "next_stop_name": next_n[1] if next_n else None,
            "next_spacing_ft": _round10(float(next_n[2]) - float(off)) if next_n else None,
        })
    # deterministic, and the busiest shape first
    out.sort(key=lambda r: (str(r["route_id"] or ""), r["direction_id"] if r["direction_id"] is not None else 9))
    return out[:8]


def _card_payload(stop_id: str, routes: set[str] | None) -> dict[str, Any]:
    t0 = time.time()
    dates = _qualifying_dates()
    con = _con()
    try:
        names = _stop_names(con, [stop_id])
        spacing = _spacing_rows(con, stop_id, routes)
        service = {(s["route_id"], s["direction_id"]): s for s in _service_rows(con, stop_id, dates)}
        sai = _sai_for(con, stop_id)
    finally:
        con.close()

    directions = []
    for sp in spacing:
        svc = service.get((sp["route_id"], sp["direction_id"]), {})
        row = dict(sp)
        row.update({
            "observed_headway_min": svc.get("observed_headway_min"),
            "scheduled_headway_min": svc.get("scheduled_headway_min"),
            "headway_deviation_min": (
                round(svc["observed_headway_min"] - svc["scheduled_headway_min"], 1)
                if svc.get("observed_headway_min") is not None
                and svc.get("scheduled_headway_min") is not None else None),
            "bunching_index": svc.get("bunching_index"),
            "worst_hour": svc.get("worst_hour"),
            "worst_hour_deviation_min": svc.get("worst_hour_deviation_min"),
            "n_headways": svc.get("n_headways"),
            "observed_days": svc.get("observed_days"),
            "preliminary": svc.get("preliminary"),
        })
        row.pop("shape_id", None)
        directions.append(row)

    # The full archive block is ~2 KB of depth accounting and belongs on the pages that
    # publish reliability rankings. A stop card needs the honest headline — how many
    # observed days stand behind the numbers, whether they are preliminary, and the known
    # gap — so it carries those and links the rest by implication.
    arch = _archive_meta(dates)
    return {
        "stop_id": stop_id,
        "stop_name": names.get(stop_id),
        "borough": (sai or {}).get("borough"),
        "directions": directions,
        "sai": sai,
        "wheelchair_boarding": None,
        "active_changes": None,
        "not_captured": NOT_CAPTURED,
        "archive_depth_days": arch.get("archive_depth_days"),
        "preliminary": arch.get("preliminary"),
        "gap_note": arch.get("gap_note"),
        "as_of": dates[-1] if dates else None,
        "rounding_ft": ROUND_FT,
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/card")
async def stop_card(stop_id: str, routes: str | None = None) -> JSONResponse:
    rset = {r.strip() for r in routes.split(",") if r.strip()} if routes else None
    key = f"card|{stop_id}|{routes or ''}"
    return JSONResponse(_cached(key, 600, lambda: _card_payload(stop_id, rset)))


# =========================================================================== #
# W11 STAGE 3 — walking distance, and the selection leaving the browser
# =========================================================================== #
import asyncio  # noqa: E402
import io  # noqa: E402
import math  # noqa: E402

from fastapi import Response  # noqa: E402

from . import isochrone  # noqa: E402  (reuses its OTPUnavailable honesty contract)


@lru_cache(maxsize=1)
def _stop_coords() -> dict[str, tuple[float, float]]:
    """stop_id -> (lat, lon), from the six bus feeds' GTFS `stops.txt`.

    Needed because derive2's `stops.parquet` carries names only. Built once; the stop set
    is finite and static per feed vintage.
    """
    out: dict[str, tuple[float, float]] = {}
    con = _con()
    try:
        for feed in BUS_FEEDS:
            f = config.GTFS_STATIC_ROOT / feed / "gtfs" / "stops.txt"
            if not f.exists():
                continue
            rows = con.execute(
                f"""SELECT stop_id, CAST(TRIM(stop_lat) AS DOUBLE), CAST(TRIM(stop_lon) AS DOUBLE)
                    FROM read_csv_auto({_q(f.as_posix())}, header=true, all_varchar=true)"""
            ).fetchall()
            for sid, lat, lon in rows:
                if sid not in out and lat is not None and lon is not None:
                    out[sid] = (float(lat), float(lon))
    finally:
        con.close()
    return out


def _straight_ft(a: tuple[float, float], b: tuple[float, float]) -> float:
    """The same local-radius WGS84 reduction the client uses, so the two never disagree.
    A spherical haversine would be off by up to ~0.3 % — 22 ft on a 7,500 ft leg, which
    is worse than the data these numbers are computed from."""
    rad = math.pi / 180.0
    A, E2 = 6378137.0, 0.00669437999014
    phi = ((a[0] + b[0]) / 2) * rad
    s = math.sin(phi)
    w2 = 1 - E2 * s * s
    w = math.sqrt(w2)
    n_rad = A / w
    m_rad = (A * (1 - E2)) / (w2 * w)
    dy = m_rad * (b[0] - a[0]) * rad
    dx = n_rad * math.cos(phi) * (b[1] - a[1]) * rad
    return math.hypot(dx, dy) / 0.3048


def _otp_walk(a: tuple[float, float], b: tuple[float, float]) -> dict[str, Any]:
    """One WALK itinerary from OpenTripPlanner. Raises OTPUnavailable on ANY failure.

    The honesty contract is `isochrone.py`'s, deliberately reused: on failure the caller
    returns 503 and the UI says walking is unavailable. It NEVER falls back to the
    straight-line figure wearing a walking label — a walking distance that is secretly a
    crow-flies distance is the single worst thing this feature could ship.
    """
    if not config.OTP_URL:
        raise isochrone.OTPUnavailable(
            "the routing engine is not configured on this deployment")
    import httpx

    url = f"{config.OTP_URL}/otp/routers/default/plan"
    params = {
        "fromPlace": f"{a[0]},{a[1]}",
        "toPlace": f"{b[0]},{b[1]}",
        "mode": "WALK",
        "arriveBy": "false",
        "numItineraries": 1,
    }
    try:
        r = httpx.get(url, params=params, timeout=config.OTP_TIMEOUT_S)
    except Exception as e:
        raise isochrone.OTPUnavailable(f"routing engine unreachable: {e}") from e
    if r.status_code != 200:
        raise isochrone.OTPUnavailable(f"routing engine returned HTTP {r.status_code}")
    try:
        j = r.json()
    except Exception as e:
        raise isochrone.OTPUnavailable(f"routing engine returned non-JSON: {e}") from e
    its = ((j.get("plan") or {}).get("itineraries") or [])
    if not its:
        raise isochrone.OTPUnavailable(
            "the routing engine found no walking route between these two points")
    it = its[0]
    metres = float(it.get("walkDistance") or 0.0)
    seconds = float(it.get("duration") or 0.0)
    streets: list[str] = []
    for leg in it.get("legs", []):
        for st in (leg.get("steps") or []):
            name = (st.get("streetName") or "").strip()
            if name and name not in streets:
                streets.append(name)
    return {
        "walk_ft": _round10(metres / 0.3048),
        "walk_minutes": round(seconds / 60.0, 1),
        "streets": streets[:8],
        "engine": "OpenTripPlanner",
        "basis": ("routed over the OpenStreetMap pedestrian network (sidewalks, paths and "
                  "steps); accuracy is OSM's sidewalk completeness, not ours"),
    }


@router.get("/walk")
async def stops_walk(from_stop: str, to_stop: str) -> JSONResponse:
    """Walking distance between two stops. An EXPLICIT per-leg action, never automatic:
    it is a server round-trip and a planner asks for it deliberately."""
    coords = _stop_coords()
    a, b = coords.get(from_stop), coords.get(to_stop)
    if a is None or b is None:
        missing = from_stop if a is None else to_stop
        return JSONResponse(
            {"error": f"no coordinates on file for stop {missing}"}, status_code=404)
    key = f"walk|{from_stop}|{to_stop}"
    hit = _ttl.get(key)
    if hit is not None and (time.time() - hit[0]) < 86400:
        return JSONResponse(hit[1])
    try:
        data = await asyncio.to_thread(_otp_walk, a, b)
    except isochrone.OTPUnavailable as e:
        return JSONResponse(
            {"error": "Walking distance is unavailable right now — this endpoint never "
                      "substitutes a straight-line distance for a walked one.",
             "detail": str(e)},
            status_code=503,
        )
    data.update({"from_stop": from_stop, "to_stop": to_stop,
                 "straight_ft": _round10(_straight_ft(a, b))})
    # Stop pairs are a finite, static key space, so this caches far better than an
    # isochrone origin does.
    _ttl[key] = (time.time(), data)
    return JSONResponse(data)


# --------------------------------------------------------------------------- #
# /api/stops/export — the selection leaves the browser
# --------------------------------------------------------------------------- #
def _provenance(dates: list[str]) -> list[str]:
    arch = _archive_meta(dates)
    return [
        "NYC Visualizer — Planner Workstation stop selection",
        f"generated {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        "sources: GTFS static (stop identity, sequence, headsign, spacing) · our own "
        "observed-headway archive (gap, bunching, worst hour) · Stop Accessibility Index "
        "(shelter, ramps, sidewalk, population, jobs)",
        f"observed archive depth: {arch.get('archive_depth_days')} qualifying service "
        f"day(s), through {dates[-1] if dates else 'n/a'}"
        + (" — PRELIMINARY (under 14 days)" if arch.get("preliminary") else ""),
        f"gap note: {arch.get('gap_note')}",
        "distances: measured between SURVEYED STOP POSITIONS, never from live vehicle "
        "positions; geodesic (WGS84 local radius), rounded to the nearest 10 ft because a "
        "stop coordinate is one surveyed point for a ~40 ft kerbside zone",
        "along-route distance is per (route, direction) and is NEVER averaged across "
        "directions; it is blank wherever two stops do not share one route and direction",
        "blank cells are NOT zero. The NYC bus feeds publish no stop_code (the stop_id IS "
        "the code riders text and BusTime uses), no wheelchair_boarding, and no "
        "stop-level ridership.",
    ]


def _export_tables(stop_ids: list[str], routes: set[str] | None):
    """(stop rows, pair rows, provenance lines).

    ONE ROW PER STOP PER DIRECTION — never one row per stop with the two directions
    averaged together. Service is not symmetric and the average describes no bus.
    """
    dates = _qualifying_dates()
    coords = _stop_coords()
    stop_rows: list[dict[str, Any]] = []
    for sid in stop_ids:
        card = _card_payload(sid, routes)
        latlon = coords.get(sid)
        base = {
            "stop_id": sid,
            "stop_name": card.get("stop_name"),
            "borough": card.get("borough"),
            "lat": latlon[0] if latlon else None,
            "lon": latlon[1] if latlon else None,
        }
        sai = card.get("sai") or {}
        env = {
            "sai": sai.get("sai"), "sai_pctile": sai.get("sai_pctile"),
            "sheltered": sai.get("sheltered"), "curb_ramps_150ft": sai.get("ramps_150ft"),
            "sidewalk_sqft_400m": sai.get("sidewalk_sqft_400m"),
            "people_400m": sai.get("people_400m"), "jobs_400m": sai.get("jobs_400m"),
            "archive_depth_days": card.get("archive_depth_days"),
            "preliminary": card.get("preliminary"),
        }
        blank = {
            "stop_sequence": None, "offset_along_route_ft": None, "prev_stop": None,
            "spacing_from_prev_ft": None, "next_stop": None, "spacing_to_next_ft": None,
            "observed_gap_min": None, "scheduled_gap_min": None, "gap_deviation_min": None,
            "bunching_index": None, "worst_hour_local": None,
            "worst_hour_gap_deviation_min": None, "observed_gaps_n": None,
            "observed_days": None,
        }
        if not card.get("directions"):
            stop_rows.append({**base, "route_id": None, "direction_id": None,
                              "direction": None, **blank, **env})
            continue
        for d in card["directions"]:
            stop_rows.append({
                **base,
                "route_id": d.get("route_id"),
                "direction_id": d.get("direction_id"),
                "direction": d.get("direction_label"),
                "stop_sequence": d.get("stop_seq"),
                "offset_along_route_ft": d.get("offset_ft"),
                "prev_stop": d.get("prev_stop_name"),
                "spacing_from_prev_ft": d.get("prev_spacing_ft"),
                "next_stop": d.get("next_stop_name"),
                "spacing_to_next_ft": d.get("next_spacing_ft"),
                "observed_gap_min": d.get("observed_headway_min"),
                "scheduled_gap_min": d.get("scheduled_headway_min"),
                "gap_deviation_min": d.get("headway_deviation_min"),
                "bunching_index": d.get("bunching_index"),
                "worst_hour_local": d.get("worst_hour"),
                "worst_hour_gap_deviation_min": d.get("worst_hour_deviation_min"),
                "observed_gaps_n": d.get("n_headways"),
                "observed_days": d.get("observed_days"),
                **env,
            })

    # EVERY pair, not just consecutive ones — with several stops selected the planner's
    # question is usually "how far is each of these from each of the others".
    con = _con()
    try:
        offs = _offsets_for(con, stop_ids)
    finally:
        con.close()
    pair_rows: list[dict[str, Any]] = []
    for i, a in enumerate(stop_ids):
        for b in stop_ids[i + 1:]:
            ca, cb = coords.get(a), coords.get(b)
            fwd, _bwd = _leg_candidates(a, b, offs, routes)
            best = max(fwd.values(), key=lambda c: c["n_trips"]) if fwd else None
            lbl = _label(best) if best else None
            pair_rows.append({
                "from_stop_id": a,
                "from_stop_name": next((r["stop_name"] for r in stop_rows
                                        if r["stop_id"] == a), None),
                "to_stop_id": b,
                "to_stop_name": next((r["stop_name"] for r in stop_rows
                                      if r["stop_id"] == b), None),
                "straight_line_ft": _round10(_straight_ft(ca, cb)) if ca and cb else None,
                "along_route_ft": lbl["along_ft"] if lbl else None,
                "along_route_id": lbl["route_id"] if lbl else None,
                "along_direction": lbl["direction_label"] if lbl else None,
                "stops_between": lbl["stops_between"] if lbl else None,
                "along_route_note": None if lbl else (
                    "these two stops do not share one route in this direction"),
            })
    return stop_rows, pair_rows, _provenance(dates)


def _csv_bytes(rows: list[dict], prov: list[str]) -> bytes:
    import csv as _csv

    buf = io.StringIO()
    for line in prov:
        buf.write("# " + line + "\n")
    if rows:
        cols = list(rows[0].keys())
        w = _csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in cols})
    return buf.getvalue().encode("utf-8")


@router.get("/export")
async def stops_export(
    stops: str,
    format: str = "csv",
    routes: str | None = None,
    table: str = "stops",
):
    """CSV / XLSX / Parquet of the selected stops. **No JSON** — that is this estate's
    download standard, and a JSON download is not a table a planner can open.

    Assembled SERVER-SIDE so collecting forty stops costs the browser nothing, and
    carrying its own provenance, because an exported table outlives the page that made it.
    """
    ids = [s.strip() for s in stops.split(",") if s.strip()][:40]
    if not ids:
        return JSONResponse({"error": "pass at least one stop id"}, status_code=400)
    if format not in ("csv", "xlsx", "parquet", "clipboard"):
        return JSONResponse(
            {"error": "format must be csv, xlsx or parquet (JSON is deliberately not offered)"},
            status_code=400)
    rset = {r.strip() for r in routes.split(",") if r.strip()} if routes else None
    stop_rows, pair_rows, prov = await asyncio.to_thread(_export_tables, ids, rset)
    rows = pair_rows if table == "pairs" else stop_rows
    stamp = time.strftime("%Y%m%d_%H%M", time.gmtime())
    name = f"planner_stops_{stamp}"

    if format == "clipboard":
        # Tab-separated: what pastes cleanly into an email or a spreadsheet's cell grid.
        # A download is the wrong verb for three stops.
        lines = ["# " + p for p in prov]
        if rows:
            cols = list(rows[0].keys())
            lines.append("\t".join(cols))
            for r in rows:
                lines.append("\t".join("" if r.get(c) is None else str(r.get(c)) for c in cols))
        return Response("\n".join(lines), media_type="text/plain; charset=utf-8")

    if format == "csv":
        return Response(
            _csv_bytes(rows, prov),
            media_type="text/csv;charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})

    import pandas as pd

    if format == "parquet":
        import pyarrow as pa
        import pyarrow.parquet as pq

        tbl = pa.Table.from_pandas(pd.DataFrame(rows), preserve_index=False)
        # Provenance rides in the file's own key-value metadata, so it survives the file
        # being moved, renamed and reopened months later.
        md = dict(tbl.schema.metadata or {})
        md[b"nycvisualizer_provenance"] = "\n".join(prov).encode("utf-8")
        buf = io.BytesIO()
        pq.write_table(tbl.replace_schema_metadata(md), buf, compression="snappy")
        return Response(
            buf.getvalue(),
            media_type="application/vnd.apache.parquet",
            headers={"Content-Disposition": f'attachment; filename="{name}.parquet"'})

    # xlsx — both tables plus a readable provenance sheet, because a spreadsheet is the
    # one format where the caveats can travel beside the numbers instead of above them.
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="xlsxwriter") as xl:
        pd.DataFrame(stop_rows).to_excel(xl, sheet_name="Stops", index=False)
        pd.DataFrame(pair_rows).to_excel(xl, sheet_name="Distances", index=False)
        pd.DataFrame({"About this file": prov}).to_excel(
            xl, sheet_name="Provenance", index=False)
    return Response(
        buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}.xlsx"'})
