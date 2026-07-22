#!/usr/bin/env python3
"""
derive2 stage 2 — observed headways + bunching.

Arrival events per route x stop x direction, two detectors:
  PRIMARY  shape-offset crossing: the resampled trajectory (stage 1) crosses each stop's
           projected shape offset -> interpolated crossing timestamp = arrival.
  FALLBACK first-seen per (trip, stop_id): earliest archive ts a trip reports a stop_id
           (used for trips with no usable trajectory). S0 validated this gives plausible
           M15 rush headways (5.3-12 min).

Then: observed headway series (consecutive arrivals at a stop for a route x direction),
scheduled-headway join (GTFS stop_times for the active service day), deviation, and a
bunching index per route x stop x LOCAL hour = {headway CV, share of gaps < 50% scheduled}.

Timezone: observed ts are UTC epoch; NYC is EDT (UTC-4) for the whole archive window, so
local seconds-after-midnight = ts - 14400. Bucketing is by LOCAL date/hour so rush-hour
buckets and the scheduled join line up. (No DST transition inside the archive window.)

Outputs (derived/observed_headways/date=YYYY-MM-DD/):
  part-000.parquet     route x dir x stop x local_hour aggregate (the published grain)
  arrivals-000.parquet arrival events (route,dir,stop,trip,arr_ts,method,sched_arr_sec)
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from _common import (ARCHIVE, BUNCH_SHORT_FRAC, HEADWAY_DIR, MAX_HEADWAY_S, MIN_HEADWAY_S,
                     TRAJ_DIR, duck_list, now_iso)
from gtfs_index import active_services_for_date, ensure_index, load_cache

EDT_OFFSET_S = 14400  # UTC-4


def _crossings(traj: pd.DataFrame, stop_offsets: pd.DataFrame) -> pd.DataFrame:
    """Interpolate the crossing ts of each stop offset along each trip's resampled series."""
    so_by_shape = {sid: g for sid, g in stop_offsets.groupby("shape_id", sort=False)}
    rows = []
    for tid, g in traj.sort_values(["trip_id", "ts"]).groupby("trip_id", sort=False):
        sid = g["shape_id"].iloc[0]
        so = so_by_shape.get(sid)
        if so is None or len(g) < 2:
            continue
        o = g["offset_ft"].to_numpy(dtype=np.float64)
        t = g["ts"].to_numpy(dtype=np.int64)
        o = np.maximum.accumulate(o)  # guarantee monotone for searchsorted
        s = so["stop_offset_ft"].to_numpy(dtype=np.float64)
        idx = np.searchsorted(o, s, side="left")
        valid = (idx > 0) & (idx < len(o))
        if not valid.any():
            continue
        iv = idx[valid]
        o0, o1 = o[iv - 1], o[iv]
        t0, t1 = t[iv - 1], t[iv]
        denom = np.where(o1 > o0, o1 - o0, 1.0)
        frac = (s[valid] - o0) / denom
        arr = t0 + frac * (t1 - t0)
        sub = so[valid]
        rows.append(pd.DataFrame({
            "trip_id": tid, "route_id": g["route_id"].iloc[0],
            "direction_id": g["direction_id"].iloc[0], "stop_id": sub["stop_id"].to_numpy(),
            "arr_ts": arr.astype(np.int64), "method": "crossing",
        }))
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(
        columns=["trip_id", "route_id", "direction_id", "stop_id", "arr_ts", "method"])


def _first_seen(day: str, exclude_trips: set[str], trip_meta: pd.DataFrame) -> pd.DataFrame:
    """Fallback arrivals: earliest archive ts per (trip, stop_id) for trips lacking a trajectory."""
    files = [Path(f) for f in glob.glob(
        str(ARCHIVE / "bus_vehicle_positions" / f"date={day}" / "**" / "*.parquet"),
        recursive=True)]
    if not files:
        return pd.DataFrame(columns=["trip_id", "route_id", "direction_id", "stop_id",
                                     "arr_ts", "method"])
    con = duckdb.connect()
    fs = con.execute(f"""
        SELECT trip_id, stop_id, MIN(CAST(COALESCE(timestamp, poll_ts) AS BIGINT)) AS arr_ts
        FROM read_parquet({duck_list(files)}, union_by_name=true)
        WHERE trip_id IS NOT NULL AND stop_id IS NOT NULL
        GROUP BY trip_id, stop_id
    """).df()
    con.close()
    if exclude_trips:
        fs = fs[~fs["trip_id"].isin(exclude_trips)]
    fs = fs.merge(trip_meta[["trip_id", "route_id", "direction_id"]], on="trip_id", how="inner")
    fs["method"] = "first_seen"
    return fs[["trip_id", "route_id", "direction_id", "stop_id", "arr_ts", "method"]]


def process_day(day: str, cache: dict | None = None) -> dict:
    stats = dict(day=day, run_at=now_iso())
    traj_path = TRAJ_DIR / f"date={day}" / "part-000.parquet"
    if not traj_path.exists():
        stats["status"] = "no_trajectory"
        return stats
    if cache is None:
        cache = load_cache()
    trip_meta = cache["trip_meta"]
    stop_offsets = cache["stop_offsets"]
    stops = cache.get("stops", pd.DataFrame(columns=["stop_id", "stop_name"]))
    sched = cache["scheduled_stop_times"]

    traj = pd.read_parquet(traj_path)
    if len(traj):
        cross = _crossings(traj, stop_offsets)
    else:
        cross = pd.DataFrame(columns=["trip_id", "route_id", "direction_id", "stop_id",
                                      "arr_ts", "method"])
    traj_trips = set(traj["trip_id"].unique()) if len(traj) else set()
    fs = _first_seen(day, traj_trips, trip_meta)
    arrivals = pd.concat([cross, fs], ignore_index=True)
    stats["arrivals_crossing"] = int(len(cross))
    stats["arrivals_first_seen"] = int(len(fs))
    if arrivals.empty:
        stats["status"] = "no_arrivals"
        return stats

    arrivals["stop_id"] = arrivals["stop_id"].astype(str)
    arrivals["route_id"] = arrivals["route_id"].astype(str)
    # local clock
    arrivals["arr_local"] = arrivals["arr_ts"] - EDT_OFFSET_S
    arrivals["local_date"] = pd.to_datetime(arrivals["arr_local"], unit="s").dt.strftime("%Y-%m-%d")
    arrivals["local_hour"] = (arrivals["arr_local"] // 3600 % 24).astype(int)
    arrivals["local_sec"] = (arrivals["arr_local"] % 86400).astype(int)

    # scheduled arrival per (trip, stop) — direct trip_id join (RT==GTFS ids)
    sched2 = sched.copy()
    sched2["trip_id"] = sched2["trip_id"].astype(str)
    sched2["stop_id"] = sched2["stop_id"].astype(str)
    arrivals = arrivals.merge(sched2[["trip_id", "stop_id", "sched_arr_sec"]],
                              on=["trip_id", "stop_id"], how="left")
    arrivals["deviation_s"] = np.where(
        arrivals["sched_arr_sec"].notna(),
        arrivals["local_sec"] - (arrivals["sched_arr_sec"] % 86400), np.nan)

    # ---- observed headway series: consecutive arrivals at a stop for route x dir ----
    arrivals = arrivals.sort_values(["route_id", "direction_id", "stop_id", "arr_ts"])
    grp = arrivals.groupby(["route_id", "direction_id", "stop_id"], sort=False)
    arrivals["headway_s"] = grp["arr_ts"].diff()
    obs = arrivals[(arrivals["headway_s"] >= MIN_HEADWAY_S)
                   & (arrivals["headway_s"] <= MAX_HEADWAY_S)].copy()

    # ---- scheduled headway per route x dir x stop x local_hour ----
    tm = trip_meta[["trip_id", "route_id", "direction_id"]].copy()
    tm["trip_id"] = tm["trip_id"].astype(str)
    tm["route_id"] = tm["route_id"].astype(str)
    active = active_services_for_date(cache["calendar"], cache["calendar_dates"], day)
    tmeta_svc = trip_meta.copy()
    tmeta_svc["trip_id"] = tmeta_svc["trip_id"].astype(str)
    active_trips = set(tmeta_svc.loc[tmeta_svc["service_id"].astype(str).isin(active), "trip_id"])
    ssched = sched2[sched2["trip_id"].isin(active_trips)].merge(tm, on="trip_id", how="inner")
    ssched["stop_id"] = ssched["stop_id"].astype(str)
    ssched["local_hour"] = (ssched["sched_arr_sec"] // 3600 % 24).astype(int)
    ssched = ssched.sort_values(["route_id", "direction_id", "stop_id", "sched_arr_sec"])
    ssched["sched_gap"] = ssched.groupby(
        ["route_id", "direction_id", "stop_id"], sort=False)["sched_arr_sec"].diff()
    sched_hw = (ssched[(ssched["sched_gap"] > 0) & (ssched["sched_gap"] <= MAX_HEADWAY_S)]
                .groupby(["route_id", "direction_id", "stop_id", "local_hour"], as_index=False)
                .agg(sched_median_headway_s=("sched_gap", "median"),
                     sched_n=("sched_gap", "size")))

    # ---- aggregate observed to route x dir x stop x local_hour ----
    def _cv(x):
        m = x.mean()
        return float(x.std() / m) if m and m > 0 else np.nan

    obs2 = obs.merge(sched_hw, on=["route_id", "direction_id", "stop_id", "local_hour"], how="left")
    obs2["is_short_vs_sched"] = np.where(
        obs2["sched_median_headway_s"].notna(),
        (obs2["headway_s"] < BUNCH_SHORT_FRAC * obs2["sched_median_headway_s"]).astype(float),
        np.nan)
    agg = obs2.groupby(["route_id", "direction_id", "stop_id", "local_date", "local_hour"]).agg(
        n_headways=("headway_s", "size"),
        n_arrivals=("arr_ts", "nunique"),
        median_headway_s=("headway_s", "median"),
        mean_headway_s=("headway_s", "mean"),
        headway_cv=("headway_s", _cv),
        min_headway_s=("headway_s", "min"),
        max_headway_s=("headway_s", "max"),
        sched_median_headway_s=("sched_median_headway_s", "median"),
        bunch_share_lt50_sched=("is_short_vs_sched", "mean"),
        median_deviation_s=("deviation_s", "median"),
    ).reset_index()
    # bunching share vs OBSERVED median (works even without a schedule) + combined index
    def _short_obs(g):
        med = g.median()
        return float((g < BUNCH_SHORT_FRAC * med).mean()) if med and med > 0 else np.nan
    obs_short = obs.groupby(["route_id", "direction_id", "stop_id", "local_date", "local_hour"]
                            )["headway_s"].apply(_short_obs).rename("bunch_share_lt50_obs").reset_index()
    agg = agg.merge(obs_short, on=["route_id", "direction_id", "stop_id", "local_date", "local_hour"],
                    how="left")
    agg["headway_deviation_s"] = agg["median_headway_s"] - agg["sched_median_headway_s"]
    # combined bunching_index: mean of CV-normalized and short-share (both in ~[0,1+])
    agg["bunching_index"] = agg[["headway_cv", "bunch_share_lt50_sched"]].mean(axis=1, skipna=True)
    agg = agg.merge(stops.astype({"stop_id": str}), on="stop_id", how="left")
    agg["archive_depth_days"] = None  # stamped by orchestrator/packaging

    out_dir = HEADWAY_DIR / f"date={day}"
    out_dir.mkdir(parents=True, exist_ok=True)
    agg.to_parquet(out_dir / "part-000.parquet", index=False)
    # event-level arrivals (feeds KPIs + adherence)
    arr_out = arrivals[["route_id", "direction_id", "stop_id", "trip_id", "arr_ts",
                        "arr_local", "local_hour", "method", "sched_arr_sec",
                        "deviation_s", "headway_s"]].copy()
    arr_out.to_parquet(out_dir / "arrivals-000.parquet", index=False)

    stats.update(status="ok", agg_rows=int(len(agg)), arrival_events=int(len(arrivals)),
                 observed_headways=int(len(obs)),
                 sched_matched=int(agg["sched_median_headway_s"].notna().sum()),
                 output=(out_dir / "part-000.parquet").as_posix())
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True)
    args = ap.parse_args()
    ensure_index()
    print(json.dumps(process_day(args.day), indent=2))


if __name__ == "__main__":
    main()
