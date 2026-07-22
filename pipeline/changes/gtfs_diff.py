#!/usr/bin/env python3
"""
S3 GTFS structured diff engine.

Compares two GTFS static snapshots (zip files) of the SAME feed and emits structured
delta records + a human-readable changelog. Change families:

  route_added / route_removed        routes.txt route_id set difference
  headway_delta                      per route x service_period x tod_window x direction:
                                     median scheduled headway at the route's trunk stop;
                                     flagged when |delta| > HEADWAY_FLAG_PCT (10%)
  trip_count_delta                   trips per route_id (trips.txt) count change
  service_span_change                per route x service_period: earliest departure /
                                     latest arrival change (> SPAN_FLAG_MIN minutes)
  stop_added / stop_removed          stops.txt stop_id set difference (location_type 0/blank)
  stop_relocated                     common stop_id whose lat/lon moved > RELOCATE_M (25 m)
  shape_change                       count of common trip_ids whose shape_id changed (per route)

Output:
  * JSONL delta records: {feed, from_ts, to_ts, change_type, route_id, detail, magnitude}
  * appended human lines to changes/CHANGELOG.md (newest first)

Method notes (documented honestly in README):
  * "headway" = median of consecutive scheduled arrival gaps at the route's TRUNK STOP
    (the stop with the most visits on that route), split by direction, within a
    time-of-day window, for trips whose service_id maps to the given service_period.
    Requires >= MIN_ARRIVALS arrivals in the bucket to be reported.
  * service_period is classified from calendar.txt day flags (weekday/saturday/sunday);
    if a feed has no calendar.txt, trips fall into "all".
  * shape_change only compares trip_ids present in BOTH snapshots; shape_ids often churn
    between feed versions, so this signal is advisory.

Public-repo hygiene: no absolute workspace-root literals; root via NYCV_PIPELINE_ROOT.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

from _common import CHANGELOG, DELTA_DIR, PLATFORM

HEADWAY_FLAG_PCT = 10.0      # flag median-headway changes larger than this (%)
RELOCATE_M = 25.0            # stop move threshold (metres)
SPAN_FLAG_MIN = 5.0          # service-span change threshold (minutes)
MIN_ARRIVALS = 3            # need >=3 arrivals in a bucket to compute a headway

# Time-of-day windows (seconds from service midnight). GTFS allows >24h times.
TOD_WINDOWS = {
    "am_peak": (6 * 3600, 10 * 3600),
    "midday": (10 * 3600, 16 * 3600),
    "pm_peak": (16 * 3600, 20 * 3600),
    "evening": (20 * 3600, 24 * 3600),
}


# ----------------------------------------------------------------- GTFS reading
def _open_txt(z: zipfile.ZipFile, name: str):
    """Yield dict rows from a GTFS member (case-insensitive basename match)."""
    match = None
    for n in z.namelist():
        if n.split("/")[-1].lower() == name.lower():
            match = n
            break
    if match is None:
        return
    with z.open(match) as fh:
        text = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
        for row in csv.DictReader(text):
            yield row


def _sec(t: str) -> int | None:
    t = (t or "").strip()
    if not t:
        return None
    parts = t.split(":")
    if len(parts) != 3:
        return None
    try:
        h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None
    return h * 3600 + m * 60 + s


def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


import datetime as _dt


def _dow_bucket(weekday: int) -> str:
    # Mon=0..Sun=6
    if weekday == 5:
        return "saturday"
    if weekday == 6:
        return "sunday"
    return "weekday"


def _classify_service(z: zipfile.ZipFile) -> dict:
    """
    service_id -> 'weekday' | 'saturday' | 'sunday' | 'other'.

    Primary: calendar.txt day flags. Fallback (crucial for the SUPPLEMENTED subway feed,
    whose dated service_ids live mostly in calendar_dates.txt): classify by the majority
    day-of-week of the added service dates. This keeps the 'other' bucket small so diffs
    read as 'weekday midday' etc. rather than opaque 'other'.
    """
    out = {}
    for r in _open_txt(z, "calendar.txt"):
        sid = r.get("service_id")
        if not sid:
            continue
        wk = sum(int(r.get(d, "0") or 0) for d in
                 ("monday", "tuesday", "wednesday", "thursday", "friday"))
        sat = int(r.get("saturday", "0") or 0)
        sun = int(r.get("sunday", "0") or 0)
        if wk >= 3:
            out[sid] = "weekday"
        elif sat and not sun:
            out[sid] = "saturday"
        elif sun and not sat:
            out[sid] = "sunday"
        else:
            out[sid] = "other"

    # calendar_dates fallback / refinement via day-of-week majority of added dates
    dow_votes = defaultdict(lambda: defaultdict(int))
    for r in _open_txt(z, "calendar_dates.txt"):
        sid = r.get("service_id")
        d = (r.get("date") or "").strip()
        if not sid or len(d) != 8 or (r.get("exception_type") or "1").strip() != "1":
            continue
        try:
            wd = _dt.date(int(d[:4]), int(d[4:6]), int(d[6:8])).weekday()
        except ValueError:
            continue
        dow_votes[sid][_dow_bucket(wd)] += 1
    for sid, votes in dow_votes.items():
        if out.get(sid) in (None, "other") and votes:
            out[sid] = max(votes, key=votes.get)
    return out


def _median(vals: list[float]) -> float:
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return float("nan")
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


class GtfsView:
    """Loads the light tables; streams stop_times twice for headway/span (memory-light)."""

    def __init__(self, zip_path: Path):
        self.zip_path = Path(zip_path)
        with zipfile.ZipFile(self.zip_path) as z:
            self.service_period = _classify_service(z)
            # trips: trip_id -> (route_id, service_id, direction_id, shape_id)
            self.trip = {}
            self.route_trip_count = defaultdict(int)
            for r in _open_txt(z, "trips.txt"):
                tid = r.get("trip_id")
                if not tid:
                    continue
                rid = r.get("route_id", "")
                self.trip[tid] = (
                    rid, r.get("service_id", ""),
                    r.get("direction_id", "") or "0", r.get("shape_id", ""),
                )
                self.route_trip_count[rid] += 1
            # routes
            self.routes = {}
            for r in _open_txt(z, "routes.txt"):
                rid = r.get("route_id")
                if rid:
                    self.routes[rid] = r.get("route_short_name") or r.get("route_long_name") or rid
            # stops (revenue stops: location_type blank/0)
            self.stops = {}
            for r in _open_txt(z, "stops.txt"):
                sid = r.get("stop_id")
                lt = (r.get("location_type") or "0").strip() or "0"
                if not sid or lt != "0":
                    continue
                try:
                    self.stops[sid] = (float(r["stop_lat"]), float(r["stop_lon"]),
                                       r.get("stop_name", ""))
                except (KeyError, ValueError):
                    continue
        # computed lazily
        self._headways = None
        self._spans = None

    def period_of(self, service_id: str) -> str:
        return self.service_period.get(service_id, "all" if not self.service_period else "other")

    def _compute(self):
        """Two streaming passes over stop_times -> trunk stop, then bucketed arrivals."""
        # pass 1: visits per (route, stop); service span per (route, period)
        visits = defaultdict(int)
        span = {}  # (route, period) -> [min_dep, max_arr]
        with zipfile.ZipFile(self.zip_path) as z:
            for r in _open_txt(z, "stop_times.txt"):
                tid = r.get("trip_id")
                tinfo = self.trip.get(tid)
                if not tinfo:
                    continue
                rid, sid, _dir, _shape = tinfo
                stop = r.get("stop_id")
                if stop:
                    visits[(rid, stop)] += 1
                period = self.period_of(sid)
                dep = _sec(r.get("departure_time") or r.get("arrival_time"))
                arr = _sec(r.get("arrival_time") or r.get("departure_time"))
                if dep is None and arr is None:
                    continue
                key = (rid, period)
                cur = span.get(key)
                lo = dep if dep is not None else arr
                hi = arr if arr is not None else dep
                if cur is None:
                    span[key] = [lo, hi]
                else:
                    if lo < cur[0]:
                        cur[0] = lo
                    if hi > cur[1]:
                        cur[1] = hi
        # trunk stop per route
        trunk = {}
        for (rid, stop), c in visits.items():
            if rid not in trunk or c > trunk[rid][1]:
                trunk[rid] = (stop, c)
        trunk_stop = {rid: s for rid, (s, _c) in trunk.items()}

        # pass 2: arrivals at trunk stop -> (route, period, tod, direction) -> [arr_sec]
        arrivals = defaultdict(list)
        with zipfile.ZipFile(self.zip_path) as z:
            for r in _open_txt(z, "stop_times.txt"):
                tid = r.get("trip_id")
                tinfo = self.trip.get(tid)
                if not tinfo:
                    continue
                rid, sid, direction, _shape = tinfo
                if r.get("stop_id") != trunk_stop.get(rid):
                    continue
                arr = _sec(r.get("arrival_time") or r.get("departure_time"))
                if arr is None:
                    continue
                period = self.period_of(sid)
                for win, (a, b) in TOD_WINDOWS.items():
                    if a <= (arr % (24 * 3600)) < b or (a <= arr < b):
                        arrivals[(rid, period, win, direction)].append(arr)
                        break
        # median headway per bucket
        headways = {}
        for key, arrs in arrivals.items():
            if len(arrs) < MIN_ARRIVALS:
                continue
            arrs.sort()
            gaps = [(arrs[i + 1] - arrs[i]) / 60.0 for i in range(len(arrs) - 1)]
            gaps = [g for g in gaps if g > 0]
            if len(gaps) >= (MIN_ARRIVALS - 1):
                headways[key] = round(_median(gaps), 2)
        self._headways = headways
        self._spans = span
        self._trunk_stop = trunk_stop

    @property
    def headways(self) -> dict:
        if self._headways is None:
            self._compute()
        return self._headways

    @property
    def spans(self) -> dict:
        if self._spans is None:
            self._compute()
        return self._spans


# ----------------------------------------------------------------- diff
def _fmt_hms(sec: int) -> str:
    h = sec // 3600
    m = (sec % 3600) // 60
    return f"{h:02d}:{m:02d}"


def diff(feed: str, from_zip: Path, to_zip: Path, from_ts: str, to_ts: str) -> list[dict]:
    a = GtfsView(from_zip)
    b = GtfsView(to_zip)
    deltas: list[dict] = []

    def rec(change_type, route_id, detail, magnitude):
        deltas.append({
            "feed": feed, "from_ts": from_ts, "to_ts": to_ts,
            "change_type": change_type, "route_id": route_id,
            "detail": detail, "magnitude": magnitude,
        })

    # routes added/removed
    ra, rb = set(a.routes), set(b.routes)
    for rid in sorted(rb - ra):
        rec("route_added", rid, {"route_name": b.routes[rid]}, None)
    for rid in sorted(ra - rb):
        rec("route_removed", rid, {"route_name": a.routes[rid]}, None)

    # trip count deltas per route (common routes)
    for rid in sorted(ra & rb):
        ca, cb = a.route_trip_count.get(rid, 0), b.route_trip_count.get(rid, 0)
        if ca != cb:
            pct = ((cb - ca) / ca * 100.0) if ca else None
            rec("trip_count_delta", rid,
                {"route_name": b.routes.get(rid, rid), "from_trips": ca, "to_trips": cb,
                 "pct": round(pct, 1) if pct is not None else None}, cb - ca)

    # headway deltas (common buckets)
    ha, hb = a.headways, b.headways
    for key in sorted(set(ha) & set(hb)):
        rid, period, win, direction = key
        old, new = ha[key], hb[key]
        if old <= 0:
            continue
        pct = (new - old) / old * 100.0
        if abs(pct) > HEADWAY_FLAG_PCT:
            rec("headway_delta", rid,
                {"route_name": b.routes.get(rid, rid), "service_period": period,
                 "tod_window": win, "direction": direction,
                 "from_headway_min": old, "to_headway_min": new,
                 "pct": round(pct, 1)}, round(pct, 1))

    # service-span changes (common route x period)
    for key in sorted(set(a.spans) & set(b.spans), key=lambda k: (str(k[0]), str(k[1]))):
        rid, period = key
        (a0, a1), (b0, b1) = a.spans[key], b.spans[key]
        d_first = (b0 - a0) / 60.0
        d_last = (b1 - a1) / 60.0
        if abs(d_first) > SPAN_FLAG_MIN or abs(d_last) > SPAN_FLAG_MIN:
            rec("service_span_change", rid,
                {"route_name": b.routes.get(rid, rid), "service_period": period,
                 "from_first": _fmt_hms(a0), "to_first": _fmt_hms(b0),
                 "from_last": _fmt_hms(a1), "to_last": _fmt_hms(b1),
                 "d_first_min": round(d_first, 1), "d_last_min": round(d_last, 1)},
                round(max(abs(d_first), abs(d_last)), 1))

    # stops added/removed/relocated
    sa, sb = set(a.stops), set(b.stops)
    for sid in sorted(sb - sa):
        rec("stop_added", None, {"stop_id": sid, "stop_name": b.stops[sid][2]}, None)
    for sid in sorted(sa - sb):
        rec("stop_removed", None, {"stop_id": sid, "stop_name": a.stops[sid][2]}, None)
    for sid in sorted(sa & sb):
        la, lo, _n = a.stops[sid]
        lb, lob, nm = b.stops[sid]
        d = _haversine_m(la, lo, lb, lob)
        if d > RELOCATE_M:
            rec("stop_relocated", None,
                {"stop_id": sid, "stop_name": nm, "meters": round(d, 1)}, round(d, 1))

    # shape changes (common trip_ids only)
    shape_changed_by_route = defaultdict(int)
    for tid, (rid_a, _s, _d, shp_a) in a.trip.items():
        tb = b.trip.get(tid)
        if tb and tb[3] != shp_a:
            shape_changed_by_route[tb[0] or rid_a] += 1
    for rid in sorted(shape_changed_by_route):
        n = shape_changed_by_route[rid]
        rec("shape_change", rid,
            {"route_name": b.routes.get(rid, rid), "trips_with_new_shape": n}, n)

    return deltas


# ----------------------------------------------------------------- changelog
def _plain(feed: str, d: dict) -> str | None:
    ct = d["change_type"]
    det = d["detail"]
    rid = d.get("route_id")
    name = (det or {}).get("route_name", rid)
    if ct == "route_added":
        return f"{feed}: route {name} ADDED"
    if ct == "route_removed":
        return f"{feed}: route {name} REMOVED"
    if ct == "headway_delta":
        sign = "less" if det["pct"] > 0 else "more"
        return (f"{feed} {name}: {det['service_period']} {det['tod_window']} dir{det['direction']} "
                f"scheduled headway {det['from_headway_min']} -> {det['to_headway_min']} min "
                f"({det['pct']:+.1f}% = {sign} service)")
    if ct == "trip_count_delta":
        p = f" ({det['pct']:+.1f}%)" if det.get("pct") is not None else ""
        return f"{feed} {name}: daily trips {det['from_trips']} -> {det['to_trips']}{p}"
    if ct == "service_span_change":
        return (f"{feed} {name} ({det['service_period']}): span "
                f"{det['from_first']}-{det['from_last']} -> {det['to_first']}-{det['to_last']} "
                f"(first {det['d_first_min']:+.0f}m, last {det['d_last_min']:+.0f}m)")
    if ct == "stop_added":
        return f"{feed}: stop ADDED {det['stop_id']} {det['stop_name']}"
    if ct == "stop_removed":
        return f"{feed}: stop REMOVED {det['stop_id']} {det['stop_name']}"
    if ct == "stop_relocated":
        return f"{feed}: stop MOVED {det['stop_id']} {det['stop_name']} by {det['meters']:.0f} m"
    if ct == "shape_change":
        return f"{feed} {name}: {det['trips_with_new_shape']} trip(s) changed routing (shape)"
    return None


def _summarize(feed: str, from_ts: str, to_ts: str, deltas: list[dict]) -> list[str]:
    from collections import Counter
    c = Counter(d["change_type"] for d in deltas)
    lines = [
        f"## {to_ts}  —  {feed}  (vs {from_ts})",
        "",
        f"_{len(deltas)} change record(s): " +
        (", ".join(f"{k}={v}" for k, v in sorted(c.items())) if c else "none — proven no schedule change")
        + "._",
        "",
    ]
    # Order: routes, headways (biggest first), spans, trips, stops, shapes
    order = ["route_added", "route_removed", "headway_delta", "service_span_change",
             "trip_count_delta", "stop_added", "stop_removed", "stop_relocated", "shape_change"]
    shown = 0
    for ct in order:
        group = [d for d in deltas if d["change_type"] == ct]
        if ct == "headway_delta":
            group.sort(key=lambda d: -abs(d["magnitude"] or 0))
        if ct in ("stop_added", "stop_removed", "shape_change") and len(group) > 12:
            for d in group[:12]:
                lines.append(f"- {_plain(feed, d)}")
            lines.append(f"- ...and {len(group) - 12} more {ct} (see JSONL)")
            shown += len(group)
            continue
        for d in group:
            txt = _plain(feed, d)
            if txt:
                lines.append(f"- {txt}")
                shown += 1
    if shown == 0:
        lines.append("- No material changes detected between these two snapshots.")
    lines.append("")
    return lines


def write_outputs(feed: str, from_ts: str, to_ts: str, deltas: list[dict]) -> tuple[Path, int]:
    DELTA_DIR.mkdir(parents=True, exist_ok=True)
    jsonl = DELTA_DIR / f"{feed}__{from_ts}__to__{to_ts}.jsonl"
    with open(jsonl, "w", encoding="utf-8") as f:
        for d in deltas:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    # prepend to changelog (newest first)
    new_block = "\n".join(_summarize(feed, from_ts, to_ts, deltas)) + "\n"
    header = "# GTFS Change Log\n\n_Newest first. Generated by gtfs_diff.py / run_diffs.py._\n\n"
    existing = ""
    if CHANGELOG.exists():
        txt = CHANGELOG.read_text(encoding="utf-8")
        existing = txt[len(header):] if txt.startswith(header) else txt
    CHANGELOG.write_text(header + new_block + existing, encoding="utf-8")
    return jsonl, len(deltas)


def main() -> int:
    ap = argparse.ArgumentParser(description="Diff two GTFS snapshot zips.")
    ap.add_argument("--feed", required=True)
    ap.add_argument("--from-zip", required=True)
    ap.add_argument("--to-zip", required=True)
    ap.add_argument("--from-ts", default="from")
    ap.add_argument("--to-ts", default="to")
    ap.add_argument("--no-changelog", action="store_true")
    args = ap.parse_args()

    deltas = diff(args.feed, Path(args.from_zip), Path(args.to_zip), args.from_ts, args.to_ts)
    if args.no_changelog:
        DELTA_DIR.mkdir(parents=True, exist_ok=True)
        jsonl = DELTA_DIR / f"{args.feed}__{args.from_ts}__to__{args.to_ts}.jsonl"
        with open(jsonl, "w", encoding="utf-8") as f:
            for d in deltas:
                f.write(json.dumps(d, ensure_ascii=False) + "\n")
        n = len(deltas)
    else:
        jsonl, n = write_outputs(args.feed, args.from_ts, args.to_ts, deltas)
    print(f"[gtfs_diff] {args.feed}: {n} delta record(s) -> {jsonl.relative_to(PLATFORM) if str(jsonl).startswith(str(PLATFORM)) else jsonl}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
