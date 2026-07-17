"""04 - Compose the Stop Accessibility Index (SAI).

Seven 0-100 subscores (percentile-normalized across all 13,621 stops so each is a citywide rank;
percentile is used because most raw inputs are heavily right-skewed and min-max would be dominated
by a few Midtown/CBD outliers). "inverse" subscores flip direction so higher = better access.

  walkshed_population   raw pop_400m                       (more residents served -> higher)
  sidewalk_provision    raw sidewalk_sqft_400m             (more pedestrian surface -> higher)
  ada_ramp_access       raw ramps_150ft                    (more ramps at nearby corners -> higher)
  comfort               raw shelter_100ft*2 + seats_250ft  (shelter weighted 2x a seat -> higher)
  condition             raw complaints_400m       INVERTED (fewer 311 sidewalk complaints -> higher)
  safety                raw ped_crashes_400m      INVERTED (fewer ped-injury crashes -> higher)
  service_intensity     raw trips_daytime                  (more scheduled weekday service -> higher)

Composite SAI = weighted mean of the seven subscores. Default weights reflect an access-equity
reading (people served + walkability first, comfort a minor factor). A sensitivity SAI with EQUAL
weights (1/7 each) is also emitted; the two are compared in FINDINGS.

Outputs: sai_scores.parquet/.xlsx (per-stop, all subscores + composite + rank),
         league tables (best/worst 50, best/worst 10 per borough) as XLSX+Parquet,
         sai_stops.geojson + sai_stops.geoparquet (site map layer, WGS84),
         distribution + borough charts (in 07_charts via matplotlib here inline).
"""
from __future__ import annotations
import json
import time
import numpy as np
import pandas as pd
import common as C

t0 = time.time()

base = pd.read_parquet(C.OUT + "/sai_stop_base.parquet")
env = pd.read_parquet(C.OUT + "/sai_stop_environment.parquet")
svc = pd.read_parquet(C.OUT + "/sai_stop_service.parquet")

df = base.merge(env, on="stop_id", how="left").merge(svc, on="stop_id", how="left")
for c in ["sidewalk_sqft_100ft", "sidewalk_sqft_400m", "ramps_150ft", "shelter_100ft",
          "seats_250ft", "complaints_400m", "ped_crashes_400m",
          "trips_am", "trips_midday", "trips_eve", "trips_daytime"]:
    df[c] = df[c].fillna(0)

# ---- raw composite inputs ----------------------------------------------------------------
df["comfort_raw"] = df["shelter_100ft"] * 2 + df["seats_250ft"]

SUB = {
    "walkshed_population": ("pop_400m", False),
    "sidewalk_provision": ("sidewalk_sqft_400m", False),
    "ada_ramp_access":    ("ramps_150ft", False),
    "comfort":            ("comfort_raw", False),
    "condition":          ("complaints_400m", True),
    "safety":             ("ped_crashes_400m", True),
    "service_intensity":  ("trips_daytime", False),
}
for name, (col, inv) in SUB.items():
    df[name] = C.pctile_0_100(df[col], invert=inv).round(2)

WEIGHTS = {
    "walkshed_population": 0.25,
    "sidewalk_provision":  0.20,
    "ada_ramp_access":     0.15,
    "comfort":             0.10,
    "condition":           0.10,
    "safety":              0.10,
    "service_intensity":   0.10,
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9

subcols = list(SUB.keys())
W = np.array([WEIGHTS[c] for c in subcols])
M = df[subcols].to_numpy(float)
df["sai"] = (M * W).sum(axis=1).round(2)
df["sai_equal_weight"] = M.mean(axis=1).round(2)  # sensitivity: 1/7 each
df["sai_rank"] = df["sai"].rank(ascending=False, method="min").astype(int)
df["sai_pctile"] = (df["sai"].rank(pct=True) * 100).round(1)

# persist weights for provenance
with open(C.OUT + "/sai_weights.json", "w") as f:
    json.dump({"weights": WEIGHTS, "normalization": "percentile-rank 0-100 across all stops",
               "subscore_inputs": {k: {"column": v[0], "inverted": v[1]} for k, v in SUB.items()},
               "sensitivity": "sai_equal_weight = simple mean of the 7 subscores"}, f, indent=2)

keep = ["stop_id", "stop_name", "borough", "n_routes", "routes", "sbs_flag", "in_cbd",
        "lat", "lon", "pop_400m", "jobs_400m",
        "sidewalk_sqft_400m", "ramps_150ft", "shelter_100ft", "seats_250ft",
        "complaints_400m", "ped_crashes_400m", "trips_am", "trips_midday", "trips_eve",
        "trips_daytime"] + subcols + ["sai", "sai_equal_weight", "sai_rank", "sai_pctile"]
scores = df[keep].sort_values("sai", ascending=False).reset_index(drop=True)
for c in ["pop_400m", "jobs_400m", "sidewalk_sqft_400m"]:
    scores[c] = scores[c].round(0)
C.write_table(scores, "sai_scores", "sai_scores")

# ---- league tables -----------------------------------------------------------------------
lt_cols = ["sai_rank", "stop_id", "stop_name", "borough", "routes", "sbs_flag",
           "sai", "walkshed_population", "sidewalk_provision", "ada_ramp_access",
           "comfort", "condition", "safety", "service_intensity",
           "pop_400m", "shelter_100ft", "ramps_150ft", "ped_crashes_400m"]
C.write_table(scores.head(50)[lt_cols], "sai_best50", "best50")
C.write_table(scores.tail(50)[lt_cols].sort_values("sai"), "sai_worst50", "worst50")

# best/worst 10 per borough
rows = []
for boro, g in scores[scores.borough != "Unknown"].groupby("borough"):
    g = g.sort_values("sai", ascending=False)
    top = g.head(10).copy(); top["rank_in_boro"] = range(1, len(top)+1); top["side"] = "best"
    bot = g.tail(10).copy(); bot = bot.sort_values("sai"); bot["rank_in_boro"] = range(1, len(bot)+1); bot["side"] = "worst"
    rows.append(pd.concat([top, bot]))
boro_lt = pd.concat(rows)[["borough", "side", "rank_in_boro", "stop_id", "stop_name",
                            "routes", "sai"] + subcols]
C.write_table(boro_lt, "sai_borough_best_worst10", "boro_best_worst")

# borough summary
bs = (scores[scores.borough != "Unknown"]
      .groupby("borough")
      .agg(n_stops=("stop_id", "count"), sai_mean=("sai", "mean"), sai_median=("sai", "median"),
           pop_served_median=("pop_400m", "median"),
           pct_sheltered=("shelter_100ft", lambda s: (s > 0).mean()*100),
           pct_ramp=("ramps_150ft", lambda s: (s > 0).mean()*100),
           pct_seating=("seats_250ft", lambda s: (s > 0).mean()*100))
      .round(2).reset_index().sort_values("sai_median", ascending=False))
C.write_table(bs, "sai_borough_summary", "boro_summary")

# ---- GeoJSON + GeoParquet for the site map layer -----------------------------------------
try:
    import geopandas as gpd
    from shapely.geometry import Point
    g = scores.dropna(subset=["lat", "lon"]).copy()
    gdf = gpd.GeoDataFrame(
        g[["stop_id", "stop_name", "borough", "routes", "sbs_flag", "sai", "sai_rank",
           "sai_pctile", "walkshed_population", "sidewalk_provision", "ada_ramp_access",
           "comfort", "condition", "safety", "service_intensity",
           "pop_400m", "shelter_100ft", "ramps_150ft", "ped_crashes_400m", "trips_daytime"]],
        geometry=[Point(xy) for xy in zip(g["lon"], g["lat"])], crs="EPSG:4326")
    gdf.to_file(C.OUT + "/sai_stops.geojson", driver="GeoJSON")
    gdf.to_parquet(C.OUT + "/sai_stops.geoparquet")
    print(f"  wrote sai_stops.geojson + .geoparquet: {len(gdf):,} features (WGS84)")
except Exception as e:
    print(f"  [WARN] geo export failed: {e}")

print(f"  SAI: mean {scores.sai.mean():.1f}  median {scores.sai.median():.1f}  "
      f"min {scores.sai.min():.1f}  max {scores.sai.max():.1f}")
corr = np.corrcoef(scores["sai"], scores["sai_equal_weight"])[0, 1]
print(f"  weighted vs equal-weight SAI correlation: r = {corr:.4f}")
print(f"done in {time.time()-t0:.0f}s")
