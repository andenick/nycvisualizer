"""B5.1(2) — Per-segment sidewalk width estimation.

Method (honest approximation of the sidewalkwidths.nyc idea; cite Meli Harvey
2020, github.com/meliharvey/sidewalkwidths-nyc for the medial-axis method we
approximate). We do NOT compute a full medial axis. Instead each planimetric
sidewalk polygon gets a typical-width proxy:

    w_proxy = 2 * Area / Perimeter        (ftUS, EPSG:2263)

For a long thin strip of width W and length L (Area=WL, Perimeter approx 2L),
2A/P = W, so 2A/P recovers the typical width of a corridor-like polygon. It is
biased LOW for L-shaped corner-wrapping polygons and biased for blob-like plazas
(their perimeter is small relative to area is not corridor-like) — we validate the
proxy against a true max-inscribed-width (binary-searched negative buffer) on a
random sample and report the agreement + limits.

Per-segment width = median / min of the w_proxy of the sidewalk polygons that fall
within the coverage search band of each CSCL roadway segment.
"""
import time
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from _common import connect, write_outputs, opath, BORO

REACH = 18.0
DEFAULT_WIDTH = 30.0

# per-(segment, polygon) with the polygon width proxy
SEG_SQL = """
WITH seg AS (
  SELECT PHYSICALID, "Full Street Name" AS street,
         TRY_CAST("Street Width" AS DOUBLE) AS sw, geom_2263 AS g
  FROM geo_cscl WHERE "Borough Code" = ? AND RW_TYPE='1' AND NONPED IS NULL
),
segb AS (SELECT PHYSICALID, street, ST_Buffer(g, COALESCE(NULLIF(sw,0),{dw})/2.0+{reach}) AS buf FROM seg),
pairs AS (
  SELECT b.PHYSICALID, b.street,
         2*ST_Area(p.geom_2263)/NULLIF(ST_Perimeter(p.geom_2263),0) AS w_proxy,
         ST_Area(p.geom_2263) AS area
  FROM segb b JOIN geo_sidewalk_polys p ON ST_Intersects(b.buf, p.geom_2263)
  WHERE 2*ST_Area(p.geom_2263)/NULLIF(ST_Perimeter(p.geom_2263),0) BETWEEN 2 AND 120
)
SELECT PHYSICALID, ANY_VALUE(street) AS street,
       COUNT(*) AS n_polys,
       quantile_cont(w_proxy, 0.5) AS width_median_ft,
       MIN(w_proxy) AS width_min_ft,
       quantile_cont(w_proxy, 0.9) AS width_p90_ft
FROM pairs GROUP BY PHYSICALID
"""


def validate_proxy(c, n=300):
    """Compare w_proxy against a binary-searched max-inscribed width on a sample."""
    rows = c.execute("""
        SELECT ST_AsText(geom_2263) wkt,
               2*ST_Area(geom_2263)/NULLIF(ST_Perimeter(geom_2263),0) w_proxy,
               ST_Area(geom_2263) area
        FROM geo_sidewalk_polys
        WHERE 2*ST_Area(geom_2263)/NULLIF(ST_Perimeter(geom_2263),0) BETWEEN 2 AND 120
        USING SAMPLE %d ROWS (reservoir, 42)""" % n).fetchall()
    out = []
    for wkt, wproxy, area in rows:
        # binary search max r s.t. buffer(poly,-r) non-empty  -> max inscribed width = 2r
        lo, hi = 0.0, 120.0
        for _ in range(18):
            mid = (lo + hi) / 2
            empty = c.execute(
                "SELECT ST_IsEmpty(ST_Buffer(ST_GeomFromText(?), ?))",
                [wkt, -mid]).fetchone()[0]
            if empty:
                hi = mid
            else:
                lo = mid
        out.append((wproxy, 2*lo, area))
    df = pd.DataFrame(out, columns=["w_proxy", "max_inscribed_width", "area"])
    return df


def main():
    c = connect()

    # ---- validation sample ----
    t = time.time()
    val = validate_proxy(c, 300)
    r = np.corrcoef(val["w_proxy"], val["max_inscribed_width"])[0, 1]
    ratio = (val["w_proxy"] / val["max_inscribed_width"].replace(0, np.nan)).median()
    print(f"validation: n={len(val)}  pearson r={r:.3f}  "
          f"median(w_proxy/max_inscribed)={ratio:.2f}  ({time.time()-t:.1f}s)")

    # ---- per-segment widths ----
    frames = []
    for code, name in BORO.items():
        t = time.time()
        df = c.execute(SEG_SQL.format(dw=DEFAULT_WIDTH, reach=REACH), [code]).df()
        df["borough"] = name
        frames.append(df)
        print(f"{name:14s} {len(df):6,} segs  "
              f"median width {df['width_median_ft'].median():.1f} ft  ({time.time()-t:.1f}s)")
    seg = pd.concat(frames, ignore_index=True)
    seg = seg[["PHYSICALID", "borough", "street", "n_polys",
               "width_min_ft", "width_median_ft", "width_p90_ft"]].round(2)

    # borough width summary
    bsum = (seg.groupby("borough")["width_median_ft"]
              .agg(n_segments="size", p10=lambda s: s.quantile(.1),
                   median="median", mean="mean", p90=lambda s: s.quantile(.9))
              .reset_index().round(2))
    city = pd.DataFrame([{
        "borough": "Citywide", "n_segments": len(seg),
        "p10": seg["width_median_ft"].quantile(.1),
        "median": seg["width_median_ft"].median(),
        "mean": seg["width_median_ft"].mean(),
        "p90": seg["width_median_ft"].quantile(.9)}]).round(2)
    bsum = pd.concat([bsum, city], ignore_index=True)

    val_summary = pd.DataFrame([{
        "metric": "pearson_r(w_proxy, max_inscribed)", "value": round(r, 3)},
        {"metric": "median_ratio_proxy_over_inscribed", "value": round(ratio, 3)},
        {"metric": "n_sample", "value": len(val)}])

    write_outputs(seg, "02_width_segments", sheet="segment_width",
                  extra_sheets={"borough_summary": bsum, "validation": val_summary})
    write_outputs(bsum, "02_width_borough_summary", sheet="summary")

    # figure: width distribution by borough (box)
    fig, ax = plt.subplots(figsize=(9, 5))
    data = [seg.loc[seg.borough == b, "width_median_ft"].clip(0, 40)
            for b in BORO.values()]
    ax.boxplot(data, labels=list(BORO.values()), showfliers=False)
    ax.set_ylabel("Per-segment median sidewalk width (ft)")
    ax.set_title("Estimated sidewalk width by borough (2·Area/Perimeter proxy)")
    ax.axhline(seg["width_median_ft"].median(), ls="--", c="#888",
               label=f"citywide median {seg['width_median_ft'].median():.1f} ft")
    ax.legend()
    plt.tight_layout()
    plt.savefig(opath("fig02_width_by_borough.png"), dpi=130)
    plt.close()

    # figure: validation scatter
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.scatter(val["max_inscribed_width"], val["w_proxy"], s=12, alpha=.5)
    lim = [0, min(80, val[["w_proxy", "max_inscribed_width"]].max().max()*1.05)]
    ax.plot(lim, lim, "r--", lw=1, label="1:1")
    ax.set_xlabel("Max inscribed width (binary-searched, ft)")
    ax.set_ylabel("2·Area/Perimeter proxy (ft)")
    ax.set_title(f"Width-proxy validation (r={r:.2f}, n={len(val)})")
    ax.legend()
    plt.tight_layout()
    plt.savefig(opath("fig02_width_validation.png"), dpi=130)
    plt.close()
    print("  wrote fig02_width_by_borough.png, fig02_width_validation.png")


if __name__ == "__main__":
    main()
