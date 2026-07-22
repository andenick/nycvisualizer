"""Renter's Map precompute — per-H3-res-10-cell scores + per-BBL building aggregates.

Resumable, checkpointed stages (each foreground-safe, < ~5 min):

  bbl       -> per-BBL aggregates (HPD open violations / DOB 5y permits / landlord portfolio)
  cells     -> land cell universe + 400 m neighbour map            -> _stage/{cells,nbr}.parquet
  base      -> populated flag + transit supply + nearest subway + jobs -> _stage/base.parquet
  qol       -> quality-of-life densities within 400 m               -> _stage/qol.parquet
  flood     -> stormwater + FEMA-SFHA point-in-polygon flags        -> _stage/flood.parquet
  assemble  -> join stages + citywide percentiles                   -> renters_grid.parquet
  grid      -> cells + base + qol + flood + assemble, in order
  all       -> bbl + grid

Everything spatial is EPSG:2263 (ftUS); neighbourhood aggregation is a 400 m centroid-distance disk
over land cells. See METHODS.md for every formula.

Flood note: geo_flood_stormwater is dissolved citywide OGC-invalid MultiPolygons (7k-98k rings each);
a raw ST_Intersects join is catastrophic. We ST_Dump them into ~171k individual parts first (~1.4 s),
which lets DuckDB bbox-prune the point-in-polygon join (all 58 k cells in ~5 s).

Usage:
  PYTHONIOENCODING=utf-8 python build_renters_grid.py <stage>
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import duckdb
import h3
import pandas as pd

HERE = Path(__file__).resolve().parent
PLATFORM = HERE.parents[1]                       # analysis/renters -> analysis -> NYCPlatform
DB = PLATFORM / "db" / "jane_geo.duckdb"
OUT_ROOT = PLATFORM.parents[1] / "Outputs" / "NYCPlatform"
OUTPUTS = OUT_ROOT / "renters"
STAGE = OUTPUTS / "_stage"
OUTPUTS.mkdir(parents=True, exist_ok=True)
STAGE.mkdir(parents=True, exist_ok=True)

ACCESS = PLATFORM / "analysis" / "access"
ORIGIN_CELLS = ACCESS / "_cache" / "origin_cells.parquet"
BLOCKS_TAGGED = ACCESS / "_cache" / "blocks_tagged.parquet"
ISO_GRID = ACCESS / "isochrone_grid_45min.parquet"
SAI = OUT_ROOT / "sai" / "sai_scores.parquet"
COVERAGE = OUT_ROOT / "sidewalk" / "01_coverage_segments.parquet"

GRID_OUT = OUTPUTS / "renters_grid.parquet"
HPD_OUT = OUTPUTS / "hpd_open_violations_by_bbl.parquet"
DOB_OUT = OUTPUTS / "dob_permits_5y_by_bbl.parquet"
LANDLORD_OUT = OUTPUTS / "landlord_portfolio_by_bbl.parquet"

CELLS_PQ = STAGE / "cells.parquet"
NBR_PQ = STAGE / "nbr.parquet"
BASE_PQ = STAGE / "base.parquet"
QOL_PQ = STAGE / "qol.parquet"
FLOOD_PQ = STAGE / "flood.parquet"

NBR_RADIUS_FT = 400.0 / 0.3048   # 1312.34 ft
POP_RADIUS_FT = 300.0 / 0.3048   # 984.25 ft
DISK_K = 5


def _con(read_only: bool = True) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(DB), read_only=read_only)
    con.execute("LOAD spatial;")
    con.execute("INSTALL h3 FROM community; LOAD h3;")
    con.execute("PRAGMA threads=8;")
    con.execute(f"PRAGMA temp_directory='{(STAGE / '_tmp').as_posix()}';")
    con.execute("PRAGMA memory_limit='12GB';")
    return con


def _pp(p: Path) -> str:
    return p.as_posix()


# ===========================================================================
# STAGE bbl — per-BBL aggregates
# ===========================================================================
def build_bbl() -> None:
    con = _con()
    t0 = time.time()
    print("[bbl] HPD open violations by BBL ...", flush=True)
    con.execute(f"""
        COPY (
          WITH o AS (
            SELECT bbl, class, count(*) AS n FROM qol_hpd_violations
            WHERE violationstatus='Open' AND bbl IS NOT NULL AND length(bbl)=10
            GROUP BY bbl, class )
          SELECT bbl, sum(n) AS open_total,
                 sum(CASE WHEN class='A' THEN n ELSE 0 END) AS open_class_a,
                 sum(CASE WHEN class='B' THEN n ELSE 0 END) AS open_class_b,
                 sum(CASE WHEN class='C' THEN n ELSE 0 END) AS open_class_c,
                 sum(CASE WHEN class NOT IN ('A','B','C') THEN n ELSE 0 END) AS open_class_i
          FROM o GROUP BY bbl
        ) TO '{_pp(HPD_OUT)}' (FORMAT PARQUET)""")
    n = con.execute(f"SELECT count(*), sum(open_total) FROM read_parquet('{_pp(HPD_OUT)}')").fetchone()
    print(f"[bbl]   {n[0]:,} BBLs, {int(n[1]):,} open violations", flush=True)

    print("[bbl] DOB permits (last 5y) by BBL ...", flush=True)
    con.execute(f"""
        COPY (
          WITH d AS (
            SELECT bbl, TRY_CAST(coalesce(filing_date,issuance_date,pre__filing_date,
                                          latest_action_date) AS DATE) AS dt
            FROM qol_dob_permits WHERE bbl IS NOT NULL AND length(bbl)=10 )
          SELECT bbl, count(*) AS permits_5y, max(dt) AS last_permit_date
          FROM d WHERE dt IS NOT NULL AND dt >= (current_date - INTERVAL 5 YEAR)
          GROUP BY bbl
        ) TO '{_pp(DOB_OUT)}' (FORMAT PARQUET)""")
    n = con.execute(f"SELECT count(*), sum(permits_5y) FROM read_parquet('{_pp(DOB_OUT)}')").fetchone()
    print(f"[bbl]   {n[0]:,} BBLs, {int(n[1]):,} DOB filings (5y)", flush=True)

    print("[bbl] landlord portfolios (registration-contact owner proxy) ...", flush=True)
    con.execute("""
        CREATE TEMP TABLE reg AS
        SELECT registrationid, buildingid,
               (boroid||lpad(block,5,'0')||lpad(lot,4,'0')) AS bbl
        FROM qol_hpd_registrations
        WHERE boroid IS NOT NULL AND block IS NOT NULL AND lot IS NOT NULL
          AND TRY_CAST(boroid AS INT) BETWEEN 1 AND 5;""")
    con.execute("""
        CREATE TEMP TABLE owner AS
        SELECT c.registrationid,
               nullif(upper(trim(coalesce(nullif(trim(c.corporationname),''),
                     trim(coalesce(c.firstname,'')||' '||coalesce(c.lastname,''))))),'') AS owner_name,
               upper(trim(coalesce(c.businesshousenumber,'')||' '||coalesce(c.businessstreetname,'')||' '||
                          coalesce(c.businesszip,''))) AS owner_addr
        FROM qol_hpd_contacts c
        WHERE c.type IN ('HeadOfficer','IndividualOwner','CorporateOwner');""")
    con.execute("""
        CREATE TEMP TABLE reg_owner AS
        SELECT registrationid, owner_name,
               (coalesce(owner_name,'?')||'|'||coalesce(owner_addr,'?')) AS owner_key
        FROM (SELECT registrationid, owner_name, owner_addr,
                     row_number() OVER (PARTITION BY registrationid
                         ORDER BY (owner_name IS NULL), owner_name) rn
              FROM owner) WHERE rn=1 AND owner_name IS NOT NULL;""")
    con.execute("""
        CREATE TEMP TABLE owner_size AS
        SELECT ro.owner_key, count(DISTINCT r.buildingid) AS portfolio_buildings
        FROM reg r JOIN reg_owner ro USING (registrationid) GROUP BY ro.owner_key;""")
    con.execute(f"""
        COPY (
          SELECT r.bbl, any_value(ro.owner_name) AS owner_name, any_value(ro.owner_key) AS owner_key,
                 max(os.portfolio_buildings) AS portfolio_buildings
          FROM reg r JOIN reg_owner ro USING (registrationid) JOIN owner_size os USING (owner_key)
          WHERE r.bbl IS NOT NULL GROUP BY r.bbl
        ) TO '{_pp(LANDLORD_OUT)}' (FORMAT PARQUET)""")
    n = con.execute(f"SELECT count(*), max(portfolio_buildings) FROM read_parquet('{_pp(LANDLORD_OUT)}')").fetchone()
    print(f"[bbl]   {n[0]:,} BBLs, max portfolio {int(n[1]):,} buildings", flush=True)
    con.close()
    print(f"[bbl] done in {time.time()-t0:.1f}s", flush=True)


# ===========================================================================
# STAGE cells — land universe + 400 m neighbour map
# ===========================================================================
def build_cells() -> None:
    con = _con()
    t0 = time.time()
    print("[cells] deriving res-10 land cells from res-8 origin grid (python h3) ...", flush=True)
    origin = pd.read_parquet(ORIGIN_CELLS, columns=["res8"])
    landset: set[str] = set()
    for r8 in origin.res8:
        landset.update(h3.cell_to_children(r8, 10))
    land = sorted(landset)
    latlng = [h3.cell_to_latlng(c) for c in land]
    cells_df = pd.DataFrame({
        "cell": [h3.str_to_int(c) for c in land],
        "cell_str": land,
        "res8": [h3.cell_to_parent(c, 8) for c in land],
        "lat": [ll[0] for ll in latlng],
        "lon": [ll[1] for ll in latlng],
    })
    con.register("cells_df", cells_df)
    con.execute(f"""
        COPY (
          SELECT CAST(cell AS BIGINT) AS cell, cell_str, res8, lat, lon,
                 ST_X(ST_Transform(ST_Point(lon,lat),'EPSG:4326','EPSG:2263',always_xy:=true)) AS x,
                 ST_Y(ST_Transform(ST_Point(lon,lat),'EPSG:4326','EPSG:2263',always_xy:=true)) AS y
          FROM cells_df
        ) TO '{_pp(CELLS_PQ)}' (FORMAT PARQUET)""")
    n_cells = con.execute(f"SELECT count(*) FROM read_parquet('{_pp(CELLS_PQ)}')").fetchone()[0]
    print(f"[cells]   {n_cells:,} res-10 land cells -> {CELLS_PQ.name}", flush=True)

    print("[cells] building 400 m neighbour map ...", flush=True)
    cc, nc = [], []
    for cs in land:
        ci = h3.str_to_int(cs)
        for nb in h3.grid_disk(cs, DISK_K):
            if nb in landset:
                cc.append(ci)
                nc.append(h3.str_to_int(nb))
    con.register("pairs_df", pd.DataFrame({"cell": cc, "ncell": nc}))
    con.execute(f"CREATE TEMP TABLE cells AS SELECT * FROM read_parquet('{_pp(CELLS_PQ)}')")
    con.execute(f"""
        COPY (
          SELECT CAST(p.cell AS BIGINT) AS cell, CAST(p.ncell AS BIGINT) AS ncell,
                 sqrt((c.x-n.x)*(c.x-n.x)+(c.y-n.y)*(c.y-n.y)) AS dist_ft
          FROM pairs_df p
          JOIN cells c ON c.cell=CAST(p.cell AS BIGINT)
          JOIN cells n ON n.cell=CAST(p.ncell AS BIGINT)
          WHERE sqrt((c.x-n.x)*(c.x-n.x)+(c.y-n.y)*(c.y-n.y)) <= {NBR_RADIUS_FT}
        ) TO '{_pp(NBR_PQ)}' (FORMAT PARQUET)""")
    avg = con.execute(f"SELECT avg(c) FROM (SELECT count(*) c FROM read_parquet('{_pp(NBR_PQ)}') GROUP BY cell)").fetchone()[0]
    print(f"[cells]   {avg:.1f} neighbours/cell within 400 m -> {NBR_PQ.name}", flush=True)
    con.close()
    print(f"[cells] done in {time.time()-t0:.1f}s", flush=True)


# ===========================================================================
# STAGE base — populated flag + transit supply + nearest subway + jobs
# ===========================================================================
def build_base() -> None:
    con = _con()
    t0 = time.time()
    con.execute(f"CREATE TEMP TABLE cells AS SELECT * FROM read_parquet('{_pp(CELLS_PQ)}')")
    con.execute(f"CREATE TEMP TABLE nbr AS SELECT * FROM read_parquet('{_pp(NBR_PQ)}')")

    print("[base] populated flag (block pop within 300 m) ...", flush=True)
    con.execute(f"""
        CREATE TEMP TABLE blockcell AS
        SELECT h3_latlng_to_cell(lat,lon,10) AS cell, sum(coalesce(pop,0)) AS pop
        FROM read_parquet('{_pp(BLOCKS_TAGGED)}') WHERE lat IS NOT NULL GROUP BY 1;""")
    con.execute(f"""
        CREATE TEMP TABLE pop300 AS
        SELECT n.cell, sum(bc.pop) AS pop_300m
        FROM nbr n JOIN blockcell bc ON bc.cell=n.ncell
        WHERE n.dist_ft <= {POP_RADIUS_FT} GROUP BY n.cell;""")

    print("[base] transit supply (SAI stops within 400 m) ...", flush=True)
    con.execute(f"""
        CREATE TEMP TABLE saibin AS
        SELECT h3_latlng_to_cell(lat,lon,10) AS cell, count(*) n_stops,
               max(sai) best_sai, sum(trips_am) am_trips
        FROM read_parquet('{_pp(SAI)}') WHERE lat IS NOT NULL GROUP BY 1;""")
    con.execute("""
        CREATE TEMP TABLE transit AS
        SELECT n.cell, sum(s.n_stops) transit_stops_400m, max(s.best_sai) best_sai_400m,
               sum(s.am_trips) sched_am_trips_400m
        FROM nbr n JOIN saibin s ON s.cell=n.ncell GROUP BY n.cell;""")

    print("[base] nearest subway station ...", flush=True)
    con.execute("""
        CREATE TEMP TABLE subway AS
        SELECT gtfs_stop_id station_id, stop_name, borough,
               ST_X(geom_2263) x, ST_Y(geom_2263) y
        FROM transit_subway_stations WHERE geom_2263 IS NOT NULL;""")
    con.execute("""
        CREATE TEMP TABLE nearest_subway AS
        SELECT cell, stop_name subway_name, borough subway_borough, dist_ft subway_dist_ft
        FROM (
          SELECT c.cell, s.stop_name, s.borough,
                 sqrt((c.x-s.x)*(c.x-s.x)+(c.y-s.y)*(c.y-s.y)) dist_ft,
                 row_number() OVER (PARTITION BY c.cell
                     ORDER BY (c.x-s.x)*(c.x-s.x)+(c.y-s.y)*(c.y-s.y)) rn
          FROM cells c CROSS JOIN subway s) WHERE rn=1;""")

    con.execute(f"""
        CREATE TEMP TABLE jobs AS
        SELECT res8, jobs_reachable, jobs_reachable_pct
        FROM read_parquet('{_pp(ISO_GRID)}') WHERE status='ok';""")

    con.execute(f"""
        COPY (
          SELECT c.cell_str, c.res8,
                 coalesce(p.pop_300m,0) AS pop_300m, (coalesce(p.pop_300m,0)>0) AS populated,
                 coalesce(t.transit_stops_400m,0) AS transit_stops_400m,
                 t.best_sai_400m, coalesce(t.sched_am_trips_400m,0) AS sched_am_trips_400m,
                 ns.subway_name, ns.subway_borough, ns.subway_dist_ft,
                 j.jobs_reachable AS jobs_45min, j.jobs_reachable_pct AS jobs_45min_pct
          FROM cells c
          LEFT JOIN pop300 p ON p.cell=c.cell
          LEFT JOIN transit t ON t.cell=c.cell
          LEFT JOIN nearest_subway ns ON ns.cell=c.cell
          LEFT JOIN jobs j ON j.res8=c.res8
        ) TO '{_pp(BASE_PQ)}' (FORMAT PARQUET)""")
    n = con.execute(f"SELECT count(*), sum(populated::int) FROM read_parquet('{_pp(BASE_PQ)}')").fetchone()
    print(f"[base]   {n[0]:,} cells, {int(n[1]):,} populated -> {BASE_PQ.name}", flush=True)
    con.close()
    print(f"[base] done in {time.time()-t0:.1f}s", flush=True)


# ===========================================================================
# STAGE qol — quality-of-life densities within 400 m
# ===========================================================================
def build_qol() -> None:
    con = _con()
    t0 = time.time()
    con.execute(f"CREATE TEMP TABLE cells AS SELECT * FROM read_parquet('{_pp(CELLS_PQ)}')")
    con.execute(f"CREATE TEMP TABLE nbr AS SELECT * FROM read_parquet('{_pp(NBR_PQ)}')")

    def bin_layer(name: str, sql: str) -> None:
        print(f"[qol] binning {name} ...", flush=True)
        con.execute(f"CREATE TEMP TABLE {name} AS {sql}")

    bin_layer("noise_bin", """
        SELECT h3_latlng_to_cell(TRY_CAST(latitude AS DOUBLE),TRY_CAST(longitude AS DOUBLE),10) cell, count(*) n
        FROM qol_sr311 WHERE complaint_type LIKE 'Noise%'
          AND TRY_CAST(latitude AS DOUBLE) IS NOT NULL AND TRY_CAST(longitude AS DOUBLE) IS NOT NULL GROUP BY 1""")
    bin_layer("sidewalk311_bin", """
        SELECT h3_latlng_to_cell(TRY_CAST(latitude AS DOUBLE),TRY_CAST(longitude AS DOUBLE),10) cell, count(*) n
        FROM qol_sr311 WHERE complaint_type IN ('Sidewalk Condition','DEP Sidewalk Condition',
             'Curb Condition','Root/Sewer/Sidewalk Condition')
          AND TRY_CAST(latitude AS DOUBLE) IS NOT NULL AND TRY_CAST(longitude AS DOUBLE) IS NOT NULL GROUP BY 1""")
    bin_layer("rodent_bin", """
        SELECT h3_latlng_to_cell(TRY_CAST(latitude AS DOUBLE),TRY_CAST(longitude AS DOUBLE),10) cell,
               count(*) insp, sum(CASE WHEN result LIKE 'Failed%' THEN 1 ELSE 0 END) fails
        FROM qol_rodent WHERE TRY_CAST(latitude AS DOUBLE) IS NOT NULL AND TRY_CAST(longitude AS DOUBLE) IS NOT NULL GROUP BY 1""")
    bin_layer("crash_bin", """
        SELECT h3_latlng_to_cell(TRY_CAST(latitude AS DOUBLE),TRY_CAST(longitude AS DOUBLE),10) cell, count(*) n
        FROM qol_crashes WHERE TRY_CAST(latitude AS DOUBLE) IS NOT NULL AND TRY_CAST(longitude AS DOUBLE) IS NOT NULL
          AND (TRY_CAST(number_of_pedestrians_injured AS INT)>0 OR TRY_CAST(number_of_pedestrians_killed AS INT)>0) GROUP BY 1""")
    bin_layer("tree_bin", """
        SELECT h3_latlng_to_cell(latitude,longitude,10) cell, count(*) n
        FROM qol_trees WHERE status='Alive' AND latitude IS NOT NULL GROUP BY 1""")
    bin_layer("sidewalk_cov_bin", f"""
        WITH seg AS (
          SELECT cov.coverage_class, cov.seg_len_ft,
                 ST_Transform(ST_Centroid(cs.geom_2263),'EPSG:2263','EPSG:4326',always_xy:=true) g
          FROM read_parquet('{_pp(COVERAGE)}') cov
          JOIN geo_cscl cs ON cs.PHYSICALID=cov.PHYSICALID WHERE cs.geom_2263 IS NOT NULL)
        SELECT h3_latlng_to_cell(ST_Y(g),ST_X(g),10) cell, sum(seg_len_ft) len_total,
               sum(CASE WHEN coverage_class='both_sides' THEN seg_len_ft ELSE 0 END) len_full,
               sum(CASE WHEN coverage_class='none' THEN seg_len_ft ELSE 0 END) len_none
        FROM seg GROUP BY 1""")

    print("[qol] rolling layers over 400 m neighbourhoods ...", flush=True)
    con.execute("CREATE TEMP TABLE r_noise AS SELECT n.cell, sum(b.n) v FROM nbr n JOIN noise_bin b ON b.cell=n.ncell GROUP BY n.cell")
    con.execute("CREATE TEMP TABLE r_sw311 AS SELECT n.cell, sum(b.n) v FROM nbr n JOIN sidewalk311_bin b ON b.cell=n.ncell GROUP BY n.cell")
    con.execute("CREATE TEMP TABLE r_rodent AS SELECT n.cell, sum(b.insp) insp, sum(b.fails) fails FROM nbr n JOIN rodent_bin b ON b.cell=n.ncell GROUP BY n.cell")
    con.execute("CREATE TEMP TABLE r_crash AS SELECT n.cell, sum(b.n) v FROM nbr n JOIN crash_bin b ON b.cell=n.ncell GROUP BY n.cell")
    con.execute("CREATE TEMP TABLE r_tree AS SELECT n.cell, sum(b.n) v FROM nbr n JOIN tree_bin b ON b.cell=n.ncell GROUP BY n.cell")
    con.execute("CREATE TEMP TABLE r_swcov AS SELECT n.cell, sum(b.len_total) lt, sum(b.len_full) lf, sum(b.len_none) ln FROM nbr n JOIN sidewalk_cov_bin b ON b.cell=n.ncell GROUP BY n.cell")
    con.execute(f"""
        COPY (
          SELECT c.cell_str,
                 rn.v AS noise_400m, rs.v AS sidewalk311_400m,
                 rr.insp AS rodent_insp_400m, rr.fails AS rodent_fail_400m,
                 rc.v AS ped_crash_400m, rt.v AS trees_400m,
                 rw.lt AS sw_len_total, rw.lf AS sw_len_full, rw.ln AS sw_len_none
          FROM cells c
          LEFT JOIN r_noise rn ON rn.cell=c.cell
          LEFT JOIN r_sw311 rs ON rs.cell=c.cell
          LEFT JOIN r_rodent rr ON rr.cell=c.cell
          LEFT JOIN r_crash rc ON rc.cell=c.cell
          LEFT JOIN r_tree rt ON rt.cell=c.cell
          LEFT JOIN r_swcov rw ON rw.cell=c.cell
        ) TO '{_pp(QOL_PQ)}' (FORMAT PARQUET)""")
    print(f"[qol] wrote {QOL_PQ.name}", flush=True)
    con.close()
    print(f"[qol] done in {time.time()-t0:.1f}s", flush=True)


# ===========================================================================
# STAGE flood — stormwater + FEMA SFHA point-in-polygon (dumped parts)
# ===========================================================================
def build_flood() -> None:
    con = _con()
    t0 = time.time()
    con.execute(f"""
        CREATE TEMP TABLE cellpt AS
        SELECT cell_str, ST_Transform(ST_Point(lon,lat),'EPSG:4326','EPSG:2263',always_xy:=true) g
        FROM read_parquet('{_pp(CELLS_PQ)}')""")
    print("[flood] dumping flood polygons into parts ...", flush=True)
    con.execute("""CREATE TEMP TABLE sw AS
        SELECT scenario, UNNEST(ST_Dump(geom_2263)).geom AS g FROM geo_flood_stormwater""")
    con.execute("""CREATE TEMP TABLE firm AS
        SELECT FLD_ZONE, UNNEST(ST_Dump(geom_2263)).geom AS g FROM geo_flood_firm WHERE SFHA_TF='T'""")
    ns, nf = con.execute("SELECT (SELECT count(*) FROM sw),(SELECT count(*) FROM firm)").fetchone()
    print(f"[flood]   {ns:,} stormwater parts, {nf:,} FEMA-SFHA parts", flush=True)

    print("[flood] point-in-polygon join ...", flush=True)
    con.execute("""CREATE TEMP TABLE flood_sw AS
        SELECT p.cell_str, bool_or(s.scenario='moderate_current') flood_sw_moderate,
               bool_or(s.scenario='extreme_2080') flood_sw_extreme
        FROM cellpt p JOIN sw s ON ST_Intersects(s.g,p.g) GROUP BY p.cell_str""")
    con.execute("""CREATE TEMP TABLE flood_firm AS
        SELECT p.cell_str, any_value(f.FLD_ZONE) firm_zone, TRUE flood_firm_sfha
        FROM cellpt p JOIN firm f ON ST_Intersects(f.g,p.g) GROUP BY p.cell_str""")
    con.execute(f"""
        COPY (
          SELECT c.cell_str,
                 coalesce(fs.flood_sw_moderate,FALSE) AS flood_sw_moderate,
                 coalesce(fs.flood_sw_extreme,FALSE)  AS flood_sw_extreme,
                 ff.firm_zone,
                 coalesce(ff.flood_firm_sfha,FALSE)   AS flood_firm_sfha
          FROM read_parquet('{_pp(CELLS_PQ)}') c
          LEFT JOIN flood_sw fs ON fs.cell_str=c.cell_str
          LEFT JOIN flood_firm ff ON ff.cell_str=c.cell_str
        ) TO '{_pp(FLOOD_PQ)}' (FORMAT PARQUET)""")
    n = con.execute(f"""SELECT count(*), sum(flood_sw_moderate::int), sum(flood_sw_extreme::int),
                        sum(flood_firm_sfha::int) FROM read_parquet('{_pp(FLOOD_PQ)}')""").fetchone()
    print(f"[flood]   {n[0]:,} cells; moderate={int(n[1]):,} extreme={int(n[2]):,} SFHA={int(n[3]):,}", flush=True)
    con.close()
    print(f"[flood] done in {time.time()-t0:.1f}s", flush=True)


# ===========================================================================
# STAGE assemble — join stages + citywide percentiles
# ===========================================================================
def build_assemble() -> None:
    con = _con()
    t0 = time.time()
    print("[assemble] joining stages + rates ...", flush=True)
    con.execute(f"""
        CREATE TEMP TABLE grid_raw AS
        SELECT c.cell_str AS h3_10, b.res8, c.lat, c.lon,
               b.pop_300m, b.populated,
               b.transit_stops_400m, b.best_sai_400m, b.sched_am_trips_400m,
               b.subway_name, b.subway_borough, b.subway_dist_ft,
               coalesce(q.noise_400m,0) AS noise_400m,
               coalesce(q.sidewalk311_400m,0) AS sidewalk311_400m,
               coalesce(q.rodent_insp_400m,0) AS rodent_insp_400m,
               coalesce(q.rodent_fail_400m,0) AS rodent_fail_400m,
               CASE WHEN coalesce(q.rodent_insp_400m,0)>0
                    THEN q.rodent_fail_400m::DOUBLE/q.rodent_insp_400m END AS rodent_fail_rate,
               coalesce(q.ped_crash_400m,0) AS ped_crash_400m,
               coalesce(q.trees_400m,0) AS trees_400m,
               q.sw_len_total, q.sw_len_full, q.sw_len_none,
               CASE WHEN coalesce(q.sw_len_total,0)>0 THEN q.sw_len_full::DOUBLE/q.sw_len_total END AS sidewalk_full_share,
               CASE WHEN coalesce(q.sw_len_total,0)>0 THEN q.sw_len_none::DOUBLE/q.sw_len_total END AS sidewalk_none_share,
               f.flood_sw_moderate, f.flood_sw_extreme, f.firm_zone, f.flood_firm_sfha,
               b.jobs_45min, b.jobs_45min_pct
        FROM read_parquet('{_pp(CELLS_PQ)}') c
        JOIN read_parquet('{_pp(BASE_PQ)}') b ON b.cell_str=c.cell_str
        LEFT JOIN read_parquet('{_pp(QOL_PQ)}') q ON q.cell_str=c.cell_str
        LEFT JOIN read_parquet('{_pp(FLOOD_PQ)}') f ON f.cell_str=c.cell_str;""")

    print("[assemble] citywide percentiles over populated cells ...", flush=True)
    con.execute(f"""
        COPY (
          WITH pop AS (SELECT * FROM grid_raw WHERE populated),
          rk AS (
            SELECT h3_10,
                   100.0*cume_dist() OVER (ORDER BY noise_400m) noise_pctile,
                   100.0*cume_dist() OVER (ORDER BY sidewalk311_400m) sidewalk311_pctile,
                   100.0*cume_dist() OVER (ORDER BY ped_crash_400m) ped_crash_pctile,
                   100.0*cume_dist() OVER (ORDER BY trees_400m) trees_pctile,
                   100.0*cume_dist() OVER (ORDER BY best_sai_400m) transit_sai_pctile,
                   100.0*cume_dist() OVER (ORDER BY sched_am_trips_400m) transit_supply_pctile,
                   100.0*cume_dist() OVER (ORDER BY jobs_45min) jobs_pctile
            FROM pop ),
          rk_rate AS (
            SELECT h3_10, 100.0*cume_dist() OVER (ORDER BY rodent_fail_rate) rodent_fail_pctile
            FROM pop WHERE rodent_fail_rate IS NOT NULL ),
          rk_sw AS (
            SELECT h3_10, 100.0*cume_dist() OVER (ORDER BY sidewalk_full_share) sidewalk_cov_pctile
            FROM pop WHERE sidewalk_full_share IS NOT NULL )
          SELECT g.*, rk.noise_pctile, rk.sidewalk311_pctile, rk.ped_crash_pctile, rk.trees_pctile,
                 rk.transit_sai_pctile, rk.transit_supply_pctile, rk.jobs_pctile,
                 rr.rodent_fail_pctile, rs.sidewalk_cov_pctile
          FROM grid_raw g
          LEFT JOIN rk ON rk.h3_10=g.h3_10
          LEFT JOIN rk_rate rr ON rr.h3_10=g.h3_10
          LEFT JOIN rk_sw rs ON rs.h3_10=g.h3_10
        ) TO '{_pp(GRID_OUT)}' (FORMAT PARQUET)""")
    n = con.execute(f"""SELECT count(*), sum(populated::int), count(subway_name), avg(subway_dist_ft)
                        FROM read_parquet('{_pp(GRID_OUT)}')""").fetchone()
    print(f"[assemble]   wrote {GRID_OUT.name}: {n[0]:,} cells, {int(n[1]):,} populated, "
          f"mean nearest-subway {n[3]:.0f} ft", flush=True)
    con.close()
    print(f"[assemble] done in {time.time()-t0:.1f}s", flush=True)


STAGES = {
    "bbl": build_bbl, "cells": build_cells, "base": build_base,
    "qol": build_qol, "flood": build_flood, "assemble": build_assemble,
}
GRID_ORDER = ["cells", "base", "qol", "flood", "assemble"]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=list(STAGES) + ["grid", "all"])
    args = ap.parse_args()
    if args.stage == "all":
        build_bbl()
        for s in GRID_ORDER:
            STAGES[s]()
    elif args.stage == "grid":
        for s in GRID_ORDER:
            STAGES[s]()
    else:
        STAGES[args.stage]()
    print("[renters] stage complete.", flush=True)
