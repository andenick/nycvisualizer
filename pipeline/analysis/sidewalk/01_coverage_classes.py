"""B5.1(1) — Per-street-segment sidewalk coverage class (citywide).

For each CSCL street segment (RW_TYPE='1' roadway, pedestrian-permitted), buffer
the centerline by (half streetwidth + SIDEWALK_REACH ft), intersect with the
planimetric sidewalk polygons, and classify each intersecting sidewalk patch to
the LEFT or RIGHT of the segment's direction of travel via a cross-product side
test on the near-segment intersection centroid. coverage_class in
{none, one_side, both_sides} — the Westchester app semantics, citywide.

EPSG:2263 throughout. Runs borough-by-borough to keep each spatial join small.
"""
import time
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from _common import connect, write_outputs, opath, BORO

SIDEWALK_REACH = 18.0   # ft beyond the curb we search for a sidewalk polygon
DEFAULT_WIDTH = 30.0    # ft, used when Street Width is null/0

SQL = """
WITH seg AS (
  SELECT PHYSICALID,
         "Full Street Name" AS street,
         TRY_CAST("Street Width" AS DOUBLE) AS sw,
         geom_2263 AS g,
         ST_Length(geom_2263) AS seg_len_ft,
         ST_LineMerge(geom_2263) AS gm
  FROM geo_cscl
  WHERE "Borough Code" = ? AND RW_TYPE = '1' AND NONPED IS NULL
),
segb AS (
  SELECT PHYSICALID, street, sw, seg_len_ft, g,
         ST_X(ST_StartPoint(gm)) AS x0, ST_Y(ST_StartPoint(gm)) AS y0,
         ST_X(ST_EndPoint(gm))   AS x1, ST_Y(ST_EndPoint(gm))   AS y1,
         ST_Buffer(g, COALESCE(NULLIF(sw,0), {dw})/2.0 + {reach}) AS buf
  FROM seg
),
pairs AS (  -- one row per (segment, nearby sidewalk polygon)
  SELECT b.PHYSICALID, b.x0, b.y0, b.x1, b.y1,
         ST_Area(ST_Intersection(b.buf, p.geom_2263)) AS ipa,
         ST_EndPoint(ST_ShortestLine(b.g, p.geom_2263)) AS cp
  FROM segb b
  JOIN geo_sidewalk_polys p ON ST_Intersects(b.buf, p.geom_2263)
),
sided AS (
  SELECT PHYSICALID, ipa,
         ((x1-x0)*(ST_Y(cp)-y0) - (y1-y0)*(ST_X(cp)-x0)) AS crs
  FROM pairs
),
agg AS (
  SELECT PHYSICALID,
         SUM(ipa) AS sidewalk_area_sqft,
         MAX(CASE WHEN crs > 0 THEN 1 ELSE 0 END) AS has_left,
         MAX(CASE WHEN crs < 0 THEN 1 ELSE 0 END) AS has_right
  FROM sided GROUP BY PHYSICALID
)
SELECT s.PHYSICALID, s.street, s.sw AS street_width_ft, s.seg_len_ft,
       COALESCE(a.sidewalk_area_sqft, 0.0) AS sidewalk_area_sqft,
       COALESCE(a.has_left, 0) AS has_left,
       COALESCE(a.has_right, 0) AS has_right,
       CASE WHEN COALESCE(a.has_left,0)=1 AND COALESCE(a.has_right,0)=1 THEN 'both_sides'
            WHEN COALESCE(a.has_left,0)=1 OR  COALESCE(a.has_right,0)=1 THEN 'one_side'
            ELSE 'none' END AS coverage_class
FROM seg s
LEFT JOIN agg a USING (PHYSICALID)
"""


def main():
    c = connect()
    frames = []
    for code, name in BORO.items():
        t = time.time()
        q = SQL.format(dw=DEFAULT_WIDTH, reach=SIDEWALK_REACH)
        df = c.execute(q, [code]).df()
        df["borough"] = name
        frames.append(df)
        vc = df["coverage_class"].value_counts().to_dict()
        print(f"{name:14s} {len(df):6,} segs  {vc}  ({time.time()-t:.1f}s)")
    seg = pd.concat(frames, ignore_index=True)
    seg = seg[["PHYSICALID", "borough", "street", "street_width_ft", "seg_len_ft",
               "sidewalk_area_sqft", "has_left", "has_right", "coverage_class"]]

    # Borough summary (segment counts + centerline-mile-weighted)
    seg["seg_len_mi"] = seg["seg_len_ft"] / 5280.0
    summ = (seg.groupby(["borough", "coverage_class"])
               .agg(n_segments=("PHYSICALID", "size"),
                    centerline_mi=("seg_len_mi", "sum"))
               .reset_index())
    piv = summ.pivot(index="borough", columns="coverage_class",
                     values="n_segments").fillna(0).astype(int)
    for col in ["none", "one_side", "both_sides"]:
        if col not in piv.columns:
            piv[col] = 0
    piv = piv[["none", "one_side", "both_sides"]]   # fix column order
    piv["total"] = piv[["none", "one_side", "both_sides"]].sum(axis=1)
    piv["pct_both"] = (100 * piv["both_sides"] / piv["total"]).round(1)
    piv["pct_none"] = (100 * piv["none"] / piv["total"]).round(1)
    city = piv[["none", "one_side", "both_sides", "total"]].sum()
    piv.loc["Citywide"] = {
        "none": city["none"], "one_side": city["one_side"],
        "both_sides": city["both_sides"], "total": city["total"],
        "pct_both": round(100*city["both_sides"]/city["total"], 1),
        "pct_none": round(100*city["none"]/city["total"], 1)}
    piv = piv.reset_index()

    write_outputs(seg, "01_coverage_segments", sheet="segments",
                  extra_sheets={"borough_summary": piv})
    write_outputs(piv, "01_coverage_borough_summary", sheet="summary")

    # Headline chart: stacked coverage-class share by borough
    plotd = piv[piv["borough"] != "Citywide"].set_index("borough")
    share = plotd[["both_sides", "one_side", "none"]].div(plotd["total"], axis=0) * 100
    ax = share.plot(kind="barh", stacked=True, figsize=(9, 5),
                    color=["#1a7f4b", "#e6a817", "#c0392b"])
    ax.set_xlabel("% of street segments")
    ax.set_ylabel("")
    ax.set_title("Sidewalk coverage class by borough (CSCL roadway segments)")
    ax.legend(["Both sides", "One side", "None"], loc="lower right", fontsize=9)
    ax.set_xlim(0, 100)
    plt.tight_layout()
    plt.savefig(opath("fig01_coverage_by_borough.png"), dpi=130)
    plt.close()
    print("  wrote fig01_coverage_by_borough.png")
    print("\nCITYWIDE:", piv[piv.borough == "Citywide"].to_dict("records")[0])


if __name__ == "__main__":
    main()
