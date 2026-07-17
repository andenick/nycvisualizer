#!/usr/bin/env python3
"""
convert_lake.py -- Jane NYC Platform (B4, Pass 1)

Convert LANDED raw datasets -> GeoParquet/Parquet lake at
  data/parquet/<category>/<slug>[.parquet | / (hive dir for giants)]

Scope this pass: ridership, population, landuse, transit_static.
(sidewalk_pedestrian / street_network / qol still downloading -> not registered here.)

Discipline:
  * Deletes NOTHING under data/raw.
  * Regenerable / idempotent: each target is removed then rewritten.
  * Giants (bus/subway hourly, O-D, segment speeds) streamed via DuckDB COPY,
    hive-partitioned by year, never fully materialized in RAM.
  * Geo -> WKB column (source CRS preserved in geometry_crs) + derived geom_2263.
    Reproject nothing else; always_xy:=true on every ST_Transform.
  * Disk guard: abort a giant conversion if it would take D: below 40 GB free.
  * Failure after 2 retries -> log to db/BUILD_LOG.md, continue (no silent skip).

Run:
  PYTHONIOENCODING=utf-8 python db/convert_lake.py [--only slug1,slug2] [--skip-giants]
"""
import os, sys, json, time, shutil, argparse, traceback
import duckdb

ROOT = os.environ.get("NYCV_PIPELINE_ROOT",
                      os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # db/ -> pipeline/
RAW  = os.path.join(ROOT, "data", "raw")
LAKE = os.path.join(ROOT, "data", "parquet")
SCRATCH = os.path.join(ROOT, "db", "_scratch")
BUILD_LOG = os.path.join(ROOT, "db", "BUILD_LOG.md")
DISK_FLOOR_GB = 40
GIANT_MIN_HEADROOM_GB = 40

os.makedirs(LAKE, exist_ok=True)
os.makedirs(SCRATCH, exist_ok=True)

def log_build(msg):
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    line = f"- **{ts}** {msg}\n"
    with open(BUILD_LOG, "a", encoding="utf-8") as f:
        f.write(line)
    print("  [BUILD_LOG] " + msg, flush=True)

def disk_free_gb(path="D:/"):
    total, used, free = shutil.disk_usage(path)
    return free / (1024**3)

def get_prov(raw_dir):
    """Return (dataset_id, retrieved_at, vintage) from a PROVENANCE.json, tolerant of key variants."""
    p = os.path.join(raw_dir, "PROVENANCE.json")
    dsid = retrieved = vintage = ""
    if os.path.exists(p):
        try:
            d = json.load(open(p, encoding="utf-8"))
        except Exception:
            d = {}
        # prefer the data-bearing backing dataset id (data_id) when a provenance
        # records a shell viz id in dataset_id + the real backing id in data_id.
        dsid = d.get("data_id") or d.get("dataset_id") or d.get("dataset_id_or_url") or ""
        # dataset_id_or_url sometimes "id / url" -> keep the leading id token
        if dsid and " / " in dsid:
            dsid = dsid.split(" / ")[0].strip()
        retrieved = d.get("retrieved_at", "")
        vintage = d.get("vintage") or d.get("time_coverage") or ""
    return dsid.replace("'", "''"), str(retrieved).replace("'", "''"), str(vintage).replace("'", "''")

def prov_rows(raw_dir):
    """Expected row count if PROVENANCE records it (giants have exact SODA counts)."""
    p = os.path.join(raw_dir, "PROVENANCE.json")
    if os.path.exists(p):
        try:
            d = json.load(open(p, encoding="utf-8"))
        except Exception:
            return None
        # Prefer the parser-verified true count, then the SODA/whole-file counts.
        # Key variants across phase-1 (ridership giants) and phase-2 (sidewalk/street/qol) provenance.
        for k in ("actual_data_rows", "rows_expected_soda_count",
                  "rows_or_features", "expected_rows", "rows"):
            v = d.get(k)
            if v is not None:
                return v
        return None
    return None

def con_new(mem="10GB", threads=8):
    con = duckdb.connect()
    con.execute(f"PRAGMA memory_limit='{mem}'")
    con.execute(f"PRAGMA threads={threads}")
    con.execute(f"PRAGMA temp_directory='{SCRATCH.replace(os.sep,'/')}'")
    con.execute("PRAGMA preserve_insertion_order=false")
    con.execute("INSTALL spatial; LOAD spatial;")
    return con

def rm_target(path):
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    elif os.path.isfile(path):
        os.remove(path)

def rel(p):
    return p.replace(os.sep, "/")

def target_path(category, slug, hive=False):
    d = os.path.join(LAKE, category)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, slug) if hive else os.path.join(d, slug + ".parquet")

def prov_cols_sql(raw_dir):
    dsid, retrieved, vintage = get_prov(raw_dir)
    return (f"'{dsid}' AS source_dataset_id, '{retrieved}' AS retrieved_at, "
            f"'{vintage}' AS vintage")

# ---------------------------------------------------------------- converters

def do_tabular_csv(con, task):
    """Straight CSV -> single parquet with provenance columns."""
    src = os.path.join(RAW, task["src"])
    raw_dir = os.path.dirname(src)
    tgt = target_path(task["category"], task["slug"])
    rm_target(tgt)
    opts = task.get("read_opts", "header=true, sample_size=-1")
    extra = task.get("extra_select", "")
    extra = (extra + ", ") if extra else ""
    sql = f"""
        COPY (
          SELECT {extra}*, {prov_cols_sql(raw_dir)}
          FROM read_csv('{rel(src)}', {opts})
        ) TO '{rel(tgt)}' (FORMAT PARQUET, COMPRESSION zstd)
    """
    con.execute(sql)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{rel(tgt)}')").fetchone()[0]
    return tgt, n

def do_giant(con, task, src_idx=-1, no_rm=False, year_filter=None):
    """Multi-source CSV -> hive-partitioned-by-year parquet (streamed).

    src_idx>=0   : process only that one source (for splitting across foreground calls).
    no_rm        : do not clear the target dir first (append additional source/year).
    year_filter  : only emit rows for this year (adds WHERE on the year expression).
    """
    tgt = target_path(task["category"], task["slug"], hive=True)
    # disk guard
    free = disk_free_gb()
    if free < GIANT_MIN_HEADROOM_GB:
        raise RuntimeError(f"DISK GUARD: only {free:.1f} GB free on D: (< {GIANT_MIN_HEADROOM_GB}) -- aborting giant {task['slug']}")
    if not no_rm:
        rm_target(tgt)
    os.makedirs(tgt, exist_ok=True)
    total = 0
    sources = list(enumerate(task["sources"]))
    if src_idx >= 0:
        sources = [(src_idx, task["sources"][src_idx])]
    for i, s in sources:
        src = os.path.join(RAW, s["src"])
        raw_dir = os.path.dirname(src)
        free = disk_free_gb()
        if free < GIANT_MIN_HEADROOM_GB:
            raise RuntimeError(f"DISK GUARD mid-giant: {free:.1f} GB free -- aborting before {s['src']}")
        read_opts = s.get("read_opts", task.get("read_opts", "header=true"))
        year_expr = s.get("year_expr", task["year_expr"])
        fname = "data_" + s["src"].split("/")[-1].replace(".csv", "").replace(".", "_")
        t0 = time.time()
        # If the source already carries a column literally named 'year', EXCLUDE it
        # before re-adding the (recast) partition column to avoid a duplicate binding.
        if task.get("year_is_col"):
            ycol = task.get("year_col_name", "year")
            select_cols = f"* EXCLUDE({ycol}), CAST({year_expr} AS INTEGER) AS year, {prov_cols_sql(raw_dir)}"
        else:
            select_cols = f"*, CAST({year_expr} AS INTEGER) AS year, {prov_cols_sql(raw_dir)}"
        where = f"WHERE CAST({year_expr} AS INTEGER) = {int(year_filter)}" if year_filter is not None else ""
        sql = f"""
            COPY (
              SELECT {select_cols}
              FROM read_csv('{rel(src)}', {read_opts})
              {where}
            ) TO '{rel(tgt)}' (
              FORMAT PARQUET, COMPRESSION zstd,
              PARTITION_BY (year), OVERWRITE_OR_IGNORE,
              FILENAME_PATTERN '{fname}_{{i}}'
            )
        """
        con.execute(sql)
        n = con.execute(f"SELECT count(*) FROM read_parquet('{rel(tgt)}/**/*.parquet', hive_partitioning=1)").fetchone()[0] - total
        total += n
        print(f"    [{task['slug']}] {s['src']}: {n:,} rows in {time.time()-t0:.0f}s "
              f"(free D: {disk_free_gb():.0f} GB)", flush=True)
    return tgt, total

def _geom2263_expr(gcol, src_crs):
    if src_crs == "EPSG:2263":
        return f'ST_AsWKB("{gcol}")'
    return f"ST_AsWKB(ST_Transform(\"{gcol}\", '{src_crs}', 'EPSG:2263', always_xy := true))"

def do_geo(con, task):
    """GeoJSON / FGDB / Shapefile -> GeoParquet (geom_wkb source-CRS + geom_2263)."""
    tgt = target_path(task["category"], task["slug"])
    rm_target(tgt)
    reader = task["reader"]          # ST_Read source (may be /vsizip path)
    gcol = task["geom_col"]
    src_crs = task["src_crs"]
    raw_dir = task["raw_dir"]
    where = task.get("where", "")
    def build(makevalid=False):
        gexpr = f'"{gcol}"'
        if makevalid:
            gexpr = f"ST_MakeValid({gexpr})"
        wkb = f"ST_AsWKB({gexpr})"
        if src_crs == "EPSG:2263":
            g2263 = wkb
        else:
            g2263 = f"ST_AsWKB(ST_Transform({gexpr}, '{src_crs}', 'EPSG:2263', always_xy := true))"
        return f"""
            COPY (
              SELECT * EXCLUDE ("{gcol}"),
                     '{src_crs}' AS geometry_crs,
                     {wkb}  AS geom_wkb,
                     {g2263} AS geom_2263,
                     {prov_cols_sql(raw_dir)}
              FROM ST_Read('{reader}') {where}
            ) TO '{rel(tgt)}' (FORMAT PARQUET, COMPRESSION zstd)
        """
    try:
        con.execute(build(False))
    except Exception as e:
        print(f"    [{task['slug']}] plain geo COPY failed ({repr(e)[:120]}); retrying with ST_MakeValid", flush=True)
        con.execute(build(True))
    n = con.execute(f"SELECT count(*) FROM read_parquet('{rel(tgt)}')").fetchone()[0]
    return tgt, n

def do_csv_wkt(con, task):
    """CSV carrying a WKT geometry column -> GeoParquet."""
    src = os.path.join(RAW, task["src"])
    raw_dir = os.path.dirname(src)
    tgt = target_path(task["category"], task["slug"])
    rm_target(tgt)
    gcol = task["wkt_col"]; src_crs = task["src_crs"]
    opts = task.get("read_opts", "header=true, sample_size=-1")
    g = f'ST_GeomFromText("{gcol}")'
    wkb = f"ST_AsWKB({g})"
    g2263 = wkb if src_crs == "EPSG:2263" else f"ST_AsWKB(ST_Transform({g}, '{src_crs}', 'EPSG:2263', always_xy := true))"
    sql = f"""
        COPY (
          SELECT * EXCLUDE ("{gcol}"),
                 '{src_crs}' AS geometry_crs,
                 {wkb} AS geom_wkb,
                 {g2263} AS geom_2263,
                 {prov_cols_sql(raw_dir)}
          FROM read_csv('{rel(src)}', {opts})
          WHERE "{gcol}" IS NOT NULL AND length("{gcol}") > 0
        ) TO '{rel(tgt)}' (FORMAT PARQUET, COMPRESSION zstd)
    """
    con.execute(sql)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{rel(tgt)}')").fetchone()[0]
    return tgt, n

def do_point_csv(con, task):
    """Tabular CSV with lat/lon columns -> parquet + point geom (4326 src)."""
    src = os.path.join(RAW, task["src"])
    raw_dir = os.path.dirname(src)
    tgt = target_path(task["category"], task["slug"])
    rm_target(tgt)
    lat, lon = task["lat"], task["lon"]
    opts = task.get("read_opts", "header=true, normalize_names=true, sample_size=-1")
    pt = f'ST_Point(CAST("{lon}" AS DOUBLE), CAST("{lat}" AS DOUBLE))'
    sql = f"""
        COPY (
          SELECT *,
                 'EPSG:4326' AS geometry_crs,
                 CASE WHEN "{lat}" IS NOT NULL AND "{lon}" IS NOT NULL THEN ST_AsWKB({pt}) END AS geom_wkb,
                 CASE WHEN "{lat}" IS NOT NULL AND "{lon}" IS NOT NULL
                      THEN ST_AsWKB(ST_Transform({pt}, 'EPSG:4326', 'EPSG:2263', always_xy := true)) END AS geom_2263,
                 {prov_cols_sql(raw_dir)}
          FROM read_csv('{rel(src)}', {opts})
        ) TO '{rel(tgt)}' (FORMAT PARQUET, COMPRESSION zstd)
    """
    con.execute(sql)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{rel(tgt)}')").fetchone()[0]
    return tgt, n

def do_lodes(con, task):
    """gzipped LODES CSV(s) -> parquet; multiple parts get a 'part' column."""
    tgt = target_path(task["category"], task["slug"])
    rm_target(tgt)
    parts = task["parts"]  # list of (label, relpath)
    raw_dir = os.path.join(RAW, os.path.dirname(parts[0][1]))
    unions = []
    for label, rp in parts:
        src = os.path.join(RAW, rp)
        unions.append(f"SELECT *, '{label}' AS part FROM read_csv('{rel(src)}', header=true, sample_size=-1, all_varchar=false)")
    body = "\nUNION ALL BY NAME\n".join(unions)
    sql = f"""
        COPY (
          SELECT *, {prov_cols_sql(raw_dir)}
          FROM ( {body} )
        ) TO '{rel(tgt)}' (FORMAT PARQUET, COMPRESSION zstd)
    """
    con.execute(sql)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{rel(tgt)}')").fetchone()[0]
    return tgt, n

def do_citibike(con, task):
    """station_information.json (GBFS) -> flat parquet."""
    import pandas as pd
    src = os.path.join(RAW, task["src"])
    raw_dir = os.path.dirname(src)
    tgt = target_path(task["category"], task["slug"])
    rm_target(tgt)
    d = json.load(open(src, encoding="utf-8"))
    stations = d.get("data", {}).get("stations", [])
    df = pd.json_normalize(stations)
    # normalize list/dict cols to strings so parquet is happy
    for c in df.columns:
        if df[c].dtype == object:
            df[c] = df[c].apply(lambda v: json.dumps(v) if isinstance(v, (list, dict)) else v)
    dsid, retrieved, vintage = get_prov(raw_dir)
    df["source_dataset_id"] = dsid; df["retrieved_at"] = retrieved; df["vintage"] = vintage
    con.register("cb", df)
    con.execute(f"COPY cb TO '{rel(tgt)}' (FORMAT PARQUET, COMPRESSION zstd)")
    con.unregister("cb")
    n = len(df)
    return tgt, n

def do_gtfs_union(con, task):
    """Union one GTFS file across feeds with a 'feed' column."""
    tgt = target_path(task["category"], task["slug"])
    rm_target(tgt)
    fname = task["file"]            # e.g. routes.txt
    feeds = task["feeds"]           # list of (feed_label, feed_dir)
    casts = task.get("casts", "")   # extra normalized cast list, or ""
    unions = []
    for label, fdir in feeds:
        fp = os.path.join(RAW, "transit_static", fdir, "gtfs", fname)
        if not os.path.exists(fp):
            continue
        sel = f"SELECT '{label}' AS feed, {casts} * FROM read_csv('{rel(fp)}', header=true, all_varchar=true, sample_size=-1)"
        unions.append(sel)
    if not unions:
        raise RuntimeError(f"no feed files found for {fname}")
    body = "\nUNION ALL BY NAME\n".join(unions)
    sql = f"COPY ( {body} ) TO '{rel(tgt)}' (FORMAT PARQUET, COMPRESSION zstd)"
    con.execute(sql)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{rel(tgt)}')").fetchone()[0]
    return tgt, n

# ---------------------------------------------------------------- task table

def vsizip(relzip, inner):
    return "/vsizip/" + os.path.abspath(os.path.join(RAW, relzip)).replace("\\", "/") + "/" + inner

GTFS_FEEDS = [
    ("subway", "gtfs_subway_supplemented"),
    ("bus_bronx", "gtfs_bus_bronx"),
    ("bus_brooklyn", "gtfs_bus_brooklyn"),
    ("bus_manhattan", "gtfs_bus_manhattan"),
    ("bus_queens", "gtfs_bus_queens"),
    ("bus_staten_island", "gtfs_bus_staten_island"),
    ("bus_mta_bus_company", "gtfs_bus_mta_bus_company"),
    ("ferry", "gtfs_ferry"),
    ("lirr", "gtfs_lirr"),
    ("mnr", "gtfs_mnr"),
]

# read_csv columns for the giants (explicit where sniffing is unreliable)
BUS_HOURLY_COLS = ("columns={'transit_timestamp':'TIMESTAMP','bus_route':'VARCHAR',"
    "'payment_method':'VARCHAR','fare_class_category':'VARCHAR','ridership':'DOUBLE','transfers':'DOUBLE'}, header=true")
SUBWAY_HOURLY_COLS = ("columns={'transit_timestamp':'TIMESTAMP','transit_mode':'VARCHAR',"
    "'station_complex_id':'VARCHAR','station_complex':'VARCHAR','borough':'VARCHAR',"
    "'payment_method':'VARCHAR','fare_class_category':'VARCHAR','ridership':'DOUBLE','transfers':'DOUBLE',"
    "'latitude':'DOUBLE','longitude':'DOUBLE','georeference':'VARCHAR'}, header=true")
OD_COLS = ("columns={'year':'INTEGER','month':'INTEGER','day_of_week':'VARCHAR','hour_of_day':'INTEGER',"
    "'timestamp':'TIMESTAMP','origin_station_complex_id':'VARCHAR','origin_station_complex_name':'VARCHAR',"
    "'origin_latitude':'DOUBLE','origin_longitude':'DOUBLE','destination_station_complex_id':'VARCHAR',"
    "'destination_station_complex_name':'VARCHAR','destination_latitude':'DOUBLE','destination_longitude':'DOUBLE',"
    "'estimated_average_ridership':'DOUBLE','origin_point':'VARCHAR','destination_point':'VARCHAR'}, header=true")

TASKS = [
    # ---- GIANTS (hive by year) ----
    {"kind":"giant","category":"ridership","slug":"transit_ridership_bus_hourly",
     "year_expr":"year(transit_timestamp)", "sources":[
        {"src":"ridership/bus_hourly_ridership_2020_2024/bus_hourly_ridership_2020_2024.csv","read_opts":BUS_HOURLY_COLS},
        {"src":"ridership/bus_hourly_ridership_2025/bus_hourly_ridership_2025.csv","read_opts":BUS_HOURLY_COLS}]},
    {"kind":"giant","category":"ridership","slug":"transit_ridership_subway_hourly",
     "year_expr":"year(transit_timestamp)", "sources":[
        {"src":"ridership/subway_hourly_ridership_2020_2024/subway_hourly_ridership_2020_2024.csv","read_opts":SUBWAY_HOURLY_COLS},
        {"src":"ridership/subway_hourly_ridership_2025/subway_hourly_ridership_2025.csv","read_opts":SUBWAY_HOURLY_COLS}]},
    {"kind":"giant","category":"ridership","slug":"transit_od_matrix",
     "year_expr":"year", "year_is_col":True, "sources":[
        {"src":"ridership/subway_origin_destination_2024/subway_origin_destination_2024.csv","read_opts":OD_COLS}]},
    {"kind":"giant","category":"ridership","slug":"transit_segment_speeds",
     "year_expr":"_year", "year_is_col":True, "year_col_name":"_year",
     "read_opts":"header=true, normalize_names=true, sample_size=200000",
     "sources":[
        {"src":"ridership/bus_segment_speeds_2023_2024/bus_segment_speeds_2023_2024.csv"},
        {"src":"ridership/bus_segment_speeds_2025/bus_segment_speeds_2025.csv"}]},

    # ---- ridership tabular ----
    {"kind":"tabular","category":"ridership","slug":"transit_ace_violations",
     "src":"ridership/ace_violations/ace_violations.csv","read_opts":"header=true, normalize_names=true, sample_size=200000"},
    {"kind":"tabular","category":"ridership","slug":"transit_ace_routes",
     "src":"ridership/ace_routes/ace_routes.csv","read_opts":"header=true, normalize_names=true, sample_size=-1"},
    {"kind":"tabular","category":"ridership","slug":"transit_elev_esc",
     "src":"ridership/elevator_escalator_availability/elevator_escalator_availability.csv","read_opts":"header=true, normalize_names=true, sample_size=-1"},
    {"kind":"tabular","category":"ridership","slug":"transit_daily_ridership",
     "src":"ridership/daily_ridership/daily_ridership.csv","read_opts":"header=true, normalize_names=true, sample_size=-1"},

    # ---- population geo ----
    {"kind":"geo","category":"population","slug":"pop_census_blocks",
     "reader":rel(os.path.join(RAW,"population/census_blocks/2020_census_blocks_wmsu-5muw.geojson")),
     "geom_col":"geom","src_crs":"EPSG:4326","raw_dir":os.path.join(RAW,"population/census_blocks")},
    {"kind":"geo","category":"population","slug":"pop_tracts",
     "reader":rel(os.path.join(RAW,"population/tracts/2020_census_tracts_63ge-mke6.geojson")),
     "geom_col":"geom","src_crs":"EPSG:4326","raw_dir":os.path.join(RAW,"population/tracts")},
    {"kind":"geo","category":"population","slug":"pop_ntas",
     "reader":rel(os.path.join(RAW,"population/nta/2020_nta_9nt8-h7nd.geojson")),
     "geom_col":"geom","src_crs":"EPSG:4326","raw_dir":os.path.join(RAW,"population/nta")},
    {"kind":"geo","category":"population","slug":"pop_cdtas",
     "reader":rel(os.path.join(RAW,"population/cdta/2020_cdta_xn3r-zk6y.geojson")),
     "geom_col":"geom","src_crs":"EPSG:4326","raw_dir":os.path.join(RAW,"population/cdta")},

    # ---- population tabular ----
    {"kind":"tabular","category":"population","slug":"pop_block_pop",
     "src":"population/pl94171_block_pop/pl94171_2020_block_nyc5.csv",
     "read_opts":"header=true, sample_size=-1, all_varchar=true",
     "extra_select":"(state || county || tract || block) AS GEOID15, TRY_CAST(P1_001N AS BIGINT) AS total_pop"},
    {"kind":"tabular","category":"population","slug":"pop_bg_acs",
     "src":"population/acs_bg/acs5_2023_bg_nyc5.csv",
     "read_opts":"header=true, sample_size=-1, all_varchar=true",
     "extra_select":'(state || county || tract || "block group") AS GEOID12'},
    {"kind":"tabular","category":"population","slug":"pop_nta_demographics",
     "src":"population/nta_demographics/nta_demographics_rnsn-acs2.csv","read_opts":"header=true, normalize_names=true, sample_size=-1"},

    # ---- landuse geo ----
    {"kind":"geo","category":"landuse","slug":"geo_pluto_lots",
     "reader":vsizip("landuse/mappluto/nyc_mappluto_26v1_fgdb.zip","MapPLUTO26v1.gdb"),
     "geom_col":"Shape","src_crs":"EPSG:2263","raw_dir":os.path.join(RAW,"landuse/mappluto")},
    {"kind":"geo","category":"landuse","slug":"geo_building_footprints",
     "reader":rel(os.path.join(RAW,"landuse/building_footprints/building_footprints_5zhs-2jue.geojson")),
     "geom_col":"geom","src_crs":"EPSG:4326","raw_dir":os.path.join(RAW,"landuse/building_footprints")},
    {"kind":"geo","category":"landuse","slug":"geo_tiger_blocks",
     "reader":vsizip("landuse/tiger_2024/tl_2024_36_tabblock20.zip","tl_2024_36_tabblock20.shp"),
     "geom_col":"geom","src_crs":"EPSG:4269","raw_dir":os.path.join(RAW,"landuse/tiger_2024"),
     "where":"WHERE COUNTYFP20 IN ('005','047','061','081','085')"},
    {"kind":"geo","category":"landuse","slug":"geo_tiger_bg",
     "reader":vsizip("landuse/tiger_2024/tl_2024_36_bg.zip","tl_2024_36_bg.shp"),
     "geom_col":"geom","src_crs":"EPSG:4269","raw_dir":os.path.join(RAW,"landuse/tiger_2024"),
     "where":"WHERE COUNTYFP IN ('005','047','061','081','085')"},
    {"kind":"geo","category":"landuse","slug":"geo_tiger_tracts",
     "reader":vsizip("landuse/tiger_2024/tl_2024_36_tract.zip","tl_2024_36_tract.shp"),
     "geom_col":"geom","src_crs":"EPSG:4269","raw_dir":os.path.join(RAW,"landuse/tiger_2024"),
     "where":"WHERE COUNTYFP IN ('005','047','061','081','085')"},

    # ---- landuse tabular (LODES) ----
    {"kind":"lodes","category":"landuse","slug":"pop_lodes_od",
     "parts":[("main","landuse/lodes8_ny/ny_od_main_JT00_2023.csv.gz"),
              ("aux","landuse/lodes8_ny/ny_od_aux_JT00_2023.csv.gz")]},
    {"kind":"lodes","category":"landuse","slug":"pop_lodes_rac",
     "parts":[("rac","landuse/lodes8_ny/ny_rac_S000_JT00_2023.csv.gz")]},
    {"kind":"lodes","category":"landuse","slug":"pop_lodes_wac",
     "parts":[("wac","landuse/lodes8_ny/ny_wac_S000_JT00_2023.csv.gz")]},
    {"kind":"lodes","category":"landuse","slug":"pop_lodes_xwalk",
     "parts":[("xwalk","landuse/lodes8_ny/ny_xwalk.csv.gz")]},

    # ---- transit_static: geo/point ----
    {"kind":"csv_wkt","category":"transit_static","slug":"geo_bus_lanes",
     "src":"transit_static/bus_lanes/bus_lanes.csv","wkt_col":"the_geom","src_crs":"EPSG:4326",
     "read_opts":"header=true, sample_size=-1, all_varchar=true"},
    {"kind":"point_csv","category":"transit_static","slug":"transit_bus_stops",
     "src":"transit_static/bus_stops/bus_stops_in_effect.csv","lat":"latitude","lon":"longitude"},
    {"kind":"point_csv","category":"transit_static","slug":"transit_subway_stations",
     "src":"transit_static/subway_stations/subway_stations.csv","lat":"gtfs_latitude","lon":"gtfs_longitude"},
    {"kind":"point_csv","category":"transit_static","slug":"transit_subway_entrances",
     "src":"transit_static/subway_entrances_exits/subway_entrances_exits.csv","lat":"entrance_latitude","lon":"entrance_longitude"},
    {"kind":"citibike","category":"transit_static","slug":"transit_citibike_stations",
     "src":"transit_static/citibike_stations/station_information.json"},

    # ---- transit_static: GTFS union (feed column) ----
    {"kind":"gtfs","category":"transit_static","slug":"transit_gtfs_routes","file":"routes.txt","feeds":GTFS_FEEDS},
    {"kind":"gtfs","category":"transit_static","slug":"transit_gtfs_trips","file":"trips.txt","feeds":GTFS_FEEDS},
    {"kind":"gtfs","category":"transit_static","slug":"transit_gtfs_stops","file":"stops.txt","feeds":GTFS_FEEDS},
    {"kind":"gtfs","category":"transit_static","slug":"transit_gtfs_stop_times","file":"stop_times.txt","feeds":GTFS_FEEDS},
    {"kind":"gtfs","category":"transit_static","slug":"transit_gtfs_shapes","file":"shapes.txt","feeds":GTFS_FEEDS},

    # ===================== PHASE 2 (B4 Pass 2): sidewalk_pedestrian / street_network / qol =====================

    # ---- sidewalk_pedestrian: planimetric geo (the_geom WKT, Socrata-reprojected to 4326) ----
    # Big planimetric layers read all_varchar (skip type sniff on 440-510 MB CSVs); numeric SHAPE_* kept verbatim as text.
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_sidewalk_polys",
     "src":"sidewalk_pedestrian/planimetric_sidewalk_polygons/planimetric_sidewalk_polygons.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, all_varchar=true"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_curbs",
     "src":"sidewalk_pedestrian/planimetric_curbs/planimetric_curbs.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, all_varchar=true"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_roadbed",
     "src":"sidewalk_pedestrian/planimetric_roadbed/planimetric_roadbed.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, all_varchar=true"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_ramps",
     "src":"sidewalk_pedestrian/pedestrian_ramps/pedestrian_ramps.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_plazas",
     "src":"sidewalk_pedestrian/pedestrian_plazas/pedestrian_plazas.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_open_streets",
     "src":"sidewalk_pedestrian/open_streets/open_streets.csv",
     "wkt_col":"The_Geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_shelters",
     "src":"sidewalk_pedestrian/bus_stop_shelters/bus_stop_shelters.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_benches",
     "src":"sidewalk_pedestrian/city_benches/city_benches.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"geo_seating",
     "src":"sidewalk_pedestrian/street_seating/street_seating.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},

    # ---- sidewalk_pedestrian: ped analysis layers (geometry-bearing but plan-named ped_*/sidewalk_*) ----
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"ped_counts_biannual",
     "src":"sidewalk_pedestrian/pedestrian_counts_biannual/pedestrian_counts_biannual.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},
    {"kind":"csv_wkt","category":"sidewalk_pedestrian","slug":"ped_mobility_demand",
     "src":"sidewalk_pedestrian/pedestrian_mobility_demand/pedestrian_mobility_demand.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},

    # ---- sidewalk_pedestrian: non-geo tabular ----
    {"kind":"tabular","category":"sidewalk_pedestrian","slug":"sidewalk_violations",
     "src":"sidewalk_pedestrian/sidewalk_mgmt_violations/sidewalk_mgmt_violations.csv",
     "read_opts":"header=true, normalize_names=true, sample_size=200000, all_varchar=true"},
    {"kind":"tabular","category":"sidewalk_pedestrian","slug":"sidewalk_built",
     "src":"sidewalk_pedestrian/sidewalk_mgmt_built/sidewalk_mgmt_built.csv",
     "read_opts":"header=true, normalize_names=true, sample_size=-1, all_varchar=true"},

    # ---- sidewalk_pedestrian: automated bike/ped counts GIANT (3.2 GB; external view; PROVENANCE may be absent) ----
    {"kind":"giant","category":"sidewalk_pedestrian","slug":"ped_counts_automated",
     "year_expr":'year(try_cast("timestamp" AS TIMESTAMP))',
     "sources":[
        {"src":"sidewalk_pedestrian/automated_bike_ped_counts/automated_bike_ped_counts.csv",
         "read_opts":"header=true, all_varchar=true"}]},

    # ---- street_network: geo (the_geom WKT 4326) ----
    {"kind":"csv_wkt","category":"street_network","slug":"geo_cscl",
     "src":"street_network/cscl_street_centerline/cscl_street_centerline.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, all_varchar=true"},
    {"kind":"csv_wkt","category":"street_network","slug":"geo_bike_routes",
     "src":"street_network/bike_routes/bike_routes.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},
    {"kind":"csv_wkt","category":"street_network","slug":"geo_truck_routes",
     "src":"street_network/truck_routes/truck_routes.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},

    # ---- street_network: LION File-GDB (native 2263) ----
    {"kind":"geo","category":"street_network","slug":"geo_lion",
     "reader":vsizip("street_network/lion/nyclion.zip","lion/lion.gdb"),
     "geom_col":"Shape","src_crs":"EPSG:2263","raw_dir":os.path.join(RAW,"street_network/lion")},

    # ---- street_network: traffic volumes (7ym2 has WktGeom POINT in 2263; btm5 historical, no geom) ----
    {"kind":"csv_wkt","category":"street_network","slug":"traffic_volumes",
     "src":"street_network/traffic_volumes_7ym2/traffic_volumes_7ym2.csv",
     "wkt_col":"WktGeom","src_crs":"EPSG:2263","read_opts":"header=true, sample_size=-1"},
    {"kind":"tabular","category":"street_network","slug":"traffic_volumes_hist",
     "src":"street_network/traffic_volumes_btm5/traffic_volumes_btm5.csv",
     "read_opts":"header=true, sample_size=-1, all_varchar=true"},

    # ---- street_network: speed limits (the_geom LINESTRING 4326) + parking signs (tabular; x/y in 2263 ft) ----
    {"kind":"csv_wkt","category":"street_network","slug":"speed_limits",
     "src":"street_network/vzv_speed_limits/vzv_speed_limits.csv",
     "wkt_col":"the_geom","src_crs":"EPSG:4326","read_opts":"header=true, sample_size=-1"},
    {"kind":"tabular","category":"street_network","slug":"parking_signs",
     "src":"street_network/parking_signs/parking_signs.csv",
     "read_opts":"header=true, sample_size=200000, all_varchar=true"},

    # ---- qol: GIANTS (external hive-by-year views) ----
    {"kind":"giant","category":"qol","slug":"qol_sr311",
     "year_expr":"year(try_cast(created_date AS TIMESTAMP))",
     "sources":[
        {"src":"qol/311_service_requests/311_service_requests.csv",
         "read_opts":"header=true, all_varchar=true"}]},
    {"kind":"giant","category":"qol","slug":"qol_nypd_complaints",
     "year_expr":"year(try_cast(rpt_dt AS TIMESTAMP))",
     "sources":[
        {"src":"qol/nypd_complaints_historic/nypd_complaints_historic.csv",
         "read_opts":"header=true, all_varchar=true"}]},

    # ---- qol: point tables (lat/lon 4326) ----
    {"kind":"point_csv","category":"qol","slug":"qol_trees",
     "src":"qol/street_tree_census_2015/street_tree_census_2015.csv","lat":"latitude","lon":"longitude"},
    {"kind":"point_csv","category":"qol","slug":"qol_crashes",
     "src":"qol/mvc_crashes/mvc_crashes.csv","lat":"latitude","lon":"longitude",
     "read_opts":"header=true, normalize_names=true, sample_size=-1, all_varchar=true"},
    {"kind":"point_csv","category":"qol","slug":"qol_nypd_ytd",
     "src":"qol/nypd_complaints_ytd/nypd_complaints_ytd.csv","lat":"latitude","lon":"longitude",
     "read_opts":"header=true, normalize_names=true, sample_size=200000, all_varchar=true"},

    # ---- qol: non-geo tabular ----
    {"kind":"tabular","category":"qol","slug":"qol_crashes_persons",
     "src":"qol/mvc_persons/mvc_persons.csv","read_opts":"header=true, normalize_names=true, sample_size=-1, all_varchar=true"},
    {"kind":"tabular","category":"qol","slug":"qol_air_quality",
     "src":"qol/nyccas_air_quality/nyccas_air_quality.csv","read_opts":"header=true, normalize_names=true, sample_size=-1"},
]

DISPATCH = {
    "giant":do_giant, "tabular":do_tabular_csv, "geo":do_geo, "csv_wkt":do_csv_wkt,
    "point_csv":do_point_csv, "lodes":do_lodes, "citibike":do_citibike, "gtfs":do_gtfs_union,
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma list of slugs")
    ap.add_argument("--skip-giants", action="store_true")
    ap.add_argument("--src-idx", type=int, default=-1, help="giant: process only this source index")
    ap.add_argument("--no-rm", action="store_true", help="giant: append (do not clear target)")
    ap.add_argument("--year", type=int, default=None, help="giant: only emit this year")
    args = ap.parse_args()
    only = set(s.strip() for s in args.only.split(",") if s.strip())

    results = []
    print(f"convert_lake.py  |  D: free = {disk_free_gb():.0f} GB  |  {len(TASKS)} tasks", flush=True)
    log_build(f"convert_lake START (D: {disk_free_gb():.0f} GB free)")
    for task in TASKS:
        slug = task["slug"]
        if only and slug not in only:
            continue
        if args.skip_giants and task["kind"] == "giant":
            print(f"  SKIP (giant) {slug}", flush=True); continue
        fn = DISPATCH[task["kind"]]
        ok = False
        for attempt in (1, 2):
            con = con_new()
            try:
                t0 = time.time()
                print(f"  -> {slug} [{task['kind']}] attempt {attempt}", flush=True)
                if task["kind"] == "giant":
                    tgt, n = fn(con, task, src_idx=args.src_idx, no_rm=args.no_rm, year_filter=args.year)
                else:
                    tgt, n = fn(con, task)
                dt = time.time() - t0
                # size
                if os.path.isdir(tgt):
                    sz = sum(os.path.getsize(os.path.join(r,f)) for r,_,fs in os.walk(tgt) for f in fs)
                else:
                    sz = os.path.getsize(tgt)
                print(f"     OK {slug}: {n:,} rows, {sz/1e6:.1f} MB, {dt:.0f}s", flush=True)
                results.append((slug, n, sz, "OK"))
                ok = True
                con.close()
                break
            except Exception as e:
                con.close()
                print(f"     FAIL {slug} attempt {attempt}: {repr(e)[:200]}", flush=True)
                if attempt == 2:
                    log_build(f"FAILED {slug} after 2 attempts: {repr(e)[:300]}")
                    log_build("TRACE: " + traceback.format_exc().replace("\n"," | ")[:600])
                    results.append((slug, 0, 0, "FAIL"))
                else:
                    time.sleep(3)
        # end attempts
    # summary
    print("\n===== LAKE INVENTORY =====", flush=True)
    tot = 0
    for slug, n, sz, st in results:
        tot += sz
        print(f"  {st:4} {slug:38} {n:>14,} rows  {sz/1e6:>10.1f} MB", flush=True)
    print(f"  TOTAL lake bytes: {tot/1e9:.2f} GB", flush=True)
    log_build(f"convert_lake END: {sum(1 for r in results if r[3]=='OK')}/{len(results)} OK, {tot/1e9:.2f} GB lake")
    # persist inventory json
    inv = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "results":[{"slug":s,"rows":n,"bytes":sz,"status":st} for s,n,sz,st in results]}
    json.dump(inv, open(os.path.join(ROOT,"db","LAKE_INVENTORY.json"),"w"), indent=2)

if __name__ == "__main__":
    main()
