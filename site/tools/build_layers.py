"""Pre-generate web map layers + download extracts for the Sidewalk Explorer.

Inputs (env-parameterized; relative defaults from repo layout):
  JANE_GEO_DB   -- jane_geo.duckdb (default <platform>/db/jane_geo.duckdb)
  OUTPUTS_ROOT  -- analysis outputs (default <platform>/../../Outputs/NYCPlatform)
Outputs:
  <site>/frontend/public/layers/*.geojson   (web layers, simplified, coord-rounded)
  OUTPUTS_ROOT/web_extracts/*               (download extracts incl. GeoParquet)

Honesty: web GeoJSON layers are SIMPLIFIED for delivery; full-resolution geometry
ships in the GeoParquet downloads. Every layer records its source + vintage.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve()
SITE = HERE.parents[1]          # .../site
PLATFORM = SITE.parents[0]      # .../NYCPlatform
DB = Path(os.environ.get("JANE_GEO_DB", PLATFORM / "db" / "jane_geo.duckdb"))
OUT_ROOT = Path(os.environ.get("OUTPUTS_ROOT", PLATFORM.parents[1] / "Outputs" / "NYCPlatform"))
LAYERS = SITE / "frontend" / "public" / "layers"
EXTRACTS = OUT_ROOT / "web_extracts"
LAYERS.mkdir(parents=True, exist_ok=True)
EXTRACTS.mkdir(parents=True, exist_ok=True)

SW = OUT_ROOT / "sidewalk"
SAI = OUT_ROOT / "sai"


def rnd(coords, nd):
    if isinstance(coords, (int, float)):
        return round(coords, nd)
    return [rnd(c, nd) for c in coords]


def fc(features, **meta):
    return {"type": "FeatureCollection", **meta, "features": features}


def write(path: Path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(f"  {path.name}: {path.stat().st_size/1e6:.2f} MB, {len(obj['features'])} features")


def main() -> None:
    t0 = time.time()
    con = duckdb.connect(str(DB), read_only=True)
    con.execute("INSTALL spatial; LOAD spatial")
    cov = (SW / "01_coverage_segments.parquet").as_posix()

    # ---------------------------------------------------- 1. coverage segments (per borough)
    # One tier: CSCL segments are mostly 2-point straight lines, so geometric
    # simplification barely changes size (measured overview==detail within 5%).
    # Delivery efficiency comes from per-borough lazy loading + coord rounding.
    boros = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"]
    for tier, tol, nd in [("seg", 0.00004, 5)]:
        for boro in boros:
            rows = con.execute(
                f"""
                SELECT c.coverage_class, ST_AsGeoJSON(ST_Simplify(g.geom_wkb, {tol})) AS gj
                FROM read_parquet('{cov}') c
                JOIN geo_cscl g ON g.PHYSICALID = c.PHYSICALID
                WHERE c.borough = ?
                """,
                [boro],
            ).fetchall()
            feats = []
            for cls, gj in rows:
                if gj is None:
                    continue
                geom = json.loads(gj)
                geom["coordinates"] = rnd(geom["coordinates"], nd)
                feats.append({"type": "Feature", "properties": {"c": cls[0]}, "geometry": geom})
            key = boro.lower().replace(" ", "_")
            write(
                LAYERS / f"coverage_{tier}_{key}.geojson",
                fc(feats, name=f"sidewalk coverage {tier} {boro}",
                   source="DCP planimetric 2022 + CSCL inkn-q76z; classes: analysis 01_coverage_classes"),
            )

    # ---------------------------------------------------- 2. SAI stops (trimmed for web)
    src = json.load(open(SAI / "sai_stops.geojson", encoding="utf-8"))
    keep = ["stop_name", "borough", "routes", "sai", "walkshed_population", "sidewalk_provision",
            "ada_ramp_access", "comfort", "condition", "safety", "service_intensity", "pop_400m"]
    feats = []
    for f in src["features"]:
        p = f["properties"]
        props = {k: (round(p[k], 1) if isinstance(p.get(k), float) else p.get(k)) for k in keep}
        props["stop_id"] = p.get("stop_id")
        geom = f["geometry"]
        geom["coordinates"] = rnd(geom["coordinates"], 6)
        feats.append({"type": "Feature", "properties": props, "geometry": geom})
    write(
        LAYERS / "sai_stops.min.geojson",
        fc(feats, name="Stop Accessibility Index (per-stop, trimmed for web)",
           source="analysis/sai (2026-07-17); full attributes in the sai_stops.geoparquet download"),
    )

    # ---------------------------------------------------- 3. NTA equity choropleth
    ntacov = (SW / "03_nta_coverage.parquet").as_posix()
    rows = con.execute(
        f"""
        SELECT n.nta2020, n.ntaname, n.boroname,
               c.coverage_ratio_ft, c.sqft_per_capita, c.total_pop, c.med_income_bgmed,
               ST_AsGeoJSON(ST_Simplify(n.geom_wkb, 0.0002)) AS gj
        FROM pop_ntas n
        JOIN read_parquet('{ntacov}') c ON c.nta2020 = n.nta2020
        """
    ).fetchall()
    feats = []
    for nta, name, boro, ratio, spc, pop, inc, gj in rows:
        if gj is None:
            continue
        geom = json.loads(gj)
        geom["coordinates"] = rnd(geom["coordinates"], 5)
        feats.append({"type": "Feature", "properties": {
            "nta": nta, "name": name, "boro": boro,
            "ratio": None if ratio is None else round(ratio, 2),
            "spc": None if spc is None else round(spc, 1),
            "pop": pop, "inc": inc,
        }, "geometry": geom})
    write(
        LAYERS / "nta_equity.geojson",
        fc(feats, name="NTA sidewalk coverage & equity",
           source="DCP NTA 2020 (9nt8-h7nd) + analysis 03_block_equity; pop PL94-171 2020; income ACS 5yr"),
    )

    # ---------------------------------------------------- 4. ADA ramp gaps (web layer)
    acc = (SW / "05_accessibility_intersections.parquet").as_posix()
    rows = con.execute(
        f"""
        SELECT ST_AsGeoJSON(ST_Transform(ST_Point(nx, ny), 'EPSG:2263', 'EPSG:4326', always_xy := true)),
               degree, ntaname, boroname
        FROM read_parquet('{acc}')
        WHERE has_ramp = 0
        """
    ).fetchall()
    feats = []
    for gj, degree, nta, boro in rows:
        geom = json.loads(gj)
        geom["coordinates"] = rnd(geom["coordinates"], 6)
        feats.append({"type": "Feature", "properties": {"deg": degree, "nta": nta, "boro": boro},
                      "geometry": geom})
    write(
        LAYERS / "ada_gaps.geojson",
        fc(feats, name="Intersections lacking any pedestrian ramp within 50 ft",
           source="DOT pedestrian ramps ufzp-rrqu + CSCL nodes; analysis 05_accessibility"),
    )

    # ---------------------------------------------------- 5. download extracts
    con.execute(
        f"""
        COPY (
            SELECT c.PHYSICALID, c.borough, c.street, c.coverage_class, c.street_width_ft,
                   c.seg_len_ft, c.sidewalk_area_sqft, c.has_left, c.has_right, g.geom_wkb AS geometry
            FROM read_parquet('{cov}') c
            JOIN geo_cscl g ON g.PHYSICALID = c.PHYSICALID
        ) TO '{(EXTRACTS / "sidewalk_coverage_segments.geoparquet").as_posix()}' (FORMAT parquet)
        """
    )
    p = EXTRACTS / "sidewalk_coverage_segments.geoparquet"
    print(f"  {p.name}: {p.stat().st_size/1e6:.2f} MB")

    rows = con.execute(
        f"""
        SELECT n.nta2020, n.ntaname, n.boroname, c.n_blocks, c.sidewalk_area_sqft, c.frontage_ft,
               c.total_pop, c.med_income_bgmed, c.coverage_ratio_ft, c.sqft_per_capita,
               ST_AsGeoJSON(n.geom_wkb)
        FROM pop_ntas n JOIN read_parquet('{ntacov}') c ON c.nta2020 = n.nta2020
        """
    ).fetchall()
    feats = [{"type": "Feature",
              "properties": {"nta2020": r[0], "ntaname": r[1], "boroname": r[2], "n_blocks": r[3],
                             "sidewalk_area_sqft": r[4], "frontage_ft": r[5], "total_pop": r[6],
                             "med_income_bgmed": r[7], "coverage_ratio_ft": r[8],
                             "sqft_per_capita": r[9]},
              "geometry": json.loads(r[10])} for r in rows]
    write(EXTRACTS / "nta_sidewalk_equity.geojson", fc(feats, name="NTA sidewalk equity (full res)"))
    con.execute(
        f"""
        COPY (SELECT n.nta2020, n.ntaname, n.boroname,
                     c.n_blocks, c.sidewalk_area_sqft, c.frontage_ft, c.total_pop,
                     c.med_income_bgmed, c.coverage_ratio_ft, c.sqft_per_capita,
                     n.geom_wkb AS geometry
              FROM pop_ntas n JOIN read_parquet('{ntacov}') c ON c.nta2020 = n.nta2020)
        TO '{(EXTRACTS / "nta_sidewalk_equity.geoparquet").as_posix()}' (FORMAT parquet)
        """
    )

    rows = con.execute(
        f"""
        SELECT ST_AsGeoJSON(ST_Transform(ST_Point(nx, ny), 'EPSG:2263', 'EPSG:4326', always_xy := true)),
               degree, n_ramps, n_ramps_steep, nta2020, ntaname, boroname
        FROM read_parquet('{acc}') WHERE has_ramp = 0
        """
    ).fetchall()
    feats = [{"type": "Feature",
              "properties": {"degree": r[1], "n_ramps": r[2], "n_ramps_steep": r[3],
                             "nta2020": r[4], "ntaname": r[5], "boroname": r[6]},
              "geometry": json.loads(r[0])} for r in rows]
    write(EXTRACTS / "ada_ramp_gaps.geojson", fc(feats, name="ADA ramp gaps (full attributes)"))
    con.execute(
        f"""
        COPY (SELECT ST_AsWKB(ST_Transform(ST_Point(nx, ny), 'EPSG:2263', 'EPSG:4326', always_xy := true)) AS geometry,
                     degree, n_ramps, n_ramps_steep, nta2020, ntaname, boroname
              FROM read_parquet('{acc}') WHERE has_ramp = 0)
        TO '{(EXTRACTS / "ada_ramp_gaps.geoparquet").as_posix()}' (FORMAT parquet)
        """
    )
    con.execute(
        f"""
        COPY (SELECT nta2020, ntaname, boroname, degree, n_ramps, n_ramps_steep
              FROM read_parquet('{acc}') WHERE has_ramp = 0)
        TO '{(EXTRACTS / "ada_ramp_gaps.csv").as_posix()}' (FORMAT csv, HEADER)
        """
    )
    print(f"TOTAL {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
