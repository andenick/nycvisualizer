"""Live Ops Wall (S6) — one aggregate endpoint that assembles the control-room view.

`/api/wall` returns a single JSON with three time horizons, each honestly stamped:

  now         — numbers computed LIVE, in-process, from the same realtime sources the
                map uses (`realtime.get_vehicles`, `subway.get_subway`) plus a live
                recompute of `scheduled_active` from the derive2 GTFS cache for the
                CURRENT 5-min local bin, a live bunching-pair scan over bus positions,
                and a live alert-severity tally from the freshest alert-feed poll.
  trailing3h  — the last 3h of derive2 KPI rollups (per 5-min bin: service_ratio,
                mean |headway deviation|, active bunching pairs, alert totals). The
                derive job refreshes hourly, so the last <=60 min of bins are missing
                from parquet; the response marks where parquet ends and the live NOW
                number takes over (the "splice"), never blending the two silently.
  archive     — the observatory archive-depth / preliminary block (reused from obs).

Zero new data: pure assembly of S2 rollups + existing endpoints. Cached 25 s.
`/api/wall/stream` pushes the same payload every ~30 s over SSE.

This module NEVER touches renters.py and adds exactly one include line to main.py.
"""
from __future__ import annotations

import asyncio
import glob
import html
import json
import math
import time
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import config, obs, realtime, subway
from .subwayColors_py import LINE_COLORS, TEXT_ON, line_label

router = APIRouter(prefix="/api/wall", tags=["opswall"])

# --- constants -------------------------------------------------------------
BIN_S = 300                       # 5-minute bins (matches derive2/kpis.py)
OFFSET_S = -config.NYC_UTC_OFFSET_S  # +14400: seconds to SUBTRACT from utc to get local
TRAIL_BINS = 36                   # 3h / 5min
BUNCH_PAIR_FRAC = 0.25            # a pair spaced < 25% of expected spacing = bunched
NOMINAL_BUS_MPS = 4.5             # ~16 km/h effective NYC bus speed incl. stops/lights
BUNCH_ABS_CAP_M = 500.0           # physical floor: "bunched" always = buses within 500 m
DEFAULT_SCHED_HEADWAY_S = 600.0   # fallback when a route has no observed headway
MAX_HOTSPOTS = 200                # cap markers for the small ops map
CACHE_TTL_S = 25

# GTFS-RT `effect` enum -> severity tier (mirror of derive2/_common.ALERT_SEVERITY;
# duplicated here so the web app has no import dependency on the derive2 package).
ALERT_SEVERITY = {
    1: "high", 2: "high", 3: "high",
    4: "medium", 6: "medium", 9: "medium",
    5: "low", 7: "low", 8: "low", 10: "low", 11: "low",
}


def _clean(s: str) -> str:
    return html.unescape(s or "")


def _now_local_bin() -> int:
    """Current 5-min bin start, in LOCAL seconds-since-epoch (UTC-4, no DST in window)."""
    local = time.time() - OFFSET_S
    return int(local // BIN_S) * BIN_S


# --- scheduled_active: live recompute from the derive2 GTFS cache ----------
# Memoized on the cache mtime; the heavy per-trip span aggregation runs at most once
# per cache refresh (hourly), then each request is a cheap numpy comparison.
_sched_cache: dict[str, Any] = {"key": None, "spans": None, "active_first": None,
                                "active_last": None, "built_at": None}


def _load_sched_spans() -> dict[str, Any] | None:
    cache = config.DERIVE2_CACHE
    sst = cache / "scheduled_stop_times.parquet"
    tm = cache / "trip_meta.parquet"
    cal = cache / "calendar.parquet"
    cd = cache / "calendar_dates.parquet"
    if not (sst.exists() and tm.exists() and cal.exists()):
        return None
    key = f"{sst.stat().st_mtime_ns}"
    if _sched_cache["key"] == key and _sched_cache["spans"] is not None:
        return _sched_cache
    con = duckdb.connect()
    try:
        spans = con.execute(
            f"SELECT CAST(trip_id AS VARCHAR) AS trip_id, "
            f"min(sched_arr_sec) AS first_sec, max(sched_arr_sec) AS last_sec "
            f"FROM read_parquet('{sst.as_posix()}') GROUP BY 1"
        ).df()
    finally:
        con.close()
    tmeta = pd.read_parquet(tm)[["trip_id", "service_id"]].astype({"trip_id": str, "service_id": str})
    spans = spans.merge(tmeta, on="trip_id", how="left")
    _sched_cache.update(key=key, spans=spans,
                        cal=pd.read_parquet(cal), cd=pd.read_parquet(cd) if cd.exists() else pd.DataFrame(),
                        built_at=int(sst.stat().st_mtime))
    return _sched_cache


def _scheduled_active_now() -> dict[str, Any]:
    """Trips whose scheduled span covers the current local 5-min bin on today's service."""
    sc = _load_sched_spans()
    bin_local = _now_local_bin()
    bin_sec = bin_local % 86400
    out = {"scheduled_active": None, "basis": "recomputed_live_current_bin",
           "local_iso": time.strftime("%Y-%m-%dT%H:%M", time.gmtime(bin_local)),
           "cache_built_at": None}
    if sc is None:
        out["basis"] = "unavailable"
        return out
    today = time.strftime("%Y-%m-%d", time.gmtime(time.time() - OFFSET_S))
    active = obs_active_services(sc["cal"], sc["cd"], today)
    spans = sc["spans"]
    m = spans["service_id"].isin(active)
    first = spans.loc[m, "first_sec"].to_numpy(dtype=np.float64)
    last = spans.loc[m, "last_sec"].to_numpy(dtype=np.float64)
    covered = ((first <= bin_sec) & (bin_sec <= last)) | \
              ((first <= bin_sec + 86400) & (bin_sec + 86400 <= last))
    out["scheduled_active"] = int(np.sum(covered))
    out["cache_built_at"] = sc["built_at"]
    return out


def obs_active_services(cal: pd.DataFrame, cd: pd.DataFrame, ymd: str) -> set[str]:
    """Active GTFS service_ids for a date (self-contained mirror of the derive2 rule)."""
    d = pd.Timestamp(ymd)
    ymd_int = d.strftime("%Y%m%d")
    dow = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][d.weekday()]
    active: set[str] = set()
    if not cal.empty and dow in cal.columns:
        c = cal.copy()
        c["start_date"] = c["start_date"].astype(str)
        c["end_date"] = c["end_date"].astype(str)
        mask = (c[dow].astype(str) == "1") & (c["start_date"] <= ymd_int) & (c["end_date"] >= ymd_int)
        active |= set(c.loc[mask, "service_id"].astype(str))
    if cd is not None and not cd.empty:
        ex = cd.copy()
        ex["date"] = ex["date"].astype(str)
        ex = ex[ex["date"] == ymd_int]
        active |= set(ex.loc[ex["exception_type"].astype(str) == "1", "service_id"].astype(str))
        active -= set(ex.loc[ex["exception_type"].astype(str) == "2", "service_id"].astype(str))
    return active


# --- per-route scheduled headway (for the live bunching spacing test) ------
_headway_cache: dict[str, Any] = {"key": None, "lookup": None}


def _sched_headway_lookup() -> dict[tuple, float]:
    """{(route_id, direction_id): median scheduled headway s} from the freshest
    observed_headways day. Memoized on that parquet's mtime."""
    base = config.DERIVED_ROOT / "observed_headways"
    dates = sorted(base.glob("date=*")) if base.exists() else []
    for d in reversed(dates):
        p = d / "part-000.parquet"
        if p.exists():
            key = f"{p.stat().st_mtime_ns}"
            if _headway_cache["key"] == key and _headway_cache["lookup"] is not None:
                return _headway_cache["lookup"]
            df = pd.read_parquet(p)[["route_id", "direction_id", "sched_median_headway_s"]]
            df = df.dropna(subset=["sched_median_headway_s"])
            g = (df.groupby(["route_id", "direction_id"])["sched_median_headway_s"]
                   .median().reset_index())
            lookup = {(str(r.route_id), int(r.direction_id) if pd.notna(r.direction_id) else 0):
                      float(r.sched_median_headway_s) for r in g.itertuples()}
            _headway_cache.update(key=key, lookup=lookup)
            return lookup
    return {}


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _live_bunching(vehicles: list[dict[str, Any]]) -> dict[str, Any]:
    """Scan live bus positions: two buses on the same route+direction closer than
    25% of their expected spacing (sched headway x nominal speed) = a bunching pair.
    Returns the pair count, affected-route stats, and pair-midpoint hotspots."""
    hw = _sched_headway_lookup()
    by: dict[tuple, list[dict]] = {}
    running_routes: set[str] = set()
    for v in vehicles:
        rid = v.get("route_id")
        if not rid or v.get("lat") is None or v.get("lon") is None:
            continue
        running_routes.add(rid)
        dirn = int(v["direction_id"]) if v.get("direction_id") is not None else 0
        by.setdefault((rid, dirn), []).append(v)

    pairs = 0
    hot_routes: set[str] = set()
    hotspots: list[dict[str, Any]] = []
    for (rid, dirn), vs in by.items():
        if len(vs) < 2:
            continue
        headway = hw.get((rid, dirn)) or hw.get((rid, 0)) or DEFAULT_SCHED_HEADWAY_S
        expected_m = headway * NOMINAL_BUS_MPS
        # "bunched" = closer than 25% of expected spacing AND within a hard physical
        # floor (buses genuinely on top of each other), so the wall never over-reports.
        thresh = min(BUNCH_PAIR_FRAC * expected_m, BUNCH_ABS_CAP_M)
        n = len(vs)
        # all candidate close pairs, tightest first
        cand = []
        for i in range(n):
            for j in range(i + 1, n):
                gap = _haversine_m(vs[i]["lat"], vs[i]["lon"], vs[j]["lat"], vs[j]["lon"])
                if gap < thresh:
                    cand.append((gap, i, j))
        cand.sort()
        # greedily accept pairs, each vehicle in at most ONE pair (no O(n^2) inflation)
        used: set[int] = set()
        for gap, i, j in cand:
            if i in used or j in used:
                continue
            used.add(i); used.add(j)
            pairs += 1
            hot_routes.add(rid)
            ratio = gap / expected_m if expected_m > 0 else 1.0
            sev = "high" if ratio < 0.08 else ("medium" if ratio < 0.16 else "low")
            hotspots.append({
                "lat": round((vs[i]["lat"] + vs[j]["lat"]) / 2, 6),
                "lon": round((vs[i]["lon"] + vs[j]["lon"]) / 2, 6),
                "route": rid, "direction": dirn, "severity": sev,
                "gap_m": round(gap), "sched_headway_s": round(headway),
            })
    hotspots.sort(key=lambda h: h["gap_m"])
    n_running = len(running_routes)
    return {
        "pairs": pairs,
        "routes_bunching": len(hot_routes),
        "routes_running": n_running,
        "pct_routes_bunching": round(100.0 * len(hot_routes) / n_running, 1) if n_running else 0.0,
        "hotspots": hotspots[:MAX_HOTSPOTS],
        "basis": "live_positions_vs_scheduled_headway",
        "nominal_bus_mps": NOMINAL_BUS_MPS,
    }


# --- live alert severity tally + ticker ------------------------------------
def _newest_jsonl(feed: str, n: int = 3) -> list[str]:
    base = config.REALTIME_ARCHIVE / feed
    if not base.exists():
        return []
    dates = sorted(base.glob("date=*"))
    for d in reversed(dates):
        hours = sorted(d.glob("hour=*"))
        for h in reversed(hours):
            files = sorted(h.glob("*.jsonl"))
            if files:
                return [p.as_posix() for p in files[-n:]]
    return []


def _live_alerts() -> dict[str, Any]:
    """Distinct alerts advertised at the freshest poll across the bus + subway alert
    feeds, tallied by severity, plus a de-duplicated ticker and the set of subway
    lines currently under an alert (for the line-status strip flags)."""
    rows: list[dict[str, Any]] = []
    max_poll = 0
    for feed in ("bus_alerts", "subway_alerts"):
        for fp in _newest_jsonl(feed):
            try:
                with open(fp, encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        d = json.loads(line)
                        d["_is_subway"] = feed == "subway_alerts"
                        rows.append(d)
                        pt = int(d.get("poll_ts") or 0)
                        if pt > max_poll:
                            max_poll = pt
            except Exception:
                continue
    if not rows or not max_poll:
        return {"high": 0, "medium": 0, "low": 0, "total": 0, "as_of": None,
                "items": [], "alerted_lines": []}
    # keep only the freshest poll (what MTA is advertising right now)
    fresh = [d for d in rows if int(d.get("poll_ts") or 0) >= max_poll - 60]
    seen: dict[str, dict] = {}
    for d in fresh:
        aid = d.get("alert_id")
        if aid and aid not in seen:
            seen[aid] = d
    counts = {"high": 0, "medium": 0, "low": 0}
    alerted_lines: set[str] = set()
    items: list[dict[str, Any]] = []
    for aid, d in seen.items():
        eff = d.get("effect")
        sev = ALERT_SEVERITY.get(int(eff) if eff is not None else 8, "low")
        counts[sev] += 1
        ht = d.get("header_text")
        if isinstance(ht, list):
            ht = ht[0] if ht else ""
        routes: list[str] = []
        for ent in (d.get("informed_entity") or []):
            r = ent.get("route_id") if isinstance(ent, dict) else None
            if r:
                routes.append(str(r))
                if d.get("_is_subway"):
                    alerted_lines.add(str(r).upper())
        items.append({"id": aid, "severity": sev, "header": _clean(str(ht)),
                      "routes": sorted(set(routes))[:6],
                      "subway": bool(d.get("_is_subway"))})
    sev_rank = {"high": 0, "medium": 1, "low": 2}
    items.sort(key=lambda x: sev_rank[x["severity"]])
    return {**counts, "total": len(seen), "as_of": max_poll,
            "items": items[:60], "alerted_lines": sorted(alerted_lines)}


# --- subway line-status strip ----------------------------------------------
def _subway_strip(sub: dict[str, Any], alerted_lines: list[str]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for t in sub.get("trains", []):
        r = t.get("route_id")
        if not r:
            continue
        counts[r.upper()] = counts.get(r.upper(), 0) + 1
    alerted = set(alerted_lines)
    # canonical display order of the lettered/numbered lines
    order = ["1", "2", "3", "4", "5", "6", "7", "A", "C", "E", "B", "D", "F", "M",
             "G", "J", "Z", "L", "N", "Q", "R", "W", "S", "SI"]
    lines = []
    for line in order:
        c = counts.get(line, 0)
        if c == 0 and line not in alerted:
            continue
        lines.append({
            "line": line_label(line), "route_id": line,
            "color": LINE_COLORS.get(line, "#808183"),
            "text": TEXT_ON.get(line, "#ffffff"),
            "count": c, "alerted": line in alerted,
        })
    # any remaining lines seen in the feed but not in the canonical order
    for line, c in sorted(counts.items()):
        if line not in order:
            lines.append({"line": line_label(line), "route_id": line,
                          "color": LINE_COLORS.get(line, "#808183"),
                          "text": TEXT_ON.get(line, "#ffffff"),
                          "count": c, "alerted": line in alerted})
    return {"lines": lines, "feeds": sub.get("feeds", {}),
            "as_of": sub.get("as_of"), "source": sub.get("source"),
            "stale": sub.get("stale", False), "total_trains": sub.get("count", 0)}


# --- trailing 3h sparkline series from the KPI parquet ---------------------
def _trailing3h() -> dict[str, Any]:
    base = config.DERIVED_ROOT / "kpis"
    dates = sorted(base.glob("date=*")) if base.exists() else []
    frames: list[pd.DataFrame] = []
    for d in reversed(dates[-2:]):  # today + yesterday cover any 3h window
        p = d / "part-000.parquet"
        if p.exists():
            frames.append(pd.read_parquet(p))
    cols = ["bin_local", "bin_utc", "local_iso", "service_ratio",
            "mean_abs_headway_dev_s", "active_bunching_pairs", "alerts_total"]
    if not frames:
        return {"bins": [], "parquet_last_local_iso": None, "kpi_as_of": None,
                "splice_note": "No KPI rollups available yet."}
    df = pd.concat(frames, ignore_index=True)
    for c in cols:
        if c not in df.columns:
            df[c] = np.nan
    df = df.sort_values("bin_local").drop_duplicates("bin_local")
    full = df  # keep the full frame for the lagging headway-dev fallback
    now_bin = _now_local_bin()
    lo = now_bin - TRAIL_BINS * BIN_S
    df = df[(df["bin_local"] > lo) & (df["bin_local"] <= now_bin)]
    bins = []
    for r in df.itertuples():
        bins.append({
            "t": r.local_iso,
            "epoch": int(r.bin_utc) if pd.notna(r.bin_utc) else None,
            "service_ratio": None if pd.isna(r.service_ratio) else round(float(r.service_ratio), 4),
            "mean_abs_headway_dev_s": None if pd.isna(r.mean_abs_headway_dev_s)
                else round(float(r.mean_abs_headway_dev_s), 1),
            "active_bunching_pairs": None if pd.isna(r.active_bunching_pairs)
                else int(r.active_bunching_pairs),
            "alerts_total": None if pd.isna(r.alerts_total) else int(r.alerts_total),
            "live": False,
        })
    last_iso = bins[-1]["t"] if bins else None
    last_bin = int(df["bin_local"].max()) if not df.empty else None
    lag_min = round((now_bin - last_bin) / 60) if last_bin is not None else None
    note = (f"Parquet KPI rollups end at {last_iso} (~{lag_min} min ago); the hourly "
            f"derive job has not yet written the most recent bins. The live NOW tiles "
            f"cover that gap — the sparkline and the big number are computed differently "
            f"across this splice and are not blended.")

    # Headway deviation is derived from the observed-arrivals stage, which lags further
    # behind than the KPI stage — it can be null across the whole 3h window. Surface the
    # most recent NON-NULL rollup value + its honest timestamp, and give that tile its
    # own "last available" sparkline so it never renders as an empty box.
    hd = full.dropna(subset=["mean_abs_headway_dev_s"]).sort_values("bin_local").tail(TRAIL_BINS)
    hd_series = [round(float(v), 1) for v in hd["mean_abs_headway_dev_s"].tolist()]
    hd_last = None
    if not hd.empty:
        r = hd.iloc[-1]
        hd_bin = int(r["bin_local"])
        hd_last = {"value": round(float(r["mean_abs_headway_dev_s"]), 1),
                   "local_iso": str(r["local_iso"]),
                   "lag_min": round((now_bin - hd_bin) / 60)}

    return {"bins": bins, "parquet_last_local_iso": last_iso,
            "kpi_lag_min": lag_min, "splice_note": note,
            "headway_dev_series": hd_series, "headway_dev_last": hd_last}


# --- aggregate + cache -----------------------------------------------------
_wall_cache: dict[str, Any] = {"ts": 0.0, "data": None}


def build_wall() -> dict[str, Any]:
    veh = realtime.get_vehicles()
    sub = subway.get_subway()
    sched = _scheduled_active_now()
    bunch = _live_bunching(veh.get("vehicles", []))
    alerts = _live_alerts()
    strip = _subway_strip(sub, alerts["alerted_lines"])
    trailing = _trailing3h()
    try:
        archive = obs._archive_meta()
    except Exception:
        archive = {"archive_depth_days": None, "preliminary": True, "gap_note": ""}

    n_bus = veh.get("count", 0)
    sa = sched.get("scheduled_active")
    ratio = round(n_bus / sa, 4) if sa else None

    return {
        "generated_at": int(time.time()),
        "cache_ttl_s": CACHE_TTL_S,
        "now": {
            "buses": {"reporting": n_bus, "as_of": veh.get("as_of"),
                      "source": veh.get("source"), "stale": veh.get("stale", False)},
            "subway": {"trains": sub.get("count", 0), "as_of": sub.get("as_of"),
                       "source": sub.get("source"), "stale": sub.get("stale", False)},
            "scheduled_active": sa,
            "scheduled_basis": sched.get("basis"),
            "scheduled_bin_local_iso": sched.get("local_iso"),
            "scheduled_cache_built_at": sched.get("cache_built_at"),
            "service_ratio": ratio,
            "bunching": bunch,
            "alerts": {"high": alerts["high"], "medium": alerts["medium"],
                       "low": alerts["low"], "total": alerts["total"],
                       "as_of": alerts["as_of"], "items": alerts["items"]},
        },
        "subway_strip": strip,
        "trailing3h": trailing,
        "archive": archive,
        "as_of": {
            "buses": veh.get("as_of"),
            "subway": sub.get("as_of"),
            "alerts": alerts["as_of"],
            "scheduled_cache": sched.get("cache_built_at"),
            "kpi_parquet_last": trailing.get("parquet_last_local_iso"),
        },
    }


def get_wall(force: bool = False) -> dict[str, Any]:
    now = time.time()
    if not force and _wall_cache["data"] is not None and (now - _wall_cache["ts"]) < CACHE_TTL_S:
        return _wall_cache["data"]
    data = build_wall()
    _wall_cache.update(ts=now, data=data)
    return data


@router.get("")
async def wall() -> JSONResponse:
    data = await asyncio.to_thread(get_wall)
    return JSONResponse(data)


@router.get("/stream")
async def wall_stream(request: Request) -> StreamingResponse:
    async def gen():
        while True:
            if await request.is_disconnected():
                break
            try:
                data = await asyncio.to_thread(get_wall)
                yield f"data: {json.dumps(data)}\n\n"
            except Exception:
                yield "event: error\ndata: {}\n\n"
            await asyncio.sleep(config.SSE_INTERVAL_S)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform",
                 "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
