#!/usr/bin/env python3
"""
derive2 stage 4 — systemwide KPI rollups (feeds the Live Ops Wall, S6).

5-minute LOCAL bins, systemwide (all bus routes), per day:
  vehicles_reporting     distinct vehicle_id with a ping in the bin (from the archive)
  scheduled_active       trips whose GTFS scheduled span covers the bin on the active
                         service day (stop_times x calendar) — the "supply" denominator
  service_ratio          vehicles_reporting / scheduled_active
  mean_abs_headway_dev_s mean |observed headway - scheduled headway| over the trailing
                         60 min of arrival events (stage 2)
  active_bunching_pairs  arrivals at a stop < BUNCH_PAIR_FRAC (25%) of the scheduled
                         headway apart, same route x direction, counted in the bin
  alerts_high/medium/low active GTFS-RT alerts by severity tier (effect enum) in the bin
                         (bus_alerts + subway_alerts jsonl)

Output: derived/kpis/date=YYYY-MM-DD/part-000.parquet
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from _common import (ALERT_SEVERITY, ARCHIVE, BUNCH_PAIR_FRAC, HEADWAY_DIR, KPI_DIR,
                     MAX_HEADWAY_S, duck_list, now_iso)
from gtfs_index import active_services_for_date, ensure_index, load_cache

EDT_OFFSET_S = 14400
BIN_S = 300  # 5 minutes


def _vehicles_reporting(day: str) -> pd.DataFrame:
    files = [Path(f) for f in glob.glob(
        str(ARCHIVE / "bus_vehicle_positions" / f"date={day}" / "**" / "*.parquet"),
        recursive=True)]
    if not files:
        return pd.DataFrame(columns=["bin_local", "vehicles_reporting"])
    con = duckdb.connect()
    # Distinct vehicles per POLL (poll_ts = observation clock). The poller cadence is
    # irregular (30s nominal but real gaps of several minutes), so a 5-min bin may contain
    # no poll. We take the LAST poll's vehicle count within each bin; bins with no poll are
    # forward-filled (carry last-known liveness) and flagged stale by the caller.
    per_poll = con.execute(f"""
        SELECT (CAST(poll_ts AS BIGINT) - {EDT_OFFSET_S}) AS local_ts,
               count(DISTINCT vehicle_id) AS veh
        FROM read_parquet({duck_list(files)}, union_by_name=true)
        WHERE vehicle_id IS NOT NULL
        GROUP BY 1 ORDER BY 1
    """).df()
    con.close()
    if per_poll.empty:
        return pd.DataFrame(columns=["bin_local", "vehicles_reporting", "poll_present"])
    per_poll["bin_local"] = (per_poll["local_ts"] // BIN_S) * BIN_S
    df = (per_poll.sort_values("local_ts").groupby("bin_local", as_index=False)
                  .agg(vehicles_reporting=("veh", "last")))
    df["poll_present"] = 1
    return df


def _scheduled_active(day: str, cache: dict, bins_local: np.ndarray) -> pd.DataFrame:
    """Count trips whose scheduled span covers each bin, for the active service day."""
    sched = cache["scheduled_stop_times"]
    tmeta = cache["trip_meta"].copy()
    tmeta["trip_id"] = tmeta["trip_id"].astype(str)
    active = active_services_for_date(cache["calendar"], cache["calendar_dates"], day)
    active_trips = set(tmeta.loc[tmeta["service_id"].astype(str).isin(active), "trip_id"])
    s = sched[sched["trip_id"].astype(str).isin(active_trips)]
    span = s.groupby("trip_id").agg(first_sec=("sched_arr_sec", "min"),
                                    last_sec=("sched_arr_sec", "max")).reset_index()
    if span.empty:
        return pd.DataFrame({"bin_local": bins_local, "scheduled_active": 0})
    first = span["first_sec"].to_numpy(dtype=np.float64)
    last = span["last_sec"].to_numpy(dtype=np.float64)
    # `bin_local` is already UTC-4 shifted, so (bin_local % 86400) is directly the local
    # seconds-after-midnight — no system-timezone dependence. GTFS schedule seconds can
    # exceed 86400 for owl (after-midnight) trips that belong to the PRIOR service day, so
    # a trip is "active" if the bin second OR (bin second + 86400) falls inside its span.
    counts = []
    for b in bins_local:
        bin_sec = int(b) % 86400
        active = ((first <= bin_sec) & (bin_sec <= last)) | \
                 ((first <= bin_sec + 86400) & (bin_sec + 86400 <= last))
        counts.append(int(np.sum(active)))
    return pd.DataFrame({"bin_local": bins_local, "scheduled_active": counts})


def _alerts_by_severity(day: str, bins_local: np.ndarray) -> pd.DataFrame:
    files = []
    for feed in ["bus_alerts", "subway_alerts"]:
        files += glob.glob(str(ARCHIVE / feed / f"date={day}" / "**" / "*.jsonl"), recursive=True)
    cols = ["bin_local", "alerts_high", "alerts_medium", "alerts_low", "alerts_total"]
    if not files:
        return pd.DataFrame(columns=cols)
    con = duckdb.connect()
    flist = "[" + ",".join("'" + f.replace("\\", "/") + "'" for f in files) + "]"
    # Count distinct alert_ids PRESENT IN THE FEED per 5-min bin (by poll_ts) — i.e. what
    # MTA was actively advertising in that window — bucketed by severity. This is the live
    # ops meaning; counting every period-active standing alert would over-report massively.
    try:
        df = con.execute(f"""
            SELECT DISTINCT alert_id, effect,
                   (CAST(poll_ts AS BIGINT) - {EDT_OFFSET_S}) AS local_ts
            FROM read_json({flist}, format='newline_delimited', union_by_name=true,
                           maximum_object_size=20000000)
            WHERE alert_id IS NOT NULL
        """).df()
    except Exception:
        con.close()
        return pd.DataFrame(columns=cols)
    con.close()
    if df.empty:
        return pd.DataFrame(columns=cols)
    df["bin_local"] = (df["local_ts"] // BIN_S) * BIN_S
    df["sev"] = df["effect"].map(lambda e: ALERT_SEVERITY.get(int(e) if pd.notna(e) else 8, "low"))
    df = df.drop_duplicates(["bin_local", "alert_id"])
    g = df.groupby("bin_local")
    out = pd.DataFrame({
        "alerts_high": g["sev"].apply(lambda s: int((s == "high").sum())),
        "alerts_medium": g["sev"].apply(lambda s: int((s == "medium").sum())),
        "alerts_low": g["sev"].apply(lambda s: int((s == "low").sum())),
        "alerts_total": g["alert_id"].nunique(),
    }).reset_index()
    return out


def process_day(day: str, cache: dict | None = None) -> dict:
    stats = dict(day=day, run_at=now_iso())
    if cache is None:
        cache = load_cache()
    veh = _vehicles_reporting(day)
    if veh.empty:
        stats["status"] = "no_input"
        return stats
    bins_local = np.arange(veh["bin_local"].min(), veh["bin_local"].max() + BIN_S, BIN_S)
    kpi = pd.DataFrame({"bin_local": bins_local}).merge(veh, on="bin_local", how="left")
    kpi["poll_present"] = kpi["poll_present"].fillna(0).astype(int)
    # forward-fill vehicle liveness across poll gaps; mark carried-forward bins stale
    kpi["vehicles_stale"] = (kpi["poll_present"] == 0).astype(int)
    kpi["vehicles_reporting"] = kpi["vehicles_reporting"].ffill().fillna(0).astype(int)

    sched_active = _scheduled_active(day, cache, bins_local)
    kpi = kpi.merge(sched_active, on="bin_local", how="left")
    kpi["scheduled_active"] = kpi["scheduled_active"].fillna(0).astype(int)
    kpi["service_ratio"] = np.where(kpi["scheduled_active"] > 0,
                                    kpi["vehicles_reporting"] / kpi["scheduled_active"], np.nan)

    # arrivals for headway-dev + bunching pairs
    arr_path = HEADWAY_DIR / f"date={day}" / "arrivals-000.parquet"
    hw_path = HEADWAY_DIR / f"date={day}" / "part-000.parquet"
    if arr_path.exists() and hw_path.exists():
        arr = pd.read_parquet(arr_path)
        hw = pd.read_parquet(hw_path)[["route_id", "direction_id", "stop_id", "local_hour",
                                       "sched_median_headway_s"]]
        arr = arr.dropna(subset=["headway_s"])
        arr["stop_id"] = arr["stop_id"].astype(str)
        arr = arr.merge(hw.astype({"stop_id": str}),
                        on=["route_id", "direction_id", "stop_id", "local_hour"], how="left")
        arr = arr[(arr["headway_s"] >= 0) & (arr["headway_s"] <= MAX_HEADWAY_S)].copy()
        arr["abs_hw_dev"] = np.where(arr["sched_median_headway_s"].notna(),
                                     (arr["headway_s"] - arr["sched_median_headway_s"]).abs(), np.nan)
        arr["bin_local"] = ((arr["arr_local"] // BIN_S) * BIN_S).astype(np.int64)
        arr["is_bunch"] = np.where(
            arr["sched_median_headway_s"].notna(),
            (arr["headway_s"] < BUNCH_PAIR_FRAC * arr["sched_median_headway_s"]).astype(int), 0)
        bunch = arr.groupby("bin_local")["is_bunch"].sum().rename("active_bunching_pairs").reset_index()
        kpi = kpi.merge(bunch, on="bin_local", how="left")
        kpi["active_bunching_pairs"] = kpi["active_bunching_pairs"].fillna(0).astype(int)
        # trailing-60min mean |headway dev|
        a = arr.dropna(subset=["abs_hw_dev"]).sort_values("arr_local")
        arr_local = a["arr_local"].to_numpy(dtype=np.float64)
        dev = a["abs_hw_dev"].to_numpy(dtype=np.float64)
        trail = []
        ntrail = []
        for b in bins_local:
            b_utc = b + EDT_OFFSET_S
            m = (arr_local <= b_utc) & (arr_local > b_utc - 3600)
            trail.append(float(np.mean(dev[m])) if m.any() else np.nan)
            ntrail.append(int(m.sum()))
        kpi["mean_abs_headway_dev_s"] = trail
        kpi["n_arrivals_trailing60"] = ntrail
    else:
        kpi["active_bunching_pairs"] = 0
        kpi["mean_abs_headway_dev_s"] = np.nan
        kpi["n_arrivals_trailing60"] = 0

    alerts = _alerts_by_severity(day, bins_local)
    if not alerts.empty:
        kpi = kpi.merge(alerts, on="bin_local", how="left")
    # alert state is slowly-varying; forward-fill across alert-feed poll gaps (then 0 the
    # leading bins before the first alert poll) so the Ops Wall doesn't blink to zero.
    for c in ["alerts_high", "alerts_medium", "alerts_low", "alerts_total"]:
        if c not in kpi.columns:
            kpi[c] = 0
        kpi[c] = kpi[c].ffill().fillna(0).astype(int)

    kpi["bin_utc"] = kpi["bin_local"] + EDT_OFFSET_S
    kpi["local_iso"] = pd.to_datetime(kpi["bin_local"], unit="s").dt.strftime("%Y-%m-%dT%H:%M")
    kpi["local_hour"] = (kpi["bin_local"] // 3600 % 24).astype(int)

    out_dir = KPI_DIR / f"date={day}"
    out_dir.mkdir(parents=True, exist_ok=True)
    kpi.to_parquet(out_dir / "part-000.parquet", index=False)
    stats.update(status="ok", bins=int(len(kpi)),
                 peak_vehicles=int(kpi["vehicles_reporting"].max()),
                 peak_scheduled=int(kpi["scheduled_active"].max()),
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
