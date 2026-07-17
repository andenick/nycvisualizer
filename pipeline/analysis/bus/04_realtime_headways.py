"""04 - Observed headways & bunching from the LIVE realtime archive. RERUNNABLE.

Source: rt_bus_vehicle_positions (BusTime GTFS-RT vehicle positions archive at
        realtime/archive/bus_vehicle_positions/date=.../hour=...). The archive
        GROWS every poll; this script recomputes over whatever exists NOW and
        stamps the exact window used. Re-run it as the archive deepens; numbers
        strengthen with depth.

Method (nearest-point passage approximation):
  * A stop "passage" = the first RT frame in which a vehicle's reported next/near
    stop_id changes to S (lag(stop_id) over vehicle, ordered by time). This
    approximates when the bus began serving that stop; it is NOT a fare-gate
    arrival and slightly leads true arrival.
  * Observed headway at (route,direction,stop) = gap between consecutive passages
    (all vehicles) sorted by time.
  * Bunching index = coefficient of variation (std/mean) of a route's headways;
    CV>~0.5 indicates irregular spacing / bunching.
  * Adherence: observed median headway vs GTFS scheduled headway for the clock
    period the archive covers (03_scheduled_headways_by_period).

HONEST CAVEAT: with only a few hours of archive these are PRELIMINARY. Do not cite
as stable reliability findings; they are illustrative and converge as depth grows.
"""
from __future__ import annotations
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from common import connect, write_table, savefig, OUT

con = connect()
print("[04] observed headways from rt_bus_vehicle_positions (RERUNNABLE)")

# ---- archive-depth stamp (computed at runtime) ----
span = con.execute("""
    SELECT min(to_timestamp(timestamp)) AS t0, max(to_timestamp(timestamp)) AS t1,
           count(*) AS frames, count(DISTINCT vehicle_id) AS vehicles,
           count(DISTINCT route_id) AS routes,
           count(DISTINCT (date::VARCHAR || '-' || hour)) AS distinct_hours
    FROM rt_bus_vehicle_positions
    WHERE stop_id IS NOT NULL AND stop_id <> ''
""").df().iloc[0]
t0, t1 = pd.Timestamp(span.t0), pd.Timestamp(span.t1)
depth_h = (t1 - t0).total_seconds() / 3600.0
STAMP = (f"archive window {t0:%Y-%m-%d %H:%M} - {t1:%H:%M} America/New_York "
         f"(~{depth_h:.1f} h, {int(span.distinct_hours)} hour-partitions); "
         f"{int(span.frames):,} frames, {int(span.vehicles):,} vehicles, "
         f"{int(span.routes)} routes")
print("  STAMP:", STAMP)
with open(os.path.join(OUT, "04_archive_stamp.txt"), "w") as f:
    f.write(STAMP + "\n")

# ---- passages via stop_id transitions per vehicle ----
con.execute("""
CREATE TEMP TABLE passages AS
WITH ordered AS (
  SELECT route_id, direction_id, vehicle_id, stop_id,
         to_timestamp(timestamp) AS ts,
         lag(stop_id) OVER (PARTITION BY vehicle_id ORDER BY timestamp) AS prev_stop
  FROM rt_bus_vehicle_positions
  WHERE stop_id IS NOT NULL AND stop_id <> '' AND route_id IS NOT NULL
)
SELECT route_id, direction_id, stop_id, vehicle_id, ts
FROM ordered
WHERE prev_stop IS NULL OR stop_id <> prev_stop;  -- new-stop assignment = passage
""")
np_ = con.execute("SELECT count(*) FROM passages").fetchone()[0]
print(f"  detected {np_:,} stop passages")

# ---- headways at (route,direction,stop) ----
con.execute("""
CREATE TEMP TABLE headways AS
WITH g AS (
  SELECT route_id, direction_id, stop_id, ts,
         date_diff('second', lag(ts) OVER (PARTITION BY route_id,direction_id,stop_id ORDER BY ts), ts)/60.0 AS hw_min
  FROM passages
)
SELECT route_id, direction_id, stop_id, hw_min
FROM g WHERE hw_min IS NOT NULL AND hw_min > 0 AND hw_min < 180;  -- drop day-boundary/garage gaps
""")

# route-level bunching summary
route_hw = con.execute("""
    SELECT route_id,
           count(*) AS n_headways,
           count(DISTINCT stop_id) AS n_stops,
           round(median(hw_min),1) AS median_headway_min,
           round(avg(hw_min),1) AS mean_headway_min,
           round(stddev_samp(hw_min)/NULLIF(avg(hw_min),0),2) AS bunching_cv
    FROM headways GROUP BY 1 HAVING count(*) >= 5
    ORDER BY bunching_cv DESC
""").df()
write_table(route_hw, "04_observed_headways_route", "route_headways")

# stop-level (busiest observed)
stop_hw = con.execute("""
    SELECT route_id, direction_id, stop_id,
           count(*) AS n_headways,
           round(median(hw_min),1) AS median_headway_min,
           round(stddev_samp(hw_min)/NULLIF(avg(hw_min),0),2) AS bunching_cv
    FROM headways GROUP BY 1,2,3 HAVING count(*) >= 4
    ORDER BY n_headways DESC
""").df()
write_table(stop_hw, "04_observed_headways_stop", "stop_headways")

# ---- adherence vs scheduled (clock period the archive covers) ----
# session TZ is America/New_York, so to_timestamp is already local clock time
hr_edt = int((t0 + (t1 - t0) / 2).hour)
period = ("AM_peak" if 6 <= hr_edt <= 9 else "Midday" if 10 <= hr_edt <= 15
          else "PM_peak" if 16 <= hr_edt <= 19 else "Evening" if 20 <= hr_edt <= 23 else "Night")
print(f"  archive mid-clock ~{hr_edt:02d}:00 EDT -> scheduled period '{period}'")

sched_path = os.path.join(OUT, "03_scheduled_headways_by_period.parquet")
adher = pd.DataFrame()
if os.path.exists(sched_path):
    sched = pd.read_parquet(sched_path)
    sched = sched[sched.period == period]
    sched["route_norm"] = (sched.route.str.upper()
                           .str.replace("-SBS", "", regex=False)
                           .str.replace(r"[^A-Z0-9]", "", regex=True))
    sched_r = sched.groupby("route_norm", as_index=False).headway_min.mean().rename(
        columns={"headway_min": "scheduled_headway_min"})
    rh = route_hw.copy()
    rh["route_norm"] = (rh.route_id.str.upper()
                        .str.replace("-SBS", "", regex=False)
                        .str.replace(r"[^A-Z0-9]", "", regex=True))
    adher = rh.merge(sched_r, on="route_norm", how="inner")
    adher["obs_minus_sched_min"] = (adher.median_headway_min - adher.scheduled_headway_min).round(1)
    adher = adher[["route_id", "n_headways", "median_headway_min",
                   "scheduled_headway_min", "obs_minus_sched_min", "bunching_cv"]]
    adher = adher.sort_values("obs_minus_sched_min", ascending=False)
    write_table(adher, "04_adherence_vs_scheduled", "adherence")

# ---- charts ----
if len(route_hw):
    fig, ax = plt.subplots(figsize=(9, 6))
    top = route_hw.head(20).iloc[::-1]
    ax.barh(top.route_id, top.bunching_cv, color="#762a83")
    ax.set_xlabel("Headway CV (bunching index)")
    ax.set_title(f"Most irregular bus headways (observed)\nPRELIMINARY - {STAMP}", fontsize=9)
    savefig(fig, "04_bunching_index"); plt.close(fig)

print(f"[04] done. {STAMP}")
