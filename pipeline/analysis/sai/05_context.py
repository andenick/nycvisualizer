"""05 - B5.3 municipal-context set (supports the SAI narrative + site context pages).

(a) Population-density gradient   - per 2020-Census block: residents / land-area, borough, centroid
    (lon/lat) for a graduated map; plus an NTA-level rollup for a smoother gradient.
(b) Subway O-D top flows          - transit_od_matrix (jsu2-fbtj, 2024): top origin->destination
    station-complex pairs by estimated average ridership, overall and for the 8 a.m. peak hour.
(c) Crash exposure on high-PMI    - DOT Pedestrian Mobility demand (ped_mobility_demand, Rank 1=highest
    segments                        demand .. 5=lowest) vs pedestrian-injury MVC crashes (2020+): ped
    crashes within 100 ft of each segment; exposure gradient by demand rank + the 50 worst segments.

All distance math EPSG:2263 ftUS. Land area from ST_Area(geom_2263) (sq ft -> sq mi).
"""
from __future__ import annotations
import time
import common as C

t0 = time.time()
con = C.connect()
SQFT_PER_SQMI = 27_878_400.0

# ---- (a) population density gradient ------------------------------------------------------
blk = con.execute("""
SELECT b.geoid, b.boroname AS borough,
       COALESCE(p.total_pop, 0) AS pop,
       ST_Area(b.geom_2263) / 27878400.0 AS land_sqmi,
       ST_Y(ST_Centroid(b.geom_2263)) AS y_ft, ST_X(ST_Centroid(b.geom_2263)) AS x_ft,
       ST_Y(ST_Transform(ST_Centroid(b.geom_2263), 'EPSG:2263','EPSG:4326', always_xy:=true)) AS lat,
       ST_X(ST_Transform(ST_Centroid(b.geom_2263), 'EPSG:2263','EPSG:4326', always_xy:=true)) AS lon
FROM pop_census_blocks b
LEFT JOIN pop_block_pop p ON p.GEOID15 = b.geoid
WHERE ST_Area(b.geom_2263) > 0
""").fetchdf()
blk["pop_density_sqmi"] = (blk["pop"] / blk["land_sqmi"]).round(0)
C.write_table(blk[["geoid", "borough", "pop", "land_sqmi", "pop_density_sqmi", "lat", "lon"]]
              .sort_values("pop_density_sqmi", ascending=False),
              "ctx_block_pop_density", "block_density")

bden = (blk.groupby("borough")
        .apply(lambda g: (g["pop"].sum() / g["land_sqmi"].sum()), include_groups=False)
        .round(0).reset_index(name="pop_density_sqmi")
        .sort_values("pop_density_sqmi", ascending=False))
C.write_table(bden, "ctx_borough_pop_density", "boro_density")
print(f"  (a) density: {len(blk):,} blocks ({time.time()-t0:.0f}s)")

# ---- (b) subway O-D top flows ------------------------------------------------------------
od_all = con.execute("""
SELECT origin_station_complex_name AS origin, destination_station_complex_name AS destination,
       ROUND(SUM(estimated_average_ridership), 1) AS est_avg_riders
FROM transit_od_matrix
WHERE origin_station_complex_id <> destination_station_complex_id
GROUP BY 1,2 ORDER BY est_avg_riders DESC LIMIT 100
""").fetchdf()
C.write_table(od_all, "ctx_subway_od_top100", "od_top100")

od_am = con.execute("""
SELECT origin_station_complex_name AS origin, destination_station_complex_name AS destination,
       ROUND(SUM(estimated_average_ridership), 1) AS est_avg_riders
FROM transit_od_matrix
WHERE hour_of_day = 8 AND origin_station_complex_id <> destination_station_complex_id
GROUP BY 1,2 ORDER BY est_avg_riders DESC LIMIT 100
""").fetchdf()
C.write_table(od_am, "ctx_subway_od_top100_8am", "od_8am")
print(f"  (b) O-D flows aggregated ({time.time()-t0:.0f}s)")

# ---- (c) crash exposure on high-PMI segments ---------------------------------------------
con.execute("""
CREATE TEMP TABLE pedcrash AS
SELECT geom_2263 AS g, ST_X(geom_2263) x, ST_Y(geom_2263) y
FROM qol_crashes
WHERE geom_2263 IS NOT NULL
  AND (TRY_CAST(number_of_pedestrians_injured AS INT) > 0
       OR TRY_CAST(number_of_pedestrians_killed AS INT) > 0)
  AND strptime(crash_date, '%m/%d/%Y') >= DATE '2020-01-01'
""")
con.execute("""
CREATE TEMP TABLE pmi AS
SELECT segmentid, street, TRY_CAST(Rank AS INT) AS demand_rank, NTAName, Boro,
       geom_2263 AS g,
       ST_XMin(geom_2263) xmin, ST_XMax(geom_2263) xmax,
       ST_YMin(geom_2263) ymin, ST_YMax(geom_2263) ymax
FROM ped_mobility_demand WHERE geom_2263 IS NOT NULL AND TRY_CAST(Rank AS INT) IS NOT NULL
""")
seg = con.execute("""
WITH j AS (
  SELECT p.segmentid, p.street, p.demand_rank, p.NTAName, p.Boro,
         count(c.g) AS ped_crashes_100ft
  FROM pmi p LEFT JOIN pedcrash c
    ON c.x BETWEEN p.xmin-100 AND p.xmax+100 AND c.y BETWEEN p.ymin-100 AND p.ymax+100
   AND ST_DWithin(c.g, p.g, 100.0)
  GROUP BY 1,2,3,4,5
)
SELECT * FROM j
""").fetchdf()
# gradient by demand rank
grad = (seg.groupby("demand_rank")
        .agg(n_segments=("segmentid", "count"), total_ped_crashes=("ped_crashes_100ft", "sum"),
             mean_ped_crashes_per_seg=("ped_crashes_100ft", "mean"))
        .round(3).reset_index().sort_values("demand_rank"))
C.write_table(grad, "ctx_pmi_crash_gradient", "pmi_crash_grad")
C.write_table(seg.sort_values("ped_crashes_100ft", ascending=False).head(50),
              "ctx_pmi_worst50_segments", "pmi_worst50")
print(f"  (c) PMI x crash: {len(seg):,} segments ({time.time()-t0:.0f}s)")
print("  crash exposure gradient (rank 1=highest demand):")
print(grad.to_string(index=False))
print(f"done in {time.time()-t0:.0f}s")
