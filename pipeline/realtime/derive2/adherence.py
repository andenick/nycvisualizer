#!/usr/bin/env python3
"""
derive2 stage 3 — schedule adherence.

Per trip, from the arrival events (stage 2) joined to GTFS stop_times:
  * start delay   = observed - scheduled at the trip's FIRST stop (min stop_sequence)
  * end delay     = observed - scheduled at the LAST observed stop
  * running-time delta by segment = (obs arr[next] - obs arr[prev])
                                    - (sched arr[next] - sched arr[prev])
    i.e. how much slower/faster the bus ran each stop-to-stop segment than scheduled.

Outputs (derived/adherence/date=YYYY-MM-DD/):
  trips-000.parquet    per-trip: start_delay_s, end_delay_s, mean/total running delta
  segments-000.parquet per-segment: from_stop, to_stop, obs_run_s, sched_run_s, run_delta_s
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from _common import ADHERENCE_DIR, HEADWAY_DIR, MAX_HEADWAY_S, now_iso
from gtfs_index import ensure_index, load_cache


def process_day(day: str, cache: dict | None = None) -> dict:
    stats = dict(day=day, run_at=now_iso())
    arr_path = HEADWAY_DIR / f"date={day}" / "arrivals-000.parquet"
    if not arr_path.exists():
        stats["status"] = "no_arrivals"
        return stats
    if cache is None:
        cache = load_cache()
    sched = cache["scheduled_stop_times"].copy()
    sched["trip_id"] = sched["trip_id"].astype(str)
    sched["stop_id"] = sched["stop_id"].astype(str)

    arr = pd.read_parquet(arr_path)
    arr["trip_id"] = arr["trip_id"].astype(str)
    arr["stop_id"] = arr["stop_id"].astype(str)
    arr = arr.merge(sched[["trip_id", "stop_id", "stop_seq", "sched_arr_sec"]],
                    on=["trip_id", "stop_id"], how="inner", suffixes=("", "_s"))
    if arr.empty:
        stats["status"] = "no_scheduled_join"
        return stats
    # keep one arrival per (trip, stop) — earliest observed
    arr = arr.sort_values(["trip_id", "stop_seq", "arr_ts"]).drop_duplicates(["trip_id", "stop_seq"])
    arr["obs_sec"] = (arr["arr_local"] % 86400).astype(float)
    arr["sched_sec"] = (arr["sched_arr_sec"] % 86400).astype(float)

    seg_rows = []
    trip_rows = []
    for tid, g in arr.groupby("trip_id", sort=False):
        g = g.sort_values("stop_seq")
        if len(g) < 2:
            continue
        route = g["route_id"].iloc[0]
        direction = g["direction_id"].iloc[0]
        obs = g["arr_ts"].to_numpy(dtype=np.float64)
        sc = g["sched_arr_sec"].to_numpy(dtype=np.float64)
        stops = g["stop_id"].to_numpy()
        seqs = g["stop_seq"].to_numpy()
        obs_run = np.diff(obs)
        sched_run = np.diff(sc)
        run_delta = obs_run - sched_run
        good = (sched_run > 0) & (obs_run > 0) & (obs_run <= MAX_HEADWAY_S)
        seg_rows.append(pd.DataFrame({
            "trip_id": tid, "route_id": route, "direction_id": direction,
            "from_stop": stops[:-1], "to_stop": stops[1:], "stop_seq": seqs[:-1],
            "obs_run_s": obs_run, "sched_run_s": sched_run, "run_delta_s": run_delta,
        })[good])
        start_delay = float((g["obs_sec"].iloc[0]) - (g["sched_sec"].iloc[0]))
        end_delay = float((g["obs_sec"].iloc[-1]) - (g["sched_sec"].iloc[-1]))
        rd = run_delta[good]
        trip_rows.append(dict(
            trip_id=tid, route_id=route, direction_id=direction,
            n_stops_observed=int(len(g)), start_delay_s=start_delay, end_delay_s=end_delay,
            n_segments=int(good.sum()),
            mean_running_delta_s=float(np.mean(rd)) if len(rd) else np.nan,
            total_running_delta_s=float(np.sum(rd)) if len(rd) else np.nan))

    out_dir = ADHERENCE_DIR / f"date={day}"
    out_dir.mkdir(parents=True, exist_ok=True)
    trips_df = pd.DataFrame(trip_rows)
    segs_df = pd.concat(seg_rows, ignore_index=True) if seg_rows else pd.DataFrame(
        columns=["trip_id", "route_id", "direction_id", "from_stop", "to_stop", "stop_seq",
                 "obs_run_s", "sched_run_s", "run_delta_s"])
    trips_df.to_parquet(out_dir / "trips-000.parquet", index=False)
    segs_df.to_parquet(out_dir / "segments-000.parquet", index=False)
    stats.update(status="ok", trips=int(len(trips_df)), segments=int(len(segs_df)),
                 median_start_delay_s=float(trips_df["start_delay_s"].median()) if len(trips_df) else None,
                 output=out_dir.as_posix())
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True)
    args = ap.parse_args()
    ensure_index()
    print(json.dumps(process_day(args.day), indent=2))


if __name__ == "__main__":
    main()
