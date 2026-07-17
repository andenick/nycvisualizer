#!/usr/bin/env python3
"""
Jane / nycvisualizer NYC Platform — Realtime derivations (batch; run manually/hourly).

Reads the vehicle-position / trip-update Parquet lake written by poller.py under
realtime/archive/ and produces derived analysis tables in realtime/derived/:

  observed_headways.parquet   route x direction x stop x hour: observed headways
                              (gap between consecutive trip arrivals) + bunching index
  segment_speeds.parquet      route x from_stop x to_stop x hour: realized speeds
                              from consecutive same-trip GPS pings (haversine / dt)
  schedule_adherence.parquet  observed arrival vs GTFS-static scheduled arrival
                              (OPTIONAL — only if static stop_times is found)

Design notes:
  * An "arrival event" = the earliest poll in which a given trip is reported
    STOPPED_AT (current_status=1) a given stop. Feeds without stop_id/current_status
    (some bus feeds) simply contribute no headway rows — honest, not fabricated.
  * Bunching index (no-static baseline): share of observed gaps at a route/stop/hour
    that are shorter than 0.5x the median observed gap for that route/stop/hour.
    (>0 means vehicles arriving in bunches.)
  * Schedule adherence needs GTFS static; if none is present the join is skipped and
    a note is recorded in DERIVE_REPORT.json.

Usage:
    python realtime/derive.py [--window-hours N]
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent
PLATFORM = ROOT.parent
ARCHIVE = ROOT / "archive"
DERIVED = ROOT / "derived"
STATIC_DIRS = [
    PLATFORM / "data" / "raw" / "transit_static",   # plan's canonical location
    PLATFORM / "data" / "raw" / "gtfs_subway_supplemented",
    PLATFORM / "data" / "raw" / "gtfs_subway",
]

VEHICLE_FEEDS = ["bus_vehicle_positions", "subway_gtfs", "subway_ace", "subway_bdfm",
                 "subway_g", "subway_jz", "subway_nqrw", "subway_l", "subway_si",
                 "lirr", "mnr", "ferry_vehicle_positions"]


def vehicle_glob() -> list[str]:
    pats = []
    for f in VEHICLE_FEEDS:
        pats += glob.glob(str(ARCHIVE / f / "**" / "*.parquet"), recursive=True)
    return pats


def find_static_stop_times() -> Path | None:
    for d in STATIC_DIRS:
        if d.exists():
            hits = list(d.rglob("stop_times.txt"))
            if hits:
                return hits[0]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window-hours", type=int, default=0,
                    help="only use pings from the last N hours (0 = all archive)")
    args = ap.parse_args()

    DERIVED.mkdir(parents=True, exist_ok=True)
    files = vehicle_glob()
    report = dict(run_at=datetime.now(timezone.utc).isoformat(),
                  vehicle_parquet_files=len(files), window_hours=args.window_hours,
                  outputs={}, notes=[])

    if not files:
        report["notes"].append("No vehicle parquet in archive yet — nothing to derive. "
                               "Let poller.py run and accumulate data first.")
        (DERIVED / "DERIVE_REPORT.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        return

    con = duckdb.connect()
    file_list = ",".join("'" + f.replace("\\", "/") + "'" for f in files)
    where_window = ""
    if args.window_hours > 0:
        where_window = f"AND poll_ts >= (epoch(now()) - {args.window_hours*3600})"

    # Unified vehicle view. union_by_name tolerates per-file schema drift.
    con.execute(f"""
        CREATE VIEW v AS
        SELECT feed, route_id, direction_id, trip_id, stop_id,
               CAST(current_status AS INTEGER) AS current_status,
               lat, lon,
               COALESCE(timestamp, poll_ts) AS ts, poll_ts, header_ts
        FROM read_parquet([{file_list}], union_by_name=true)
        WHERE trip_id IS NOT NULL {where_window}
    """)
    total = con.execute("SELECT count(*) FROM v").fetchone()[0]
    report["vehicle_rows"] = int(total)

    # ---------------- observed headways + bunching ----------------
    # arrival event = earliest ts a trip is STOPPED_AT a stop
    con.execute("""
        CREATE VIEW arrivals AS
        SELECT feed, route_id, direction_id, stop_id, trip_id, MIN(ts) AS arr_ts
        FROM v
        WHERE current_status = 1 AND stop_id IS NOT NULL
        GROUP BY feed, route_id, direction_id, stop_id, trip_id
    """)
    con.execute("""
        CREATE VIEW headway_events AS
        SELECT feed, route_id, direction_id, stop_id, trip_id, arr_ts,
               arr_ts - LAG(arr_ts) OVER (
                   PARTITION BY feed, route_id, direction_id, stop_id
                   ORDER BY arr_ts) AS headway_s
        FROM arrivals
    """)
    n_arr = con.execute("SELECT count(*) FROM headway_events WHERE headway_s IS NOT NULL").fetchone()[0]
    if n_arr > 0:
        con.execute(f"""
            COPY (
                WITH h AS (
                    SELECT feed, route_id, direction_id, stop_id,
                           CAST(strftime(make_timestamp(arr_ts*1000000), '%Y-%m-%d') AS VARCHAR) AS date,
                           CAST(strftime(make_timestamp(arr_ts*1000000), '%H') AS INTEGER) AS hour,
                           headway_s
                    FROM headway_events
                    WHERE headway_s IS NOT NULL AND headway_s > 0 AND headway_s < 7200
                ),
                agg AS (
                    SELECT feed, route_id, direction_id, stop_id, date, hour,
                           count(*) AS n_headways,
                           median(headway_s) AS median_headway_s,
                           avg(headway_s) AS mean_headway_s,
                           min(headway_s) AS min_headway_s,
                           max(headway_s) AS max_headway_s
                    FROM h GROUP BY feed, route_id, direction_id, stop_id, date, hour
                )
                SELECT h.feed, h.route_id, h.direction_id, h.stop_id, h.date, h.hour,
                       any_value(agg.n_headways) AS n_headways,
                       any_value(agg.median_headway_s) AS median_headway_s,
                       any_value(agg.mean_headway_s) AS mean_headway_s,
                       any_value(agg.min_headway_s) AS min_headway_s,
                       any_value(agg.max_headway_s) AS max_headway_s,
                       -- bunching index: share of gaps < 0.5x median observed
                       avg(CASE WHEN h.headway_s < 0.5*agg.median_headway_s THEN 1.0 ELSE 0.0 END) AS bunching_index
                FROM h JOIN agg USING (feed, route_id, direction_id, stop_id, date, hour)
                GROUP BY h.feed, h.route_id, h.direction_id, h.stop_id, h.date, h.hour
            ) TO '{(DERIVED/'observed_headways.parquet').as_posix()}' (FORMAT PARQUET);
        """)
        report["outputs"]["observed_headways.parquet"] = int(
            con.execute(f"SELECT count(*) FROM read_parquet('{(DERIVED/'observed_headways.parquet').as_posix()}')").fetchone()[0])
    else:
        report["notes"].append("No STOPPED_AT arrival events with stop_id yet (feeds may "
                               "not carry current_status/stop_id, or too little data) — "
                               "observed_headways skipped.")

    # ---------------- realized segment speeds ----------------
    # consecutive same-trip GPS pings -> haversine distance / dt
    con.execute("""
        CREATE VIEW pings AS
        SELECT feed, route_id, direction_id, trip_id, stop_id, lat, lon, ts,
               LAG(lat) OVER w AS plat, LAG(lon) OVER w AS plon,
               LAG(ts) OVER w AS pts, LAG(stop_id) OVER w AS pstop
        FROM v
        WHERE lat IS NOT NULL AND lon IS NOT NULL
        WINDOW w AS (PARTITION BY feed, trip_id ORDER BY ts)
    """)
    con.execute("""
        CREATE VIEW seg AS
        SELECT feed, route_id, direction_id, trip_id, pstop AS from_stop, stop_id AS to_stop,
               ts, pts,
               -- haversine meters
               2*6371000*asin(sqrt(
                   pow(sin(radians(lat-plat)/2),2) +
                   cos(radians(plat))*cos(radians(lat))*pow(sin(radians(lon-plon)/2),2)
               )) AS dist_m,
               (ts - pts) AS dt_s
        FROM pings
        WHERE plat IS NOT NULL AND pts IS NOT NULL AND ts > pts
    """)
    n_seg = con.execute("SELECT count(*) FROM seg WHERE dt_s BETWEEN 1 AND 900 AND dist_m > 0").fetchone()[0]
    if n_seg > 0:
        con.execute(f"""
            COPY (
                WITH s AS (
                    SELECT feed, route_id, direction_id, from_stop, to_stop,
                           CAST(strftime(make_timestamp(ts*1000000), '%Y-%m-%d') AS VARCHAR) AS date,
                           CAST(strftime(make_timestamp(ts*1000000), '%H') AS INTEGER) AS hour,
                           dist_m, dt_s, (dist_m/dt_s)*2.23694 AS mph
                    FROM seg
                    WHERE dt_s BETWEEN 1 AND 900 AND dist_m > 0
                      AND (dist_m/dt_s)*2.23694 < 80   -- drop GPS-jump outliers
                )
                SELECT feed, route_id, direction_id, from_stop, to_stop, date, hour,
                       count(*) AS n_segments,
                       median(mph) AS median_mph,
                       avg(mph) AS mean_mph,
                       sum(dist_m) AS total_dist_m,
                       sum(dt_s) AS total_time_s
                FROM s
                GROUP BY feed, route_id, direction_id, from_stop, to_stop, date, hour
            ) TO '{(DERIVED/'segment_speeds.parquet').as_posix()}' (FORMAT PARQUET);
        """)
        report["outputs"]["segment_speeds.parquet"] = int(
            con.execute(f"SELECT count(*) FROM read_parquet('{(DERIVED/'segment_speeds.parquet').as_posix()}')").fetchone()[0])
    else:
        report["notes"].append("Not enough consecutive GPS pings per trip to derive "
                               "segment speeds yet — segment_speeds skipped.")

    # ---------------- schedule adherence (OPTIONAL) ----------------
    static_st = find_static_stop_times()
    if static_st and n_arr > 0:
        try:
            # scheduled arrival seconds-after-midnight per trip/stop
            con.execute(f"""
                CREATE VIEW sched AS
                SELECT CAST(trip_id AS VARCHAR) AS trip_id,
                       CAST(stop_id AS VARCHAR) AS stop_id,
                       -- HH:MM:SS (may exceed 24h) -> seconds after midnight
                       CAST(split_part(arrival_time,':',1) AS INTEGER)*3600 +
                       CAST(split_part(arrival_time,':',2) AS INTEGER)*60 +
                       CAST(split_part(arrival_time,':',3) AS INTEGER) AS sched_sec
                FROM read_csv_auto('{static_st.as_posix()}', header=true, ALL_VARCHAR=true)
            """)
            con.execute(f"""
                COPY (
                    SELECT a.feed, a.route_id, a.trip_id, a.stop_id,
                           a.arr_ts,
                           s.sched_sec,
                           (epoch(make_timestamp(a.arr_ts*1000000)) % 86400) - s.sched_sec AS adherence_s
                    FROM arrivals a
                    JOIN sched s ON CAST(a.trip_id AS VARCHAR)=s.trip_id
                                AND CAST(a.stop_id AS VARCHAR)=s.stop_id
                ) TO '{(DERIVED/'schedule_adherence.parquet').as_posix()}' (FORMAT PARQUET);
            """)
            cnt = int(con.execute(f"SELECT count(*) FROM read_parquet('{(DERIVED/'schedule_adherence.parquet').as_posix()}')").fetchone()[0])
            report["outputs"]["schedule_adherence.parquet"] = cnt
            report["static_stop_times"] = str(static_st)
            if cnt == 0:
                report["notes"].append("Static stop_times found but trip_id/stop_id keys "
                                       "did not join (realtime vs static id namespaces "
                                       "may differ) — adherence produced 0 rows.")
        except Exception as e:
            report["notes"].append(f"schedule_adherence skipped (static join error): {e}")
    else:
        report["notes"].append("GTFS static stop_times not found at ../data/raw/transit_static/ "
                               "(or no arrivals) — schedule_adherence skipped (optional join).")

    (DERIVED / "DERIVE_REPORT.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
