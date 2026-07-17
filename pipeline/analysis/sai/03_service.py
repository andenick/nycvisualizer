"""03 - Per-stop scheduled bus service (supply) from GTFS static.

Stop-level supply IS available from GTFS stop_times (unlike the route-hour APC ridership giant,
which has no stop column). We count SCHEDULED WEEKDAY trips serving each stop in three windows:
  am_peak  07:00-09:59   (3 h)
  midday   10:00-15:59   (6 h)
  evening  19:00-21:59   (3 h)
and report trips/hour = trips / window_hours.

De-duplication of weekday service variants: MTA GTFS carries several weekday service_ids per route
(base vs school-open "SDon" picks, date-range picks) that each represent ONE weekday's schedule.
Counting them all double-counts service. We therefore pick, per (feed, route_id), the single weekday
service_id with the most trips as the representative weekday schedule, and count only its trips.
A stop served by N routes sums across those routes (distinct physical buses). GTFS-arrival hours >=24
(after-midnight trips) are wrapped by taking hour = CAST(split_part(time,':',1) AS INT) and binning 0-23.

251 of 13,621 stops (1.8%) have no matching GTFS bus stop_id -> service = 0 with served=false flag.
"""
from __future__ import annotations
import time
import common as C

t0 = time.time()
con = C.connect()
BF = C.BUS_FEEDS

con.execute(f"""
CREATE TEMP TABLE chosen AS
WITH wk AS (
  SELECT feed, route_id, service_id, count(*) AS c
  FROM transit_gtfs_trips
  WHERE feed IN ({BF}) AND service_id ILIKE '%Weekday%'
  GROUP BY 1,2,3
)
SELECT feed, route_id, service_id
FROM (SELECT *, row_number() OVER (PARTITION BY feed, route_id ORDER BY c DESC, service_id) rn FROM wk)
WHERE rn = 1
""")

# stop-time events on representative-weekday trips, with wrapped hour
con.execute(f"""
CREATE TEMP TABLE ev AS
SELECT st.stop_id AS gstop,
       st.trip_id,
       (CAST(split_part(st.departure_time, ':', 1) AS INT) % 24) AS hr
FROM transit_gtfs_stop_times st
JOIN transit_gtfs_trips t ON st.feed = t.feed AND st.trip_id = t.trip_id
JOIN chosen c ON t.feed = c.feed AND t.route_id = c.route_id AND t.service_id = c.service_id
WHERE st.feed IN ({BF})
""")

con.execute("""
CREATE TEMP TABLE svc AS
SELECT gstop,
       count(DISTINCT trip_id) FILTER (WHERE hr IN (7,8,9))              AS trips_am,
       count(DISTINCT trip_id) FILTER (WHERE hr IN (10,11,12,13,14,15)) AS trips_midday,
       count(DISTINCT trip_id) FILTER (WHERE hr IN (19,20,21))          AS trips_eve,
       count(DISTINCT trip_id) FILTER (WHERE hr BETWEEN 5 AND 21)       AS trips_daytime
FROM ev GROUP BY gstop
""")

df = con.execute(f"""
SELECT b.stop_id,
       (CAST(b.stop_id AS VARCHAR) IN
          (SELECT stop_id FROM transit_gtfs_stops WHERE feed IN ({BF}))) AS gtfs_matched,
       COALESCE(s.trips_am, 0)      AS trips_am,
       COALESCE(s.trips_midday, 0)  AS trips_midday,
       COALESCE(s.trips_eve, 0)     AS trips_eve,
       COALESCE(s.trips_daytime, 0) AS trips_daytime,
       ROUND(COALESCE(s.trips_am,0)/3.0, 2)      AS tph_am,
       ROUND(COALESCE(s.trips_midday,0)/6.0, 2)  AS tph_midday,
       ROUND(COALESCE(s.trips_eve,0)/3.0, 2)     AS tph_eve
FROM (SELECT DISTINCT stop_id FROM transit_bus_stops) b
LEFT JOIN svc s ON s.gstop = CAST(b.stop_id AS VARCHAR)
ORDER BY b.stop_id
""").fetchdf()

C.write_table(df, "sai_stop_service", "service")
matched = df.gtfs_matched.sum()
served = (df.trips_daytime > 0).sum()
print(f"  GTFS-matched stops: {matched:,}  |  with weekday daytime service: {served:,}")
print(f"  tph_am: mean {df.tph_am.mean():.2f}  median {df.tph_am.median():.2f}  max {df.tph_am.max():.2f}")
print(f"done in {time.time()-t0:.0f}s")
