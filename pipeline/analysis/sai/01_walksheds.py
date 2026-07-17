"""01 - Per bus stop 400 m (1312 ft) walkshed: population served + jobs within.

HONEST BASELINE: the walkshed is a Euclidean (straight-line) 400 m buffer, NOT a network
(street-following) walkshed. Real pedestrian access follows the street grid, so a network
walkshed would typically shrink the catchment ~20-30% and the served population/jobs with it.
We document this and treat the Euclidean figure as an upper-bound catchment.

Population within  = area-weighted apportionment of 2020-Census block population:
    pop_400m(stop) = SUM_over_blocks[ block_pop * area(buffer INTERSECT block) / area(block) ]
Jobs within        = same apportionment applied to LODES8 2023 WAC total jobs (C000) per work block.

Output: sai_stop_base.parquet/.xlsx  (canonical per-stop table consumed by 02/03/04).
"""
from __future__ import annotations
import time
import duckdb
import common as C

t0 = time.time()
con = C.connect()
R = C.WALKSHED_FT
print(f"walkshed radius = {R:.1f} ftUS (400 m); building stop base...")

# ---- 1. Canonical unique-stop base (13,621 in-effect physical stops) --------------------
con.execute(f"""
CREATE TEMP TABLE stops AS
SELECT
  stop_id,
  any_value(stop_name)                                   AS stop_name,
  count(DISTINCT route_id)                               AS n_routes,
  string_agg(DISTINCT route_short_name, ', ')            AS routes,
  bool_or(route_short_name ILIKE '%SBS%')                AS sbs_flag,
  bool_or(is_cbd)                                         AS in_cbd,
  any_value(ST_X(geom_2263))                             AS x_ft,
  any_value(ST_Y(geom_2263))                             AS y_ft,
  any_value(TRY_CAST(latitude AS DOUBLE))                AS lat,
  any_value(TRY_CAST(longitude AS DOUBLE))               AS lon,
  any_value(geom_2263)                                   AS pt
FROM transit_bus_stops
GROUP BY stop_id
""")
n = con.execute("SELECT count(*) FROM stops").fetchone()[0]
print(f"  stops: {n:,}")

# ---- 2. Borough via block-point containment (physical location, not route prefix) -------
con.execute("""
CREATE TEMP TABLE stop_boro AS
SELECT s.stop_id, any_value(b.boroname) AS borough
FROM stops s JOIN pop_census_blocks b
  ON ST_Intersects(b.geom_2263, s.pt)
GROUP BY s.stop_id
""")

# ---- 3. Blocks with population + jobs and precomputed area/envelope ----------------------
con.execute(f"""
CREATE TEMP TABLE blocks AS
SELECT b.geoid,
       b.geom_2263 AS g,
       ST_Area(b.geom_2263) AS blk_area,
       ST_XMin(b.geom_2263) AS xmin, ST_XMax(b.geom_2263) AS xmax,
       ST_YMin(b.geom_2263) AS ymin, ST_YMax(b.geom_2263) AS ymax,
       COALESCE(p.total_pop, 0) AS pop,
       COALESCE(TRY_CAST(w.C000 AS DOUBLE), 0) AS jobs
FROM pop_census_blocks b
LEFT JOIN pop_block_pop p ON p.GEOID15 = b.geoid
LEFT JOIN pop_lodes_wac  w ON w.w_geocode = b.geoid
WHERE ST_Area(b.geom_2263) > 0
""")

# ---- 4. Buffers + bbox pre-filtered apportionment join ----------------------------------
# bbox overlap makes the spatial join a range join (fast), then ST_Intersection refines.
con.execute(f"""
CREATE TEMP TABLE walkshed AS
WITH sb AS (
  SELECT stop_id, pt,
         ST_Buffer(pt, {R}) AS buf,
         x_ft-{R} AS bx0, x_ft+{R} AS bx1, y_ft-{R} AS by0, y_ft+{R} AS by1
  FROM stops
),
pairs AS (
  SELECT sb.stop_id,
         bl.pop, bl.jobs, bl.blk_area,
         ST_Area(ST_Intersection(sb.buf, bl.g)) AS inter_area
  FROM sb JOIN blocks bl
    ON bl.xmin <= sb.bx1 AND bl.xmax >= sb.bx0
   AND bl.ymin <= sb.by1 AND bl.ymax >= sb.by0
   AND ST_Intersects(sb.buf, bl.g)
)
SELECT stop_id,
       SUM(pop  * inter_area / blk_area) AS pop_400m,
       SUM(jobs * inter_area / blk_area) AS jobs_400m
FROM pairs
GROUP BY stop_id
""")
print(f"  apportionment done ({time.time()-t0:.0f}s)")

df = con.execute(f"""
SELECT s.stop_id, s.stop_name, COALESCE(sb.borough,'Unknown') AS borough,
       s.n_routes, s.routes, s.sbs_flag, s.in_cbd,
       s.x_ft, s.y_ft, s.lat, s.lon,
       COALESCE(w.pop_400m, 0.0)  AS pop_400m,
       COALESCE(w.jobs_400m, 0.0) AS jobs_400m
FROM stops s
LEFT JOIN stop_boro sb ON sb.stop_id = s.stop_id
LEFT JOIN walkshed  w  ON w.stop_id  = s.stop_id
ORDER BY s.stop_id
""").fetchdf()

C.write_table(df, "sai_stop_base", "stop_base")
print(f"  pop_400m: mean {df.pop_400m.mean():,.0f}  median {df.pop_400m.median():,.0f}  max {df.pop_400m.max():,.0f}")
print(f"  jobs_400m: mean {df.jobs_400m.mean():,.0f}  median {df.jobs_400m.median():,.0f}  max {df.jobs_400m.max():,.0f}")
print(f"done in {time.time()-t0:.0f}s")
