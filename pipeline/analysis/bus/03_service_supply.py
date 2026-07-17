"""03 - Scheduled service SUPPLY from GTFS static + demand-vs-supply join.

Source: transit_gtfs_trips / _stop_times / _routes / _stops (6 MTA bus feeds).
This is the STOP-LEVEL scheduled service view (from GTFS, not APC): stop_times
gives every scheduled arrival at every stop. Demand (script 01) is route-level.

Method notes:
  * The 5 borough feeds + MTA Bus Co feed each carry the full routes.txt but a
    route's TRIPS live in exactly ONE feed (verified: B62->brooklyn, M15->manhattan),
    so grouping trips by route_short_name does not double-count across feeds.
  * A single representative WEEKDAY = the highest-trip weekday service_id per feed
    (MTA ships several date-range "picks"; one actual weekday uses one of them).
  * Route names normalized (strip '-SBS'/'+', non-alnum) so local+SBS of a corridor
    combine, matching the ridership dataset's '+' SBS suffix for the demand join.
"""
from __future__ import annotations
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from common import connect, borough_expr, write_table, savefig

con = connect()
print("[03] scheduled service supply from GTFS static")

# --- representative weekday = all weekday service_ids (school-closed calendar).
# Service_id prefixes (MQ/MV/OF/GH/EN/QV/CA...) are garage codes sharing one pick
# ('_C6-'), so they are COMPLEMENTARY across garages (no double-count). We exclude
# the 'Weekday-SDon' school-day variant, which duplicates the base weekday trips. ---
con.execute("""
CREATE TEMP TABLE wk_svc AS
SELECT DISTINCT feed, service_id
FROM transit_gtfs_trips
WHERE feed LIKE 'bus%' AND service_id ILIKE '%weekday%' AND service_id NOT ILIKE '%SDon%';
""")
print("  weekday service_ids used:", con.execute("SELECT count(*) FROM wk_svc").fetchone()[0])

# --- weekday trips + normalized route name + first departure second ---
con.execute(r"""
CREATE TEMP TABLE trip_start AS
SELECT st.feed, st.trip_id,
       MIN(CAST(split_part(st.departure_time,':',1) AS INT)*3600
         + CAST(split_part(st.departure_time,':',2) AS INT)*60
         + CAST(split_part(st.departure_time,':',3) AS INT)) AS start_sec
FROM transit_gtfs_stop_times st
WHERE st.feed LIKE 'bus%' AND st.departure_time <> '' AND st.departure_time IS NOT NULL
GROUP BY 1,2;
""")
con.execute(r"""
CREATE TEMP TABLE wk_trips AS
SELECT t.feed, t.trip_id, r.route_short_name AS route,
       upper(regexp_replace(regexp_replace(r.route_short_name,'-SBS',''),'[^A-Za-z0-9]','','g')) AS route_norm,
       t.direction_id, ts.start_sec,
       (CAST(ts.start_sec/3600 AS INT) % 24) AS start_hour
FROM transit_gtfs_trips t
JOIN wk_svc s ON t.feed=s.feed AND t.service_id=s.service_id
JOIN transit_gtfs_routes r ON t.feed=r.feed AND t.route_id=r.route_id
JOIN trip_start ts ON t.feed=ts.feed AND t.trip_id=ts.trip_id;
""")
n_trips = con.execute("SELECT count(*) FROM wk_trips").fetchone()[0]
print(f"  representative-weekday bus trips: {n_trips:,}")

bor = borough_expr("route")

# --- 1. trips/hour per route x direction x hour ---
tph = con.execute(f"""
    SELECT route, {bor} AS borough, direction_id, start_hour AS hour, count(*) AS trips
    FROM wk_trips GROUP BY 1,2,3,4 ORDER BY 1,3,4
""").df()
write_table(tph, "03_trips_per_hour_route_dir", "trips_per_hour")

# system trips/hour profile
sys_tph = con.execute("""
    SELECT start_hour AS hour, count(*) AS trips
    FROM wk_trips GROUP BY 1 ORDER BY 1
""").df()
write_table(sys_tph, "03_system_trips_per_hour", "system_tph")

# --- 2. scheduled headways by period (route x direction) ---
# periods: AM 6-10, MID 10-16, PM 16-20, EVE 20-24, NIGHT 0-6  (minutes span)
periods = con.execute("""
    WITH lab AS (
      SELECT route, direction_id, start_hour,
        CASE WHEN start_hour BETWEEN 6 AND 9  THEN 'AM_peak'
             WHEN start_hour BETWEEN 10 AND 15 THEN 'Midday'
             WHEN start_hour BETWEEN 16 AND 19 THEN 'PM_peak'
             WHEN start_hour BETWEEN 20 AND 23 THEN 'Evening'
             ELSE 'Night' END AS period,
        CASE WHEN start_hour BETWEEN 6 AND 9  THEN 240
             WHEN start_hour BETWEEN 10 AND 15 THEN 360
             WHEN start_hour BETWEEN 16 AND 19 THEN 240
             WHEN start_hour BETWEEN 20 AND 23 THEN 240
             ELSE 360 END AS span_min
      FROM wk_trips
    )
    SELECT route, direction_id, period, any_value(span_min) AS span_min,
           count(*) AS trips,
           round(any_value(span_min)::DOUBLE / count(*), 1) AS headway_min
    FROM lab GROUP BY 1,2,3 ORDER BY route, direction_id, period
""").df()
write_table(periods, "03_scheduled_headways_by_period", "headways")

# --- 3. stop-level scheduled service (GTFS = genuinely stop-level) ---
stop_svc = con.execute("""
    SELECT st.stop_id, any_value(sp.stop_name) AS stop_name,
           count(*) AS weekday_arrivals,
           count(DISTINCT t.route_short_name) AS n_routes
    FROM transit_gtfs_stop_times st
    JOIN wk_trips wt ON st.feed=wt.feed AND st.trip_id=wt.trip_id
    JOIN transit_gtfs_trips tr ON st.feed=tr.feed AND st.trip_id=tr.trip_id
    JOIN transit_gtfs_routes t ON tr.feed=t.feed AND tr.route_id=t.route_id
    LEFT JOIN transit_gtfs_stops sp ON st.feed=sp.feed AND st.stop_id=sp.stop_id
    GROUP BY 1 ORDER BY weekday_arrivals DESC
""").df()
write_table(stop_svc.head(100), "03_top_served_stops", "top_stops")
print(f"  stop-level scheduled service computed for {len(stop_svc):,} stops")

# --- 4. demand (route) vs supply (route) -> over/under-served ---
supply = con.execute(f"""
    SELECT route_norm, any_value(route) AS gtfs_route, {bor} AS borough,
           count(*) AS weekday_trips
    FROM wk_trips GROUP BY route_norm, {bor}
""").df()

demand = con.execute("""
    WITH lastyr AS (
      SELECT upper(regexp_replace(bus_route,'[^A-Za-z0-9]','','g')) AS route_norm,
             transit_timestamp::DATE AS d, SUM(ridership) AS b
      FROM transit_ridership_bus_hourly
      WHERE transit_timestamp >= DATE '2025-07-01'
        AND isodow(transit_timestamp) <= 5
      GROUP BY 1,2
    )
    SELECT route_norm, AVG(b) AS avg_weekday_boardings
    FROM lastyr GROUP BY 1
""").df()

ds = supply.merge(demand, on="route_norm", how="inner")
ds = ds[ds.weekday_trips >= 20].copy()
ds["boardings_per_trip"] = (ds.avg_weekday_boardings / ds.weekday_trips).round(1)
ds = ds.sort_values("boardings_per_trip", ascending=False)
write_table(ds, "03_demand_vs_supply", "demand_supply")
under = ds.head(20)[["gtfs_route", "borough", "avg_weekday_boardings", "weekday_trips", "boardings_per_trip"]]
over = ds[ds.avg_weekday_boardings > 500].tail(20)[
    ["gtfs_route", "borough", "avg_weekday_boardings", "weekday_trips", "boardings_per_trip"]]
write_table(under, "03_most_crowded_routes", "under_served")
write_table(over, "03_least_crowded_routes", "over_served")

# ---------------- charts ----------------
fig, ax = plt.subplots(figsize=(9, 5))
ax.bar(sys_tph.hour, sys_tph.trips, color="#2166ac")
ax.set_xlabel("Hour of day"); ax.set_ylabel("Scheduled bus trips starting")
ax.set_title("Systemwide scheduled bus service supply by hour (representative weekday)")
ax.set_xticks(range(0, 24, 2))
savefig(fig, "03_system_supply_by_hour"); plt.close(fig)

fig, ax = plt.subplots(figsize=(9, 6))
u = ds.head(20).iloc[::-1]
ax.barh(u.gtfs_route, u.boardings_per_trip, color="#b2182b")
ax.set_xlabel("Avg weekday boardings per scheduled trip")
ax.set_title("Most crowded bus routes (highest demand-per-supply)\ndemand route-level APC / supply GTFS")
savefig(fig, "03_most_crowded"); plt.close(fig)

print("[03] done.")
