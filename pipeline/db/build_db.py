#!/usr/bin/env python3
"""
build_db.py -- Jane NYC Platform (B4, Pass 1)

Regenerate db/jane_geo.duckdb FRESH from the GeoParquet/Parquet lake.

Design (mirrors Robert-DB "canonical lake + regenerated query layer"):
  * Lake (data/parquet/**) is the source of truth; the DB is a thin query layer.
  * Small/medium tables  -> CREATE TABLE ... AS SELECT * FROM read_parquet(file)
  * The ridership GIANTS  -> CREATE VIEW over the hive-partitioned parquet
                            (external parquet; never copied into the .duckdb file).
  * Realtime archive      -> rt_* VIEWS over realtime/archive/<feed>/**.
  * Table naming per plan: geo_*, pop_*, transit_*, rt_*.

SKIPPED-not-yet-landed categories (sidewalk_pedestrian / street_network / qol):
  registered as no-ops here; their absence does NOT fail the build (a later pass adds them).

Run:
  PYTHONIOENCODING=utf-8 python db/build_db.py
"""
import os, sys, glob, time, json
import duckdb

ROOT = os.environ.get("NYCV_PIPELINE_ROOT",
                      os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # db/ -> pipeline/
LAKE = os.path.join(ROOT, "data", "parquet")
RT   = os.path.join(ROOT, "realtime", "archive")
DBP  = os.path.join(ROOT, "db", "jane_geo.duckdb")

sys.path.insert(0, os.path.join(ROOT, "db"))
from convert_lake import TASKS  # single source of table naming/kind/category

def rel(p): return p.replace(os.sep, "/")

# ---- realtime feed families (schemas verified 2026-07-17) ----
SUBWAY_POS_FEEDS = ["subway_bdfm","subway_g","subway_jz","subway_l","subway_nqrw","subway_si","subway_gtfs","subway_ace"]
RAIL_POS_FEEDS   = ["lirr","mnr"]
POS_CANON = """
  feed::VARCHAR AS feed, poll_ts::BIGINT AS poll_ts, header_ts::BIGINT AS header_ts,
  vehicle_id::VARCHAR AS vehicle_id, trip_id::VARCHAR AS trip_id, route_id::VARCHAR AS route_id,
  direction_id::BIGINT AS direction_id, lat::DOUBLE AS lat, lon::DOUBLE AS lon,
  bearing::DOUBLE AS bearing, speed::DOUBLE AS speed, timestamp::BIGINT AS timestamp,
  stop_id::VARCHAR AS stop_id, current_stop_seq::BIGINT AS current_stop_seq,
  current_status::BIGINT AS current_status, occupancy_status::BIGINT AS occupancy_status,
  date::DATE AS date, hour::VARCHAR AS hour
"""

def globs_for(feeds):
    return "[" + ",".join("'" + rel(os.path.join(RT, f)) + "/**/*.parquet'" for f in feeds) + "]"

def main():
    if os.path.exists(DBP):
        os.remove(DBP)
    con = duckdb.connect(DBP)
    con.execute("INSTALL spatial; LOAD spatial;")
    created_tables, created_views, skipped = [], [], []
    con.execute("CREATE TABLE _build_meta (name VARCHAR, kind VARCHAR, source VARCHAR, rows BIGINT)")

    # ---- lake tables + giant views ----
    for t in TASKS:
        slug, cat, kind = t["slug"], t["category"], t["kind"]
        if kind == "giant":
            d = os.path.join(LAKE, cat, slug)
            if not glob.glob(os.path.join(d, "**", "*.parquet"), recursive=True):
                skipped.append((slug, "giant lake dir empty/missing")); continue
            src = rel(d) + "/**/*.parquet"
            con.execute(f'CREATE VIEW "{slug}" AS SELECT * FROM read_parquet(\'{src}\', hive_partitioning=1)')
            n = con.execute(f'SELECT count(*) FROM "{slug}"').fetchone()[0]
            con.execute("INSERT INTO _build_meta VALUES (?,?,?,?)", [slug, "view_giant", src, n])
            created_views.append((slug, n))
        else:
            fp = os.path.join(LAKE, cat, slug + ".parquet")
            if not os.path.exists(fp):
                skipped.append((slug, "lake parquet missing")); continue
            con.execute(f'CREATE TABLE "{slug}" AS SELECT * FROM read_parquet(\'{rel(fp)}\')')
            n = con.execute(f'SELECT count(*) FROM "{slug}"').fetchone()[0]
            con.execute("INSERT INTO _build_meta VALUES (?,?,?,?)", [slug, "table", rel(fp), n])
            created_tables.append((slug, n))

    # ---- realtime views (rt_*) ----
    def mkview(name, sql, family):
        try:
            con.execute(f'CREATE VIEW "{name}" AS {sql}')
            n = con.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
            con.execute("INSERT INTO _build_meta VALUES (?,?,?,?)", [name, "view_rt", family, n])
            created_views.append((name, n))
        except Exception as e:
            skipped.append((name, f"rt view failed: {repr(e)[:120]}"))

    # per-family position views (canonical cast so a later UNION is type-safe)
    if glob.glob(os.path.join(RT, "bus_vehicle_positions", "**", "*.parquet"), recursive=True):
        mkview("rt_bus_vehicle_positions",
               f"SELECT {POS_CANON} FROM read_parquet('{rel(os.path.join(RT,'bus_vehicle_positions'))}/**/*.parquet', union_by_name=1)",
               "bus_vehicle_positions")
    if glob.glob(os.path.join(RT, "bus_trip_updates", "**", "*.parquet"), recursive=True):
        mkview("rt_bus_trip_updates",
               f"SELECT * FROM read_parquet('{rel(os.path.join(RT,'bus_trip_updates'))}/**/*.parquet', union_by_name=1)",
               "bus_trip_updates")
    if glob.glob(os.path.join(RT, "ferry_vehicle_positions", "**", "*.parquet"), recursive=True):
        mkview("rt_ferry_vehicle_positions",
               f"SELECT {POS_CANON} FROM read_parquet('{rel(os.path.join(RT,'ferry_vehicle_positions'))}/**/*.parquet', union_by_name=1)",
               "ferry_vehicle_positions")
    if glob.glob(os.path.join(RT, "ferry_trip_updates", "**", "*.parquet"), recursive=True):
        mkview("rt_ferry_trip_updates",
               f"SELECT * FROM read_parquet('{rel(os.path.join(RT,'ferry_trip_updates'))}/**/*.parquet', union_by_name=1)",
               "ferry_trip_updates")
    if any(glob.glob(os.path.join(RT, f, "**", "*.parquet"), recursive=True) for f in SUBWAY_POS_FEEDS):
        mkview("rt_subway_positions",
               f"SELECT {POS_CANON} FROM read_parquet({globs_for(SUBWAY_POS_FEEDS)}, union_by_name=1)",
               "subway_position_feeds")
    if any(glob.glob(os.path.join(RT, f, "**", "*.parquet"), recursive=True) for f in RAIL_POS_FEEDS):
        mkview("rt_rail_positions",
               f"SELECT {POS_CANON} FROM read_parquet({globs_for(RAIL_POS_FEEDS)}, union_by_name=1)",
               "lirr+mnr")
    if glob.glob(os.path.join(RT, "citibike_station_status", "**", "*.parquet"), recursive=True):
        mkview("rt_citibike_status",
               f"SELECT * FROM read_parquet('{rel(os.path.join(RT,'citibike_station_status'))}/**/*.parquet', union_by_name=1)",
               "citibike_station_status")

    # unified all-mode vehicle positions (only over families that exist as views)
    pos_views = [v for v,_ in created_views if v in
                 ("rt_bus_vehicle_positions","rt_subway_positions","rt_ferry_vehicle_positions","rt_rail_positions")]
    if pos_views:
        union = " UNION ALL BY NAME ".join(f'SELECT * FROM "{v}"' for v in pos_views)
        mkview("rt_all_vehicle_positions", union, "+".join(pos_views))

    # alerts (jsonl) -- non-fatal
    for name, feed in [("rt_bus_alerts","bus_alerts"), ("rt_subway_alerts","subway_alerts")]:
        if glob.glob(os.path.join(RT, feed, "**", "*.jsonl"), recursive=True):
            g = rel(os.path.join(RT, feed)) + "/**/*.jsonl"
            mkview(name, f"SELECT * FROM read_json_auto('{g}', union_by_name=1, format='newline_delimited')", feed)

    # ---- derived analysis views (built on top of lake tables/views) ----
    # 311 filtered to sidewalk/curb/ramp-relevant complaint types (per SITE_SPEC + PROVENANCE note).
    if "qol_sr311" in set(v for v, _ in created_views) | set(t for t, _ in created_tables):
        sidewalk_types = ("'Sidewalk Condition','DEP Sidewalk Condition','Curb Condition',"
                          "'Root/Sewer/Sidewalk Condition','Noise - Street/Sidewalk'")
        mkview("qol_sr311_sidewalk",
               f"SELECT * FROM qol_sr311 WHERE complaint_type IN ({sidewalk_types})",
               "qol_sr311(filtered:sidewalk_complaint_types)")

    # ---- not-yet-landed categories (honest, data-driven no-op registration) ----
    # Only register a category as skipped if NO task of that category produced a lake table/view.
    landed_cats = set(t["category"] for t in TASKS
                      if t["slug"] in (set(s for s, _ in created_tables) | set(s for s, _ in created_views)))
    for cat in ("sidewalk_pedestrian", "street_network", "qol"):
        if cat not in landed_cats:
            con.execute("INSERT INTO _build_meta VALUES (?,?,?,?)", [cat, "category_skipped", "not_yet_landed", 0])

    con.close()

    print(f"\n===== jane_geo.duckdb BUILT =====  ({DBP})")
    print(f"TABLES ({len(created_tables)}):")
    for s, n in created_tables: print(f"  {s:38} {n:>14,}")
    print(f"VIEWS ({len(created_views)}):")
    for s, n in created_views: print(f"  {s:38} {n:>14,}")
    if skipped:
        print(f"SKIPPED ({len(skipped)}):")
        for s, why in skipped: print(f"  {s:38} {why}")
    sz = os.path.getsize(DBP)
    print(f"DB file size: {sz/1e6:.1f} MB (giants stay external parquet)")
    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "tables": created_tables, "views": created_views, "skipped": skipped,
               "db_bytes": sz},
              open(os.path.join(ROOT, "db", "BUILD_DB_REPORT.json"), "w"), indent=2)

if __name__ == "__main__":
    main()
