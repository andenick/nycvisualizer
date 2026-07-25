"""Live Ops Wall (S6) — one aggregate endpoint that assembles the control-room view.

`/api/wall` returns a single JSON with three time horizons, each honestly stamped:

  now         — numbers computed LIVE, in-process, from the same realtime sources the
                map uses (`realtime.get_vehicles`, `subway.get_subway`) plus a live
                recompute of `scheduled_active` from the derive2 GTFS cache for the
                CURRENT 5-min local bin, a live bunching-pair scan over bus positions,
                and a live alert-severity tally from the freshest alert-feed poll.
  trailing3h  — derive2 KPI rollups (per 5-min bin: service_ratio, mean |headway
                deviation|, active bunching pairs, alert totals). `window_basis` says
                what you actually got: "trailing_3h" when rollups for the last 3h exist
                (hosts that derive locally — JaneNYCDerive runs every 30 min at :20/:50),
                or "last_available_rollup" when they do not (the public box, which does
                NOT run derive2 and receives derived data once a day via
                JaneNYCDerivedSync at 04:30 ET). Either way `window_lag_min` /
                `window_label` carry the true age and the response marks where parquet
                ends and the live NOW number takes over (the "splice"), never blending
                the two silently and never returning an unlabelled empty series.
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
from itertools import zip_longest
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import config, obs, realtime, runtime, subway
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

# Subway/SIR route ids, for classifying an alert as subway BY ITS ROUTES rather than by
# which feed it arrived on. The `camsys/all-alerts` endpoint is the ALL-AGENCY feed: of
# 344 alerts on it (measured 2026-07-25) most inform BUS routes (B46, M15, Q29, SIM6...).
# Flagging by feed therefore marked hundreds of bus alerts `subway: true` and pushed bus
# route ids into `alerted_lines`. Route-based classification is the honest test.
SUBWAY_ROUTE_IDS = frozenset(LINE_COLORS.keys())


def _clean(s: str) -> str:
    return html.unescape(s or "")


def _fmt_age(minutes: int | None) -> str:
    """Plain-language age ("18 min", "6 h", "2 days") for honest staleness labels."""
    if minutes is None:
        return "unknown age"
    if minutes < 90:
        return f"{int(minutes)} min"
    hours = minutes / 60.0
    if hours < 36:
        return f"{hours:.0f} h"
    return f"{hours / 24:.1f} days"


def _now_local_bin() -> int:
    """Current 5-min bin start, in LOCAL seconds-since-epoch (UTC-4, no DST in window)."""
    local = time.time() - OFFSET_S
    return int(local // BIN_S) * BIN_S


# --- scheduled_active: live recompute from the derive2 GTFS cache ----------
# Memoized on the cache mtime; the heavy per-trip span aggregation runs at most once
# per cache refresh, then each request is a cheap numpy comparison. (The GTFS-static
# cache turns over when the feeds roll, not on a clock — `scheduled_cache_age_min` in the
# payload reports how old it actually is.)
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
                # Q1.5: both bus positions so the frontend can draw the bunching
                # CONNECTOR line between the pair (the gap IS the mark).
                "lat_a": round(vs[i]["lat"], 6), "lon_a": round(vs[i]["lon"], 6),
                "lat_b": round(vs[j]["lat"], 6), "lon_b": round(vs[j]["lon"], 6),
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
#
# SOURCE ORDER (fixed 2026-07-25 — W6a defect 1). This used to read ONLY the raw
# `{bus,subway}_alerts` JSONL archive. On the box that archive is never synced —
# `ops/run_derived_sync.ps1` ships `derived/`, the derive2 cache, `outputs/` and
# `changes/`, but NOT the raw archive — so the wall's alert panel was frozen at its
# deploy snapshot: `/api/wall` served `as_of = 2026-07-17 16:23 UTC, total = 357` on
# 2026-07-25, i.e. 7.4 days stale, while `/api/rt/alerts` on the SAME origin was live.
# The same frozen set drove the `alerted` dots on the subway line-status strip.
#
# The fix is to read the feeds, not a file the box never receives: fetch the two
# upstream GTFS-RT alert endpoints directly (exactly the ones the poller archives —
# BusTime `alerts`, keyed; and the key-free `camsys/all-alerts`), normalize them into
# the SAME row shape the archived JSONL uses, and fall back to the archive only if the
# fetch fails. One tally implementation, two interchangeable sources. Syncing the raw
# archive was the alternative, but it is ~0.5 GiB/day of mostly-redundant JSONL to move
# a number that is one HTTP GET away, and it would still only be as fresh as the sync.
#
# Whichever source wins is reported: `source` in ("live", "archive", "none") and an
# honest `stale` flag. The UI renders both — a stale set is never labelled "live".

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


def _alerts_rows_from_archive() -> tuple[list[dict[str, Any]], int]:
    """Rows + newest poll_ts from the raw JSONL archive (the original path)."""
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
    return rows, max_poll


_alerts_live_cache: dict[str, Any] = {"ts": 0.0, "rows": None, "poll_ts": 0}


def _alerts_rows_from_live() -> tuple[list[dict[str, Any]], int]:
    """Fetch both upstream GTFS-RT alert feeds and normalize to the archive row shape.

    Returns ([], 0) on total failure so the caller can fall back. A PARTIAL success
    (one feed up, one down) is returned as-is — half the alerts honestly stamped beats
    a week-old full set. Cached for ALERTS_LIVE_TTL_S; the archiver polls these same
    endpoints every 300 s, so this adds no meaningful upstream load.
    """
    now = time.time()
    if (_alerts_live_cache["rows"] is not None
            and (now - _alerts_live_cache["ts"]) < config.ALERTS_LIVE_TTL_S):
        return _alerts_live_cache["rows"], _alerts_live_cache["poll_ts"]
    try:
        import httpx
        from google.transit import gtfs_realtime_pb2  # type: ignore
    except Exception:
        return [], 0

    feeds: list[tuple[str, str, dict[str, str]]] = [
        ("subway_alerts", config.GTFSRT_SUBWAY_ALERTS_URL, {}),
    ]
    if config.MTA_BUSTIME_KEY:
        feeds.insert(0, ("bus_alerts", config.GTFSRT_ALERTS_URL,
                         {"key": config.MTA_BUSTIME_KEY}))

    rows: list[dict[str, Any]] = []
    max_poll = 0
    for feed, url, params in feeds:
        try:
            r = httpx.get(url, params=params or None, timeout=20.0)
            r.raise_for_status()
            fm = gtfs_realtime_pb2.FeedMessage()
            fm.ParseFromString(r.content)
        except Exception:
            continue
        # Stamp with the feed header time when present (what MTA says it published),
        # else our fetch time. Same semantic as the archiver's poll_ts.
        poll_ts = int(fm.header.timestamp) if fm.header.HasField("timestamp") else int(now)
        if not poll_ts:
            poll_ts = int(now)
        max_poll = max(max_poll, poll_ts)
        for ent in fm.entity:
            if not ent.HasField("alert"):
                continue
            a = ent.alert
            rows.append({
                "feed": feed,
                "poll_ts": poll_ts,
                "alert_id": ent.id,
                # protobuf enums are ints; ALERT_SEVERITY keys on the effect int.
                "effect": int(a.effect) if a.effect is not None else None,
                "header_text": [t.text for t in a.header_text.translation],
                "informed_entity": [
                    {"route_id": ie.route_id or None, "stop_id": ie.stop_id or None}
                    for ie in a.informed_entity
                ],
                "_is_subway": feed == "subway_alerts",
            })
    if not rows:
        return [], 0
    _alerts_live_cache.update(ts=now, rows=rows, poll_ts=max_poll)
    return rows, max_poll


def _tally_alerts(rows: list[dict[str, Any]], max_poll: int) -> dict[str, Any]:
    """Distinct alerts at the freshest poll, tallied by severity, plus a de-duplicated
    ticker and the set of subway lines currently under an alert (line-status flags).

    "Freshest poll" is resolved PER FEED, not globally. The two upstream feeds publish
    on independent clocks — measured 2026-07-25: bus header 02:39:46Z vs subway header
    02:40:10Z, 24 s apart, and the skew is not bounded. A single global
    `poll_ts >= max_poll - 60` filter therefore silently deletes an ENTIRE feed the
    moment the skew exceeds 60 s: the subway alerts vanish, the tally drops by ~80%, and
    `alerted_lines` empties so every dot on the subway line-status strip goes dark — with
    no error anywhere. Each feed is one coherent snapshot; each gets its own cutoff.
    """
    per_feed_max: dict[str, int] = {}
    for d in rows:
        f = str(d.get("feed") or ("subway_alerts" if d.get("_is_subway") else "bus_alerts"))
        pt = int(d.get("poll_ts") or 0)
        if pt > per_feed_max.get(f, 0):
            per_feed_max[f] = pt
    fresh = []
    for d in rows:
        f = str(d.get("feed") or ("subway_alerts" if d.get("_is_subway") else "bus_alerts"))
        if int(d.get("poll_ts") or 0) >= per_feed_max.get(f, 0) - 60:
            fresh.append(d)

    seen: dict[str, dict] = {}
    for d in fresh:
        aid = d.get("alert_id")
        if aid and aid not in seen:
            seen[aid] = d
    counts = {"high": 0, "medium": 0, "low": 0}
    n_unknown_effect = 0
    alerted_lines: set[str] = set()
    items: list[dict[str, Any]] = []
    for aid, d in seen.items():
        eff = d.get("effect")
        eff_i = int(eff) if eff is not None else 8
        # 8 = UNKNOWN_EFFECT. Measured 2026-07-25: 424/424 alerts across BOTH feeds carry
        # effect=8, i.e. MTA publishes no effect classification at all on these endpoints.
        # Our severity tier is then a default, not an upstream judgement — counted here so
        # the UI can say "severity not published" instead of implying "all alerts are low".
        if eff_i == 8:
            n_unknown_effect += 1
        sev = ALERT_SEVERITY.get(eff_i, "low")
        counts[sev] += 1
        ht = d.get("header_text")
        if isinstance(ht, list):
            ht = ht[0] if ht else ""
        routes: list[str] = []
        is_subway = False
        for ent in (d.get("informed_entity") or []):
            r = ent.get("route_id") if isinstance(ent, dict) else None
            if r:
                routes.append(str(r))
                if str(r).upper() in SUBWAY_ROUTE_IDS:
                    is_subway = True
                    alerted_lines.add(str(r).upper())
        # An alert with no informed route at all: fall back to the feed it came from.
        if not routes:
            is_subway = bool(d.get("_is_subway"))
        items.append({"id": aid, "severity": sev, "header": _clean(str(ht)),
                      "routes": sorted(set(routes))[:6],
                      "subway": is_subway})
    sev_rank = {"high": 0, "medium": 1, "low": 2}
    items.sort(key=lambda x: sev_rank[x["severity"]])
    total = len(seen)
    # The ticker is capped at 60. Upstream classifies NOTHING (all UNKNOWN_EFFECT), so
    # every item ties on severity and a stable sort just preserves fetch order — which
    # means the bus feed, fetched first, filled all 60 slots and the ticker showed 0 of
    # 344 subway alerts under the heading "bus + subway feeds". Interleave the two modes
    # round-robin WITHIN each severity tier so the capped view represents both.
    shown: list[dict[str, Any]] = []
    for tier in ("high", "medium", "low"):
        sub = [i for i in items if i["severity"] == tier and i["subway"]]
        bus = [i for i in items if i["severity"] == tier and not i["subway"]]
        for a, b in zip_longest(sub, bus):
            if a is not None:
                shown.append(a)
            if b is not None:
                shown.append(b)
    return {**counts, "total": total, "as_of": max_poll,
            "items": shown[:60], "items_shown": min(60, len(shown)),
            "alerted_lines": sorted(alerted_lines),
            "unknown_effect": n_unknown_effect,
            # "gtfs_effect" = upstream told us; "unclassified" = it did not.
            "severity_basis": "unclassified" if (total and n_unknown_effect == total)
                              else "gtfs_effect",
            "feeds": {f: {"as_of": t, "count": sum(
                1 for d in seen.values()
                if str(d.get("feed") or ("subway_alerts" if d.get("_is_subway")
                                         else "bus_alerts")) == f)}
                      for f, t in sorted(per_feed_max.items())}}


_EMPTY_ALERTS = {"high": 0, "medium": 0, "low": 0, "total": 0, "as_of": None,
                 "items": [], "items_shown": 0, "alerted_lines": [], "source": "none",
                 "stale": True, "age_s": None, "unknown_effect": 0,
                 "severity_basis": "unclassified", "feeds": {}}


def _live_alerts() -> dict[str, Any]:
    """Freshest alert tally: upstream feeds first, raw archive as fallback."""
    rows, max_poll = _alerts_rows_from_live()
    source = "live"
    if not rows or not max_poll:
        rows, max_poll = _alerts_rows_from_archive()
        source = "archive"
    if not rows or not max_poll:
        return dict(_EMPTY_ALERTS)
    out = _tally_alerts(rows, max_poll)
    age = int(time.time()) - int(max_poll)
    out["source"] = source
    out["age_s"] = age
    out["stale"] = age > config.ALERTS_STALE_AFTER_S
    return out


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


# --- trailing sparkline series from the KPI parquet ------------------------
#
# WINDOW BASIS (fixed 2026-07-25 — W6a defect 3). This returned a STRICT trailing-3h
# window: bins in (now - 3h, now]. On the public box that window is ALWAYS empty, because
# the box does not run derive2 — derived data arrives only via JaneNYCDerivedSync at
# 04:30 ET, once a day. Live `/api/wall` on 2026-07-25 returned `bins: []` and
# `parquet_last_local_iso: null` while the tiles rendered empty charts under confident
# labels ("trailing 60 min") and the page subtitle claimed every number traced to a live
# endpoint. An empty array is not a 3h window; it is a missing one.
#
# Now: try the trailing window first (correct on any host that derives locally), and if
# it is empty fall back to the most recent TRAIL_BINS rollups that DO exist — real
# measured data, stamped with its own age. `window_basis` says which you got, and
# `window_lag_min` says how old it is, so the label can tell the truth in both cases.
# We do NOT invent bins, do NOT interpolate across the gap, and do NOT let the frontend
# append a live point to a stale series (that would blend across an unmarked hole).

def _bin_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = []
    for r in df.itertuples():
        out.append({
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
    return out


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
    empty = {"bins": [], "parquet_last_local_iso": None, "kpi_lag_min": None,
             "window_basis": "none", "window_last_local_iso": None,
             "window_first_local_iso": None, "window_lag_min": None,
             "window_span_bins": 0, "window_label": "no rollup available",
             "splice_note": "No KPI rollups are available to this server yet, so the "
                            "trend charts have nothing to draw. The NOW tiles above are "
                            "computed live and are unaffected.",
             "headway_dev_series": [], "headway_dev_last": None}
    if not frames:
        return empty
    df = pd.concat(frames, ignore_index=True)
    for c in cols:
        if c not in df.columns:
            df[c] = np.nan
    df = df.sort_values("bin_local").drop_duplicates("bin_local")
    full = df  # keep the full frame for the fallback window + lagging headway-dev
    now_bin = _now_local_bin()
    lo = now_bin - TRAIL_BINS * BIN_S
    win = df[(df["bin_local"] > lo) & (df["bin_local"] <= now_bin)]

    basis = "trailing_3h"
    if win.empty:
        # Nothing in the last 3h. Serve the newest rollups that exist, honestly aged.
        win = full.tail(TRAIL_BINS)
        basis = "last_available_rollup"
    if win.empty:
        return empty

    bins = _bin_rows(win)
    last_bin = int(win["bin_local"].max())
    first_iso = str(win["local_iso"].iloc[0])
    last_iso = str(win["local_iso"].iloc[-1])
    lag_min = int(round((now_bin - last_bin) / 60))

    if basis == "trailing_3h":
        label = "trailing 3 h"
        note = (f"Trend charts show KPI rollups through {last_iso} "
                f"(~{lag_min} min ago). The live NOW tiles cover the gap since then — "
                f"the sparkline and the big number are computed differently across this "
                f"splice and are not blended.")
    else:
        label = f"last rollup · {last_iso.replace('T', ' ')} ({_fmt_age(lag_min)} old)"
        note = (f"No KPI rollup exists for the last 3 hours on this server, so the trend "
                f"charts show the most recent {len(bins)} rollup bins instead — "
                f"{first_iso} to {last_iso}, ending {_fmt_age(lag_min)} ago. This is real "
                f"measured data, not an estimate, but it is NOT the last 3 hours. Derived "
                f"rollups reach this site once a day (04:30 ET sync); only the NOW tiles "
                f"above are live. No live value is appended to these series.")

    # Headway deviation is derived from the observed-arrivals stage, which lags further
    # behind than the KPI stage — it can be null across the whole window. Surface the
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
                   "lag_min": int(round((now_bin - hd_bin) / 60))}

    return {"bins": bins,
            # kept for API compatibility: where the PARQUET series actually ends
            "parquet_last_local_iso": last_iso,
            "kpi_lag_min": lag_min,
            "window_basis": basis,
            "window_first_local_iso": first_iso,
            "window_last_local_iso": last_iso,
            "window_lag_min": lag_min,
            "window_span_bins": len(bins),
            "window_label": label,
            "splice_note": note,
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
    _scb = sched.get("cache_built_at")
    sched_cache_age_min = int((time.time() - _scb) / 60) if _scb else None

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
            # W6a: the service-ratio DENOMINATOR comes from a GTFS-static cache that is
            # only as fresh as the last derive2 cache sync. Publish its age so the ratio
            # is never read as fully-live when half of it is days old.
            "scheduled_cache_age_min": sched_cache_age_min,
            # GTFS static rolls over every few weeks, so a few days old is normal and the
            # UI simply DISCLOSES the age. Past a week the denominator is questionable.
            "scheduled_cache_stale": (sched_cache_age_min is not None
                                      and sched_cache_age_min > 60 * 24 * 7),
            "service_ratio": ratio,
            "bunching": bunch,
            "alerts": {"high": alerts["high"], "medium": alerts["medium"],
                       "low": alerts["low"], "total": alerts["total"],
                       "as_of": alerts["as_of"], "items": alerts["items"],
                       # W6a: which source won and how old it actually is, so the UI
                       # can never label a stale set "live" again.
                       "source": alerts.get("source"), "stale": alerts.get("stale", False),
                       "age_s": alerts.get("age_s"),
                       # W6a: upstream publishes no effect classification (all
                       # UNKNOWN_EFFECT), so the high/med/low split is OUR default, not
                       # MTA's. Say so rather than implying "all alerts are low".
                       "severity_basis": alerts.get("severity_basis"),
                       "unknown_effect": alerts.get("unknown_effect"),
                       "items_shown": alerts.get("items_shown", 0),
                       "feeds": alerts.get("feeds", {})},
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
    # /api/wall is already app-cached (get_wall CACHE_TTL_S + startup warmer), so the
    # origin cost is O(1); the Cache-Control lets a shared/edge cache shield it too.
    data = await asyncio.to_thread(get_wall)
    cc = f"public, s-maxage={config.RT_CACHE_TTL_S}, stale-while-revalidate={config.RT_CACHE_TTL_S * 2}"
    return JSONResponse(data, headers={"Cache-Control": cc})


@router.get("/stream")
async def wall_stream(request: Request):
    if not runtime.sse_limiter.try_acquire():
        return JSONResponse(
            {"error": "SSE capacity reached — poll /api/wall instead.", "retry_after": 30},
            status_code=429,
            headers={"Retry-After": "30"},
        )

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.to_thread(get_wall)
                    yield f"data: {json.dumps(data)}\n\n"
                except Exception:
                    yield "event: error\ndata: {}\n\n"
                await asyncio.sleep(config.SSE_INTERVAL_S)
        finally:
            runtime.sse_limiter.release()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform",
                 "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
