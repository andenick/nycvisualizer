"""B5.1(6) — Medial-axis sidewalk width (Meli Harvey method) on OUR planimetric
sidewalk polygons.

This IMPLEMENTS the true medial-axis width method from
github.com/meliharvey/sidewalkwidths-nyc (notebooks/sidewalks.ipynb), replacing
the coarse 2*Area/Perimeter proxy in 02_width_derivation.py (which validated at
only r=0.47 vs a max-inscribed width).

METHOD (per polygon, faithful to Harvey)
-----------------------------------------
Harvey: dissolve polygons -> Voronoi medial-axis centerline (the `centerline`
pip package, which is a scipy Voronoi under the hood) -> prune short dead-ends
-> simplify -> sample the centerline at 1-unit spacing -> width = 2 * distance
from each centerline point to the polygon boundary.

We compute the same quantity without the `centerline` GDAL dependency:
  1. densify the polygon boundary (segmentize) to a dense point set;
  2. scipy.spatial.Voronoi of those points;
  3. keep Voronoi vertices that fall INSIDE the polygon -> these are the medial
     axis; each such vertex's distance to the boundary is the radius of the
     maximal inscribed circle there = the LOCAL HALF-WIDTH (exactly Harvey's
     "distance from centerline to boundary");
  4. the polygon's typical width = 2 * (length-robust) MEDIAN of those
     half-widths. The median (not mean) suppresses the small-clearance spur
     vertices near corners/ends that Harvey removes by pruning — same intent,
     more robust, far faster than the full linemerge/prune/segment pipeline.

CRS / UNITS: geom_2263 is EPSG:2263 (NY State Plane Long Island, US survey FEET),
so all distances are already in FEET — no metre->foot conversion (Harvey worked
in metres and multiplied by 3.28084; we do not).

VALIDATION (two independent references, honest r reported for both)
------------------------------------------------------------------
  A. Harvey's OWN published widths (repo/sidewalkwidths_nyc.geojson, width in ft,
     EPSG:4326): match each of our polygons to the nearest Harvey centerline
     segment and correlate our medial width vs Harvey's width. This is the
     method-vs-method check the plan asks for (promote threshold r>0.75).
  B. The existing 02 proxy: correlate our per-polygon medial width vs the
     2*Area/Perimeter proxy, and (at the CSCL-segment level) vs 02's
     width_median_ft. Documents how much the upgrade moves the numbers.

OUTPUT
------
  Outputs/NYCPlatform/sidewalk/06_medial_axis_polys.parquet    (per polygon)
  Outputs/NYCPlatform/sidewalk/06_medial_axis_segments.parquet (per CSCL PHYSICALID,
        drop-in replacement key for the coverage `w` join in build_layers.py)
  Outputs/NYCPlatform/sidewalk/06_medial_axis_validation.json  (both r values +
        promote recommendation)
  Outputs/NYCPlatform/sidewalk/fig06_medial_vs_harvey.png
  Outputs/NYCPlatform/sidewalk/fig06_medial_vs_proxy.png

Env: MEDIAL_SAMPLE (optional) = cap polygons processed (for a fast dev run).
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.spatial import Voronoi
import shapely
from shapely import wkb as shapely_wkb
from shapely.geometry import Point
from shapely.strtree import STRtree

from _common import connect, opath, OUT

# Validation-only input: Meli Harvey's published width GeoJSON
# (github.com/meliharvey/sidewalkwidths-nyc, repo/sidewalkwidths_nyc.geojson).
# Env-overridable so the public repo carries no absolute workspace path.
HARVEY_GEOJSON = Path(os.environ.get(
    "HARVEY_WIDTHS_GEOJSON",
    "D:/Arcanum/Projects/Jane/Inputs/RefinementAcquisitions_2026_07/"
    "H6_MeliHarvey_sidewalkwidths/repo/sidewalkwidths_nyc.geojson"))

DENSIFY_FT = 3.0        # boundary point spacing before Voronoi
SIMPLIFY_FT = 1.0       # ring simplification tolerance (Harvey simplifies too)
MIN_AREA = 30.0         # skip slivers (< ~30 sqft)
PROMOTE_R = 0.75        # plan's promote threshold vs Harvey


def medial_width_ft(poly) -> float | None:
    """Typical sidewalk width (ft) of one polygon by the medial-axis method."""
    if poly is None or poly.is_empty or poly.area < MIN_AREA:
        return None
    poly = poly.simplify(SIMPLIFY_FT, preserve_topology=True)
    if poly.is_empty:
        return None
    # boundary point cloud (exterior + any holes), densified
    dense = poly.exterior.segmentize(DENSIFY_FT)
    pts = list(dense.coords)
    for ring in poly.interiors:
        pts.extend(ring.segmentize(DENSIFY_FT).coords)
    if len(pts) < 4:
        return None
    coords = np.asarray(pts)
    try:
        vor = Voronoi(coords)
    except Exception:
        return None
    verts = vor.vertices
    if len(verts) == 0:
        return None
    # Vectorized (shapely 2.x): keep Voronoi vertices inside the polygon; each
    # one's distance to the boundary = maximal-inscribed-circle radius = local
    # half-width. Median half-width x2 = typical width (Harvey's measurement).
    vpts = shapely.points(verts)
    inside = shapely.contains(poly, vpts)
    if not inside.any():
        return None
    half = shapely.distance(vpts[inside], poly.boundary)
    return float(2.0 * np.median(half))


def _worker(args):
    """Top-level (picklable) worker: (rid, wkb, wproxy, area) -> row or None."""
    rid, wkbv, wproxy, area = args
    poly = shapely_wkb.loads(bytes(wkbv))
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda g: g.area)
    w = medial_width_ft(poly)
    if w is None or not (0 < w < 200):
        return None
    ctr = poly.centroid                    # EPSG:2263 centroid (feet); no 4326 roundtrip
    return (rid, w, float(wproxy) if wproxy else None, float(area), ctr.x, ctr.y)


def compute_polys(c, cap: int | None):
    lim = f"USING SAMPLE {cap} ROWS (reservoir, 42)" if cap else ""
    rows = c.execute(f"""
        SELECT rowid AS rid,
               ST_AsWKB(geom_2263) AS wkb,
               2*ST_Area(geom_2263)/NULLIF(ST_Perimeter(geom_2263),0) AS wproxy,
               ST_Area(geom_2263) AS area
        FROM geo_sidewalk_polys
        WHERE ST_Area(geom_2263) >= {MIN_AREA}
        {lim}
    """).fetchall()

    t = time.time()
    tasks = [(rid, bytes(wkbv), wproxy, area) for rid, wkbv, wproxy, area in rows]
    workers = min(os.cpu_count() or 4, 12)
    out = []
    if len(tasks) > 500:
        import multiprocessing as mp
        with mp.Pool(workers) as pool:
            for j, res in enumerate(pool.imap_unordered(_worker, tasks, chunksize=200)):
                if res is not None:
                    out.append(res)
                if (j + 1) % 10000 == 0:
                    print(f"    {j+1:,}/{len(tasks):,} polys  ({time.time()-t:.0f}s)")
    else:
        out = [r for r in (_worker(x) for x in tasks) if r is not None]
    print(f"  medial width computed for {len(out):,}/{len(tasks):,} polygons "
          f"({workers} workers, {time.time()-t:.0f}s)")
    return pd.DataFrame(out, columns=["rid", "medial_width_ft", "wproxy_ft", "area_ft2", "cx", "cy"])


def validate_vs_harvey(df: pd.DataFrame) -> dict:
    """Match each polygon centroid to the nearest Harvey centerline segment (all
    in EPSG:2263 feet) and correlate widths."""
    if not HARVEY_GEOJSON.exists():
        return {"available": False, "note": "Harvey geojson not found"}
    import geopandas as gpd
    print("  loading Harvey published widths (101MB)…")
    h = gpd.read_file(HARVEY_GEOJSON)
    h = h[h.geometry.notna() & h["width"].notna()].to_crs("EPSG:2263")
    hgeoms = list(h.geometry.values)
    hwidth = h["width"].to_numpy(dtype=float)
    tree = STRtree(hgeoms)
    ours, theirs, dists = [], [], []
    med = df["medial_width_ft"].to_numpy()
    for i, (cx, cy) in enumerate(zip(df["cx"], df["cy"])):
        pt = Point(cx, cy)               # already EPSG:2263 feet
        idx = int(tree.nearest(pt))
        seg = hgeoms[idx]
        d = pt.distance(seg)
        if d <= 25.0:                    # within ~25 ft -> same sidewalk
            ours.append(med[i])
            theirs.append(hwidth[idx])
            dists.append(d)
    ours = np.array(ours); theirs = np.array(theirs)
    if len(ours) < 30:
        return {"available": True, "n_matched": int(len(ours)), "note": "too few matches"}
    r = float(np.corrcoef(ours, theirs)[0, 1])
    return {
        "available": True, "n_matched": int(len(ours)),
        "pearson_r": round(r, 3),
        "median_match_dist_ft": round(float(np.median(dists)), 1),
        "median_ours_ft": round(float(np.median(ours)), 2),
        "median_harvey_ft": round(float(np.median(theirs)), 2),
        "_ours": ours, "_theirs": theirs,
    }


def segment_widths(c, polydf: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per-polygon medial widths onto CSCL segments (same reach/band as
    02) so the result is a drop-in replacement for the `w` join."""
    c.register("mw", polydf[["rid", "medial_width_ft"]])
    REACH, DW = 18.0, 30.0
    sql = f"""
    WITH seg AS (
      SELECT PHYSICALID, "Full Street Name" AS street,
             TRY_CAST("Street Width" AS DOUBLE) AS sw, geom_2263 AS g
      FROM geo_cscl WHERE RW_TYPE='1' AND NONPED IS NULL
    ),
    segb AS (SELECT PHYSICALID, street, ST_Buffer(g, COALESCE(NULLIF(sw,0),{DW})/2.0+{REACH}) AS buf FROM seg),
    polys AS (
      SELECT p.rowid AS rid, p.geom_2263 AS g, m.medial_width_ft AS w
      FROM geo_sidewalk_polys p JOIN mw m ON m.rid = p.rowid
    ),
    pairs AS (
      SELECT b.PHYSICALID, b.street, p.w
      FROM segb b JOIN polys p ON ST_Intersects(b.buf, p.g)
      WHERE p.w BETWEEN 2 AND 120
    )
    SELECT PHYSICALID, ANY_VALUE(street) AS street, COUNT(*) AS n_polys,
           quantile_cont(w,0.5) AS width_median_ft,
           MIN(w) AS width_min_ft,
           quantile_cont(w,0.9) AS width_p90_ft
    FROM pairs GROUP BY PHYSICALID
    """
    return c.execute(sql).df()


def main() -> None:
    cap = int(os.environ["MEDIAL_SAMPLE"]) if os.environ.get("MEDIAL_SAMPLE") else None
    c = connect()

    print("1) medial-axis width per polygon" + (f" (sample {cap})" if cap else " (ALL)"))
    polydf = compute_polys(c, cap)
    polydf.drop(columns=["cx", "cy"]).to_parquet(opath("06_medial_axis_polys.parquet"), index=False)

    # validation B: vs 2A/P proxy (per polygon)
    m = polydf.dropna(subset=["wproxy_ft"])
    r_proxy = float(np.corrcoef(m["medial_width_ft"], m["wproxy_ft"])[0, 1]) if len(m) > 30 else None
    print(f"  medial vs 2A/P proxy: r={r_proxy}  "
          f"median medial={polydf['medial_width_ft'].median():.1f}ft  "
          f"median proxy={m['wproxy_ft'].median():.1f}ft")

    # validation A: vs Harvey published
    print("2) validate vs Harvey published widths")
    hv = validate_vs_harvey(polydf)
    r_harvey = hv.get("pearson_r")
    print(f"  vs Harvey: n={hv.get('n_matched')}  r={r_harvey}")

    # per-CSCL-segment widths (drop-in for the `w` join)
    print("3) aggregate onto CSCL segments")
    seg = segment_widths(c, polydf).round(2)
    seg.to_parquet(opath("06_medial_axis_segments.parquet"), index=False)
    print(f"  {len(seg):,} CSCL segments got a medial width  "
          f"(median {seg['width_median_ft'].median():.1f} ft)")

    # correlate per-segment vs 02 proxy segments
    r_seg = None
    prox_seg = OUT + "/02_width_segments.parquet"
    if os.path.exists(prox_seg):
        p02 = pd.read_parquet(prox_seg)[["PHYSICALID", "width_median_ft"]].rename(
            columns={"width_median_ft": "w02"})
        j = seg.merge(p02, on="PHYSICALID", how="inner")
        if len(j) > 30:
            r_seg = float(np.corrcoef(j["width_median_ft"], j["w02"])[0, 1])
    print(f"  per-segment medial vs 02-proxy: r={r_seg}")

    promote = bool(r_harvey is not None and r_harvey > PROMOTE_R)
    verdict = {
        "method": "Voronoi medial-axis (Harvey), median maximal-inscribed-radius x2, EPSG:2263 ft",
        "n_polys_processed": int(len(polydf)),
        "sample_cap": cap,
        "validation_vs_harvey_published": {
            "n_matched": hv.get("n_matched"),
            "pearson_r": r_harvey,
            "median_ours_ft": hv.get("median_ours_ft"),
            "median_harvey_ft": hv.get("median_harvey_ft"),
        },
        "validation_vs_2AP_proxy_perpoly_r": round(r_proxy, 3) if r_proxy else None,
        "validation_vs_02_segment_r": round(r_seg, 3) if r_seg else None,
        "promote_threshold_r": PROMOTE_R,
        "promote_recommended": promote,
        "recommendation": (
            f"PROMOTE: medial-axis correlates r={r_harvey} with Harvey's published widths "
            f"(> {PROMOTE_R}); replace the 2A/P proxy `w` and lift width confidence 🔵→🟡."
            if promote else
            f"KEEP 2A/P as primary: medial-axis r={r_harvey} vs Harvey did not clear {PROMOTE_R}; "
            f"ship medial-axis as an alternative estimate with honest comparison, keep width 🔵."
        ),
    }
    Path(opath("06_medial_axis_validation.json")).write_text(json.dumps(verdict, indent=2), encoding="utf-8")
    print(f"\n  VERDICT: {verdict['recommendation']}")

    # figures
    if hv.get("_ours") is not None and len(hv["_ours"]) > 30:
        fig, ax = plt.subplots(figsize=(6, 6))
        ax.scatter(hv["_theirs"], hv["_ours"], s=8, alpha=.35)
        lim = [0, 50]
        ax.plot(lim, lim, "r--", lw=1, label="1:1")
        ax.set_xlabel("Harvey published width (ft)")
        ax.set_ylabel("Our medial-axis width (ft)")
        ax.set_xlim(lim); ax.set_ylim(lim)
        ax.set_title(f"Medial-axis vs Harvey (r={r_harvey}, n={hv['n_matched']})")
        ax.legend(); plt.tight_layout()
        plt.savefig(opath("fig06_medial_vs_harvey.png"), dpi=130); plt.close()
    if len(m) > 30:
        fig, ax = plt.subplots(figsize=(6, 6))
        ax.scatter(m["wproxy_ft"], m["medial_width_ft"], s=6, alpha=.3)
        ax.plot([0, 60], [0, 60], "r--", lw=1, label="1:1")
        ax.set_xlabel("2·Area/Perimeter proxy (ft)")
        ax.set_ylabel("Medial-axis width (ft)")
        ax.set_xlim(0, 60); ax.set_ylim(0, 60)
        ax.set_title(f"Medial-axis vs 2A/P proxy (r={r_proxy:.2f})")
        ax.legend(); plt.tight_layout()
        plt.savefig(opath("fig06_medial_vs_proxy.png"), dpi=130); plt.close()
    print("  wrote figures + 06_medial_axis_validation.json")


if __name__ == "__main__":
    main()
