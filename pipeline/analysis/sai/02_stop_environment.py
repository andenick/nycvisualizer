"""02 - Per-stop pedestrian environment around each bus stop.

Measures (all distances in ftUS, EPSG:2263 Euclidean):
  sidewalk_sqft_100ft  - planimetric sidewalk polygon area within 100 ft of the stop (immediate).
  sidewalk_sqft_400m   - planimetric sidewalk polygon area within the 400 m walkshed (provision).
  ramps_150ft          - pedestrian ramps within 150 ft (ADA access at nearby corners).
  shelter_100ft        - bus-stop shelters within 100 ft (>=1 => sheltered stop).
  seats_250ft          - City benches + Seating-Locations assets within 250 ft (comfort).
  complaints_400m      - 311 sidewalk/curb-condition service requests (2020+) within 400 m (condition, inverse).
  ped_crashes_400m     - MVC crashes injuring/killing a pedestrian (2020+) within 400 m (safety, inverse).

Point-layer radius counts use scipy cKDTree (exact Euclidean, fast). Polygon area uses DuckDB
spatial intersection with a bbox pre-filter. DOT sidewalk violations (6kbp-uz6m) are intentionally
NOT included here: that table has no geometry and no usable BBL, so it cannot be attributed at
stop granularity (see METHODS + 05_context borough/CB violation table). 311 carries the condition signal.
"""
from __future__ import annotations
import time
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
import common as C

t0 = time.time()
con = C.connect()
R = C.WALKSHED_FT

stops = con.execute(
    "SELECT stop_id, x_ft, y_ft FROM read_parquet(?) ORDER BY stop_id",
    [C.OUT + "/sai_stop_base.parquet"],
).fetchdf()
S = stops[["x_ft", "y_ft"]].to_numpy(float)
print(f"stops: {len(stops):,}")


def radius_count(sql: str, radius: float, label: str) -> np.ndarray:
    """Count layer points within `radius` ft of each stop via KDTree."""
    pts = con.execute(sql).fetchdf().to_numpy(float)
    pts = pts[np.isfinite(pts).all(axis=1)]
    tree = cKDTree(pts)
    cnt = tree.query_ball_point(S, r=radius, return_length=True)
    print(f"  {label}: {len(pts):,} pts -> mean {cnt.mean():.2f}/stop ({time.time()-t0:.0f}s)")
    return cnt.astype(int)


ramps = radius_count(
    "SELECT ST_X(geom_2263), ST_Y(geom_2263) FROM geo_ramps WHERE geom_2263 IS NOT NULL",
    150.0, "ramps_150ft")
shelters = radius_count(
    "SELECT ST_X(geom_2263), ST_Y(geom_2263) FROM geo_shelters WHERE geom_2263 IS NOT NULL",
    100.0, "shelter_100ft")
seats = radius_count(
    """SELECT ST_X(geom_2263), ST_Y(geom_2263) FROM geo_benches WHERE geom_2263 IS NOT NULL
       UNION ALL
       SELECT ST_X(geom_2263), ST_Y(geom_2263) FROM geo_seating WHERE geom_2263 IS NOT NULL""",
    250.0, "seats_250ft")
complaints = radius_count(
    """SELECT TRY_CAST(x_coordinate_state_plane AS DOUBLE), TRY_CAST(y_coordinate_state_plane AS DOUBLE)
       FROM qol_sr311_sidewalk
       WHERE x_coordinate_state_plane IS NOT NULL AND year >= 2020""",
    R, "complaints_400m")
pedcrash = radius_count(
    """SELECT ST_X(geom_2263), ST_Y(geom_2263) FROM qol_crashes
       WHERE geom_2263 IS NOT NULL
         AND (TRY_CAST(number_of_pedestrians_injured AS INT) > 0
              OR TRY_CAST(number_of_pedestrians_killed AS INT) > 0)
         AND strptime(crash_date, '%m/%d/%Y') >= DATE '2020-01-01'""",
    R, "ped_crashes_400m")

# ---- Sidewalk polygon area (DuckDB spatial intersection, bbox pre-filtered) --------------
con.execute("""
CREATE TEMP TABLE sb AS
SELECT stop_id, ST_Point(x_ft, y_ft) AS pt, x_ft, y_ft
FROM read_parquet('""" + C.OUT + """/sai_stop_base.parquet')
""")
con.execute("""
CREATE TEMP TABLE sw AS
SELECT geom_2263 AS g,
       ST_XMin(geom_2263) xmin, ST_XMax(geom_2263) xmax,
       ST_YMin(geom_2263) ymin, ST_YMax(geom_2263) ymax
FROM geo_sidewalk_polys WHERE geom_2263 IS NOT NULL
""")


def sidewalk_area(radius: float, colname: str) -> pd.DataFrame:
    q = f"""
    WITH s AS (
      SELECT stop_id, ST_Buffer(pt, {radius}) AS buf,
             x_ft-{radius} bx0, x_ft+{radius} bx1, y_ft-{radius} by0, y_ft+{radius} by1
      FROM sb
    )
    SELECT s.stop_id, SUM(ST_Area(ST_Intersection(s.buf, sw.g))) AS {colname}
    FROM s JOIN sw
      ON sw.xmin<=s.bx1 AND sw.xmax>=s.bx0 AND sw.ymin<=s.by1 AND sw.ymax>=s.by0
     AND ST_Intersects(s.buf, sw.g)
    GROUP BY s.stop_id
    """
    d = con.execute(q).fetchdf()
    print(f"  {colname}: computed for {len(d):,} stops ({time.time()-t0:.0f}s)")
    return d


sw100 = sidewalk_area(100.0, "sidewalk_sqft_100ft")
sw400 = sidewalk_area(R, "sidewalk_sqft_400m")

env = stops[["stop_id"]].copy()
env["sidewalk_sqft_100ft"] = 0.0
env["sidewalk_sqft_400m"] = 0.0
env = env.merge(sw100, on="stop_id", how="left", suffixes=("", "_y"))
env = env.merge(sw400, on="stop_id", how="left", suffixes=("", "_y"))
env["sidewalk_sqft_100ft"] = env["sidewalk_sqft_100ft_y"].fillna(0.0)
env["sidewalk_sqft_400m"] = env["sidewalk_sqft_400m_y"].fillna(0.0)
env = env[["stop_id", "sidewalk_sqft_100ft", "sidewalk_sqft_400m"]]
env["ramps_150ft"] = ramps
env["shelter_100ft"] = shelters
env["seats_250ft"] = seats
env["complaints_400m"] = complaints
env["ped_crashes_400m"] = pedcrash

C.write_table(env, "sai_stop_environment", "environment")
print(f"  sheltered stops (>=1 shelter within 100ft): {(env.shelter_100ft>0).sum():,} "
      f"({(env.shelter_100ft>0).mean()*100:.1f}%)")
print(f"  stops with a ramp within 150ft: {(env.ramps_150ft>0).sum():,} "
      f"({(env.ramps_150ft>0).mean()*100:.1f}%)")
print(f"  stops with any seating within 250ft: {(env.seats_250ft>0).sum():,} "
      f"({(env.seats_250ft>0).mean()*100:.1f}%)")
print(f"done in {time.time()-t0:.0f}s")
