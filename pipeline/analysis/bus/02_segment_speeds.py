"""02 - Bus SPEED analysis from transit_segment_speeds + ACE before/after.

Source: transit_segment_speeds (Socrata 58t6-89vi 2023-24 + kufs-yh3x 2025+)
Grain : timepoint-segment x hour x day-of-week, with average_road_speed (mph),
        road_distance (mi), bus_trip_count, borough. 19.9M rows, 2023-01..2026-05.

Analyses:
  1. Slowest-segment league table (weekday peak, trip-weighted).
  2. Speed distribution by borough x hour (weekday).
  3. ACE enforcement before/after: for ACE routes (transit_ace_routes) with an
     implementation_date inside the speed-coverage window, compare trip-weighted
     mean segment speed in the +/-120 day windows around go-live.
     CAVEATS: confounded by seasonality, COVID recovery, route changes, other
     concurrent interventions; ACE reduces blocked-lane/double-park delay, not a
     clean speed RCT. Reported as descriptive pre/post, not causal.
"""
from __future__ import annotations
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from common import connect, write_table, savefig

con = connect()
print("[02] segment speeds (19.9M rows)")

PEAK = "hour_of_day IN (7,8,9,16,17,18,19)"
WEEKDAY = "lower(day_of_week) NOT IN ('saturday','sunday')"

# --- 1. Slowest-segment league table (weekday peak, trip-weighted) ---
slow = con.execute(f"""
    SELECT route_id, borough,
           timepoint_stop_name AS from_stop,
           next_timepoint_stop_name AS to_stop,
           SUM(average_road_speed * bus_trip_count) / NULLIF(SUM(bus_trip_count),0) AS wt_speed_mph,
           SUM(bus_trip_count) AS n_trips,
           AVG(road_distance) AS seg_miles
    FROM transit_segment_speeds
    WHERE {WEEKDAY} AND {PEAK} AND average_road_speed > 0
      AND timepoint_stop_name IS NOT NULL AND next_timepoint_stop_name IS NOT NULL
      AND road_distance >= 0.1   -- exclude layover/terminal degenerate segments
    GROUP BY 1,2,3,4
    HAVING SUM(bus_trip_count) >= 500
    ORDER BY wt_speed_mph ASC
""").df()
write_table(slow.head(50), "02_slowest_segments_peak", "slowest50")
write_table(slow, "02_all_segments_peak", "all_segments")

# route-level trip-weighted peak speed (league table of slowest routes)
slow_route = con.execute(f"""
    SELECT route_id, any_value(borough) AS borough,
           SUM(average_road_speed*bus_trip_count)/NULLIF(SUM(bus_trip_count),0) AS wt_speed_mph,
           SUM(bus_trip_count) AS n_trips
    FROM transit_segment_speeds
    WHERE {WEEKDAY} AND {PEAK} AND average_road_speed>0
    GROUP BY 1 HAVING SUM(bus_trip_count)>=2000
    ORDER BY wt_speed_mph ASC
""").df()
write_table(slow_route, "02_route_peak_speed", "route_speed")

# --- 2. Speed distribution by borough x hour (weekday) ---
bor_hour = con.execute(f"""
    SELECT borough, hour_of_day,
           SUM(average_road_speed*bus_trip_count)/NULLIF(SUM(bus_trip_count),0) AS wt_speed_mph,
           SUM(bus_trip_count) AS n_trips
    FROM transit_segment_speeds
    WHERE {WEEKDAY} AND average_road_speed>0
    GROUP BY 1,2 ORDER BY 1,2
""").df()
write_table(bor_hour, "02_speed_by_borough_hour", "borough_hour")

# --- 3. ACE before/after (descriptive) ---
# Normalize route ids: strip '+', upper-case both sides for the join.
ace = con.execute("""
    SELECT route, _program, implementation_date,
           upper(replace(route,'+','')) AS route_norm
    FROM transit_ace_routes
    WHERE implementation_date BETWEEN DATE '2023-05-01' AND DATE '2025-12-31'
""").df()

rows = []
WIN = 120  # days each side
for _, r in ace.iterrows():
    d = r["implementation_date"]
    res = con.execute(f"""
        WITH seg AS (
          SELECT (average_road_speed) AS spd, bus_trip_count AS n,
                 CASE WHEN timestamp::DATE <  DATE '{d}' THEN 'pre'
                      WHEN timestamp::DATE >= DATE '{d}' THEN 'post' END AS period
          FROM transit_segment_speeds
          WHERE upper(route_id) = '{r["route_norm"]}'
            AND average_road_speed > 0
            AND {WEEKDAY} AND {PEAK}
            AND timestamp::DATE BETWEEN DATE '{d}' - {WIN} AND DATE '{d}' + {WIN}
        )
        SELECT period, SUM(spd*n)/NULLIF(SUM(n),0) AS wt_speed, SUM(n) AS trips
        FROM seg WHERE period IS NOT NULL GROUP BY 1
    """).df()
    pre = res[res.period == "pre"]
    post = res[res.period == "post"]
    if len(pre) and len(post) and pre.trips.iloc[0] >= 500 and post.trips.iloc[0] >= 500:
        ps, qs = float(pre.wt_speed.iloc[0]), float(post.wt_speed.iloc[0])
        rows.append({
            "route": r["route"], "program": r["_program"],
            "implementation_date": d,
            "pre_speed_mph": round(ps, 2), "post_speed_mph": round(qs, 2),
            "delta_mph": round(qs - ps, 2), "pct_change": round((qs - ps) / ps * 100, 1),
            "pre_trips": int(pre.trips.iloc[0]), "post_trips": int(post.trips.iloc[0]),
        })
ace_df = pd.DataFrame(rows).sort_values("implementation_date") if rows else pd.DataFrame(
    columns=["route", "program", "implementation_date", "pre_speed_mph", "post_speed_mph",
             "delta_mph", "pct_change", "pre_trips", "post_trips"])
write_table(ace_df, "02_ace_before_after", "ace_prepost")
if len(ace_df):
    print(f"  ACE routes with valid pre/post windows: {len(ace_df)}; "
          f"mean delta {ace_df.delta_mph.mean():+.2f} mph; "
          f"{(ace_df.delta_mph>0).sum()} faster / {(ace_df.delta_mph<0).sum()} slower")

# ---------------- charts ----------------
fig, ax = plt.subplots(figsize=(9, 6))
for b in ["Manhattan", "Brooklyn", "Bronx", "Queens", "Staten Island"]:
    d = bor_hour[bor_hour.borough == b]
    ax.plot(d.hour_of_day, d.wt_speed_mph, marker=".", label=b)
ax.set_xlabel("Hour of day"); ax.set_ylabel("Trip-weighted speed (mph)")
ax.set_title("Bus speed by borough and hour (weekday, 2023-2026)")
ax.set_xticks(range(0, 24, 2)); ax.legend(); ax.grid(alpha=.3)
savefig(fig, "02_speed_by_borough_hour"); plt.close(fig)

fig, ax = plt.subplots(figsize=(9, 6))
s = slow.head(20).iloc[::-1].copy()
s["from_stop"] = s.from_stop.fillna("?"); s["to_stop"] = s.to_stop.fillna("?")
lbl = (s.route_id.astype(str) + ": " + s.from_stop.str.slice(0, 16) + "->" + s.to_stop.str.slice(0, 16))
ax.barh(lbl, s.wt_speed_mph, color="#b2182b")
ax.set_xlabel("Trip-weighted peak speed (mph)")
ax.set_title("20 slowest bus segments (weekday peak, >=500 trips)")
savefig(fig, "02_slowest_segments"); plt.close(fig)

if len(ace_df):
    fig, ax = plt.subplots(figsize=(9, 6))
    a = ace_df.sort_values("delta_mph")
    colors = ["#1a9850" if v > 0 else "#b2182b" for v in a.delta_mph]
    ax.barh(a.route, a.delta_mph, color=colors)
    ax.axvline(0, color="k", lw=.8)
    ax.set_xlabel("Post - Pre speed change (mph, +/-120d, weekday peak)")
    ax.set_title("ACE enforcement: descriptive before/after speed change\n(confounded; not causal)")
    savefig(fig, "02_ace_before_after"); plt.close(fig)

print("[02] done.")
