#!/usr/bin/env python3
"""
build_db.py -- nycvisualizer NYC Platform

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

PATH RESOLUTION (fixed 2026-07-25 — W6a defect 5).
  The archive root is resolved from the environment exactly like every other component
  that touches it (poller.py, derive2/_common.py, backend/app/config.py):
      NYCV_ARCHIVE_ROOT  (preferred)  ->  REALTIME_ARCHIVE  ->  <root>/realtime/archive
  and the platform .env is loaded first so a bare `python db/build_db.py` sees the same
  value the scheduled tasks do. Before this fix `RT` was HARDCODED to
  `<root>/realtime/archive`; when the archive was relocated to a different volume on
  2026-07-22 (realtime/ARCHIVE_MOVED.md) all 10 rt_* views were compiled against a path
  that no longer exists and every one of them failed at query time with
  `IO Error: No files found that match the pattern`. Re-running the build would have
  recreated the identical breakage, so the hardcode WAS the bug — not the stale DB.

Run:
  PYTHONIOENCODING=utf-8 python db/build_db.py                # full rebuild
  PYTHONIOENCODING=utf-8 python db/build_db.py --rt-views-only # rt_* only
"""
import os, sys, glob, time, json
import duckdb

# db/ -> pipeline/ .  Overridable via NYCV_PIPELINE_ROOT.
ROOT = os.environ.get("NYCV_PIPELINE_ROOT",
                      os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = ROOT.replace(os.sep, "/")

# Load the platform .env (holds NYCV_ARCHIVE_ROOT) before resolving any path, so this
# script behaves identically whether run bare, from a task wrapper, or from a container.
_ENV_FILE = os.environ.get("NYCV_ENV_FILE", os.path.join(ROOT, ".env"))
if os.path.exists(_ENV_FILE):
    with open(_ENV_FILE, encoding="utf-8") as _fh:
        for _line in _fh:
            _line = _line.strip()
            if not _line or _line.startswith("#") or "=" not in _line:
                continue
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))


def _archive_root() -> str:
    """The realtime archive root — env-driven, never hardcoded (see module docstring)."""
    v = os.environ.get("NYCV_ARCHIVE_ROOT") or os.environ.get("REALTIME_ARCHIVE")
    return (v if v else os.path.join(ROOT, "realtime", "archive")).replace(os.sep, "/")


LAKE = os.path.join(ROOT, "data", "parquet")
RT   = _archive_root()
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


# The 10 rt_* view names this module owns. Used by --rt-views-only to drop exactly these
# and nothing else (the 61 static tables and the 9 hive/giant views are NOT touched).
RT_VIEW_NAMES = [
    "rt_bus_vehicle_positions", "rt_bus_trip_updates",
    "rt_ferry_vehicle_positions", "rt_ferry_trip_updates",
    "rt_subway_positions", "rt_rail_positions", "rt_citibike_status",
    "rt_all_vehicle_positions", "rt_bus_alerts", "rt_subway_alerts",
]


def create_rt_views(con, mkview, created_views):
    """Create the rt_* views over the (env-resolved) realtime archive.

    Shared by the full rebuild and by --rt-views-only so the two can never diverge —
    a rt_* view is defined in exactly one place.
    """
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
    pos_views = [v for v, _ in created_views if v in
                 ("rt_bus_vehicle_positions", "rt_subway_positions",
                  "rt_ferry_vehicle_positions", "rt_rail_positions")]
    if pos_views:
        union = " UNION ALL BY NAME ".join(f'SELECT * FROM "{v}"' for v in pos_views)
        mkview("rt_all_vehicle_positions", union, "+".join(pos_views))

    # alerts (jsonl) -- non-fatal
    for name, feed in [("rt_bus_alerts", "bus_alerts"), ("rt_subway_alerts", "subway_alerts")]:
        if glob.glob(os.path.join(RT, feed, "**", "*.jsonl"), recursive=True):
            g = rel(os.path.join(RT, feed)) + "/**/*.jsonl"
            mkview(name, f"SELECT * FROM read_json_auto('{g}', union_by_name=1, format='newline_delimited')", feed)


def rt_views_only():
    """Rebuild ONLY the rt_* views in place against the current archive root.

    Cheap repair path for the 2026-07-22 archive move: the 61 static tables and the 9
    hive/giant views are healthy and a full rebuild of a 5.4 GB DB to fix 10 view
    definitions is pure waste. Each view is verified with a real COUNT(*) before the
    run is called a success — a view that still fails to bind is reported, not hidden.
    """
    if not os.path.exists(DBP):
        print(f"FATAL: {DBP} does not exist — run a full build first.")
        return 1
    print(f"rt-views-only rebuild\n  db      = {DBP}\n  archive = {RT}")
    if not os.path.isdir(RT):
        print(f"FATAL: archive root does not exist: {RT}")
        return 1
    con = duckdb.connect(DBP)
    con.execute("INSTALL spatial; LOAD spatial;")
    for v in RT_VIEW_NAMES:
        con.execute(f'DROP VIEW IF EXISTS "{v}"')
    con.execute("DELETE FROM _build_meta WHERE kind = 'view_rt'")
    created_views, skipped = [], []

    def mkview(name, sql, family):
        try:
            con.execute(f'CREATE VIEW "{name}" AS {sql}')
            n = con.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
            con.execute("INSERT INTO _build_meta VALUES (?,?,?,?)", [name, "view_rt", family, n])
            created_views.append((name, n))
            print(f"  OK   {name:32} {n:>14,}")
        except Exception as e:
            skipped.append((name, f"rt view failed: {repr(e)[:160]}"))
            print(f"  FAIL {name:32} {repr(e)[:120]}")

    create_rt_views(con, mkview, created_views)
    con.close()
    print(f"\nrt_* views rebuilt: {len(created_views)} OK, {len(skipped)} failed")
    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "mode": "rt_views_only", "archive_root": RT,
               "views": created_views, "skipped": skipped},
              open(os.path.join(ROOT, "db", "BUILD_RT_VIEWS_REPORT.json"), "w"), indent=2)
    return 1 if skipped else 0


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
            # union_by_name=1: multi-source giants (qol_dob_permits unions 3 heterogeneous
            # DOB schemas by column name); harmless for single-schema giants.
            con.execute(f'CREATE VIEW "{slug}" AS SELECT * FROM read_parquet(\'{src}\', hive_partitioning=1, union_by_name=1)')
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

    create_rt_views(con, mkview, created_views)

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
    if "--rt-views-only" in sys.argv:
        sys.exit(rt_views_only())
    main()
