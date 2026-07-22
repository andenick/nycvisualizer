#!/usr/bin/env python3
"""
derive2 orchestrator — idempotent, incremental, hourly-safe.

For each archive day it runs the four stages in order:
    trajectories -> headways -> adherence -> kpis
and writes a per-day DATA_QUALITY.json (per-feed per-hour coverage %, gap flags, incl.
the known 2026-07-21 poller-suspension window). It is safe to re-run: a day is skipped
if its archive input signature (file count + latest mtime) is unchanged since the last
successful run, so the hourly task only reprocesses days that gained new complete hours.

Modes:
  (default)     incremental — process days whose input changed since last run
  --backfill    process every archive day (still skips unchanged ones unless --force)
  --day D       process a single day
  --force       ignore the signature cache and reprocess
  --stamp-depth re-stamp archive_depth_days into headway outputs (done automatically)

State: realtime/derive2/DERIVE2_STATE.json   (canonical, resumable)
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb

from _common import (ARCHIVE, COVERAGE_PARTIAL_FRAC, DERIVED, DERIVE2, HIGH_VOLUME_FEEDS,
                     KNOWN_GAPS, duck_list, in_known_gap, now_iso)
import trajectories
import headways
import adherence
import kpis
from gtfs_index import ensure_index, load_cache

STATE_FILE = DERIVE2 / "DERIVE2_STATE.json"
DQ_DIR = DERIVED / "data_quality"

# feeds whose per-hour coverage we report (parquet -> row counts; jsonl -> file counts)
PARQUET_FEEDS = ["bus_vehicle_positions", "bus_trip_updates", "subway_gtfs",
                 "citibike_station_status"]
JSONL_FEEDS = ["bus_alerts", "subway_alerts"]


def _archive_days() -> list[str]:
    days = set()
    for feed in PARQUET_FEEDS:
        for p in glob.glob(str(ARCHIVE / feed / "date=*")):
            days.add(Path(p).name.split("=", 1)[1])
    return sorted(days)


def _day_signature(day: str) -> str:
    """Cheap change-detector: (file count, max mtime) over the day's high-volume feeds."""
    n, mx = 0, 0.0
    for feed in PARQUET_FEEDS:
        for f in glob.glob(str(ARCHIVE / feed / f"date={day}" / "**" / "*.parquet"),
                           recursive=True):
            n += 1
            mx = max(mx, os.path.getmtime(f))
    return f"{n}:{mx:.0f}"


def _load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"created": now_iso(), "days": {}}


def _save_state(state: dict) -> None:
    state["updated"] = now_iso()
    STATE_FILE.write_text(json.dumps(state, indent=2))


def _baseline_counts(con) -> dict:
    """Median rows per (feed, hour-of-day) across full-coverage days (>=20 hours)."""
    base = {}
    for feed in PARQUET_FEEDS:
        fs = glob.glob(str(ARCHIVE / feed / "**" / "*.parquet"), recursive=True)
        if not fs:
            continue
        df = con.execute(f"""
            SELECT date, hour, count(*) AS c
            FROM read_parquet({duck_list([Path(f) for f in fs])}, union_by_name=true)
            GROUP BY date, hour
        """).df()
        # full days = those with >= 20 distinct hours. Compare on the native datetime index
        # (string coercion of datetime64[us] vs Timestamp formats differently and matches 0).
        full = df.groupby("date")["hour"].nunique()
        full_days = full[full >= 20].index
        fd = df[df["date"].isin(full_days)]
        med = fd.groupby("hour")["c"].median()
        base[feed] = {str(h): float(v) for h, v in med.items()}
    return base


def compute_data_quality(day: str, con, baseline: dict) -> dict:
    now_utc = datetime.now(timezone.utc)
    cur_day = now_utc.strftime("%Y-%m-%d")
    cur_hour = now_utc.hour
    report = {"day": day, "generated_at": now_iso(), "feeds": {}, "known_gaps": [],
              "partial_hours": [], "missing_hours": []}
    for g in KNOWN_GAPS:
        gs = datetime.fromisoformat(g["start"].replace("Z", "+00:00"))
        ge = datetime.fromisoformat(g["end"].replace("Z", "+00:00"))
        if gs.strftime("%Y-%m-%d") <= day <= ge.strftime("%Y-%m-%d"):
            report["known_gaps"].append(g)

    for feed in PARQUET_FEEDS:
        fs = glob.glob(str(ARCHIVE / feed / f"date={day}" / "**" / "*.parquet"), recursive=True)
        counts = {}
        if fs:
            df = con.execute(f"""
                SELECT hour, count(*) AS c
                FROM read_parquet({duck_list([Path(f) for f in fs])}, union_by_name=true)
                GROUP BY hour
            """).df()
            counts = {str(h): int(c) for h, c in zip(df["hour"], df["c"])}
        feed_rep = {"hours": {}, "coverage_pct_mean": None}
        covs = []
        for h in range(24):
            hh = f"{h:02d}"
            rows = counts.get(hh, 0)
            base = baseline.get(feed, {}).get(hh, 0.0)
            cov = round(100.0 * rows / base, 1) if base > 0 else (100.0 if rows > 0 else None)
            kg = in_known_gap(feed, day, h)
            in_progress = (day == cur_day and h >= cur_hour)
            before_start = (day == cur_day and False)
            status = "ok"
            if in_progress and rows == 0:
                status = "in_progress"
            elif kg and (rows == 0 or (cov is not None and cov < 100)):
                status = "known_gap"
            elif rows == 0:
                status = "missing"
                if not in_progress:
                    report["missing_hours"].append(f"{feed}:{hh}")
            elif cov is not None and cov < COVERAGE_PARTIAL_FRAC * 100:
                status = "partial"
                report["partial_hours"].append(f"{feed}:{hh}")
            feed_rep["hours"][hh] = {"rows": rows, "coverage_pct": cov, "status": status}
            if status == "ok" and cov is not None:
                covs.append(cov)
        feed_rep["coverage_pct_mean"] = round(sum(covs) / len(covs), 1) if covs else None
        feed_rep["exclude_from_stats_hours"] = [
            h for h, v in feed_rep["hours"].items()
            if v["status"] in ("partial", "known_gap", "missing")]
        report["feeds"][feed] = feed_rep

    for feed in JSONL_FEEDS:
        files = glob.glob(str(ARCHIVE / feed / f"date={day}" / "**" / "*.jsonl"), recursive=True)
        by_hour = {}
        for f in files:
            hh = Path(f).parent.name.split("=", 1)[1]
            by_hour[hh] = by_hour.get(hh, 0) + 1
        report["feeds"][feed] = {"poll_files_by_hour": by_hour,
                                 "hours_present": sorted(by_hour)}

    out = DQ_DIR / f"date={day}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "DATA_QUALITY.json").write_text(json.dumps(report, indent=2))
    return report


def _archive_depth_days() -> int:
    days = _archive_days()
    return len(days)


def process_day(day: str, cache: dict, con, baseline: dict, depth_days: int) -> dict:
    res = {"day": day}
    res["trajectories"] = trajectories.process_day(day, cache=cache)
    res["headways"] = headways.process_day(day, cache=cache)
    res["adherence"] = adherence.process_day(day, cache=cache)
    res["kpis"] = kpis.process_day(day, cache=cache)
    # stamp archive depth into the headway aggregate (PRELIMINARY consumers key off this)
    hw = DERIVED / "observed_headways" / f"date={day}" / "part-000.parquet"
    if hw.exists():
        try:
            import pandas as pd
            d = pd.read_parquet(hw)
            d["archive_depth_days"] = depth_days
            d["preliminary"] = depth_days < 14
            d.to_parquet(hw, index=False)
        except Exception as e:  # pragma: no cover
            res["stamp_error"] = str(e)
    res["data_quality"] = {"written": True}
    compute_data_quality(day, con, baseline)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--day")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    ensure_index()
    cache = load_cache()
    con = duckdb.connect()
    baseline = _baseline_counts(con)
    depth_days = _archive_depth_days()
    state = _load_state()

    if args.day:
        targets = [args.day]
    elif args.backfill:
        targets = _archive_days()
    else:
        # incremental: any day whose signature changed (usually just the current day)
        targets = []
        for d in _archive_days():
            sig = _day_signature(d)
            if args.force or state["days"].get(d, {}).get("sig") != sig:
                targets.append(d)

    summary = {"run_at": now_iso(), "targets": targets, "depth_days": depth_days, "days": {}}
    for d in targets:
        sig = _day_signature(d)
        if not args.force and not args.day and state["days"].get(d, {}).get("sig") == sig:
            continue
        r = process_day(d, cache, con, baseline, depth_days)
        state["days"][d] = {"sig": sig, "processed_at": now_iso(),
                            "traj_rows": r["trajectories"].get("output_rows"),
                            "headway_rows": r["headways"].get("agg_rows"),
                            "unmatched_trip_rate": r["trajectories"].get("unmatched_trip_rate")}
        _save_state(state)
        summary["days"][d] = {
            "trajectories": r["trajectories"].get("status"),
            "traj_rows": r["trajectories"].get("output_rows"),
            "unmatched_trip_rate": r["trajectories"].get("unmatched_trip_rate"),
            "headway_agg_rows": r["headways"].get("agg_rows"),
            "kpi_bins": r["kpis"].get("bins"),
        }
    _save_state(state)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
