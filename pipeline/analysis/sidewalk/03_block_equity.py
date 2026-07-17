"""B5.1(3) — Block-level sidewalk provision + coverage-vs-income equity.

Per 2020 census block (DCP blocks, boundaries follow street centerlines, so each
block polygon contains its half of the street right-of-way including sidewalk):
  - sidewalk_area_sqft  = sum of ST_Area of (sidewalk polygon ∩ block polygon)
  - frontage proxy      = block polygon perimeter (ft; centerline-bounded blocks
                          make perimeter approx the block's street frontage)
  - coverage_ratio      = sidewalk_area / perimeter  (ft of average sidewalk width
                          per frontage foot, both street sides combined)
  - per-capita          = sidewalk_area / 2020 P1_001N population (pop_block_pop)
Aggregated to NTA (block centroid-in-polygon). Equity: ACS 2023 5-yr block-group
median household income (GEOID12 = first 12 chars of block GEOID) vs coverage →
scatter + population-weighted income-quintile table. Flags populated blocks with
zero sidewalk area. All measurement EPSG:2263 ftUS.
"""
import time
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from _common import connect, write_outputs, opath

BLOCK_SQL = """
WITH blk AS (
  SELECT geoid, boroname, geom_2263 AS g,
         ST_Area(geom_2263) AS block_area_sqft,
         ST_Perimeter(geom_2263) AS perimeter_ft
  FROM pop_census_blocks WHERE boroname = ?
),
sw AS (
  SELECT b.geoid, SUM(ST_Area(ST_Intersection(b.g, p.geom_2263))) AS sidewalk_area_sqft
  FROM blk b JOIN geo_sidewalk_polys p ON ST_Intersects(b.g, p.geom_2263)
  GROUP BY b.geoid
)
SELECT b.geoid, b.boroname, b.block_area_sqft, b.perimeter_ft,
       COALESCE(sw.sidewalk_area_sqft, 0) AS sidewalk_area_sqft,
       ST_X(ST_Centroid(b.g)) AS cx, ST_Y(ST_Centroid(b.g)) AS cy
FROM blk b LEFT JOIN sw USING (geoid)
"""

NTA_SQL = """
SELECT nta2020, ntaname, boroname, geom_2263 FROM pop_ntas
"""


def main():
    c = connect()
    boros = [r[0] for r in c.execute(
        "SELECT DISTINCT boroname FROM pop_census_blocks").fetchall()]
    frames = []
    for b in boros:
        t = time.time()
        df = c.execute(BLOCK_SQL, [b]).df()
        frames.append(df)
        print(f"{b:14s} {len(df):6,} blocks  ({time.time()-t:.1f}s)")
    blk = pd.concat(frames, ignore_index=True)

    # population join (GEOID15)
    pop = c.execute("SELECT GEOID15, total_pop FROM pop_block_pop").df()
    blk = blk.merge(pop, left_on="geoid", right_on="GEOID15", how="left")
    blk["total_pop"] = blk["total_pop"].fillna(0).astype(int)

    # ACS income at block group
    acs = c.execute("""
        SELECT GEOID12, TRY_CAST(B19013_001E AS DOUBLE) AS med_hh_income,
               TRY_CAST(B01003_001E AS DOUBLE) AS bg_pop
        FROM pop_bg_acs""").df()
    acs.loc[acs["med_hh_income"] <= -666666666, "med_hh_income"] = np.nan
    blk["GEOID12"] = blk["geoid"].str[:12]
    blk = blk.merge(acs, on="GEOID12", how="left")

    # NTA assignment via centroid point-in-polygon (inside DuckDB for speed)
    cent = blk[["geoid", "cx", "cy"]]
    c.register("cent", cent)
    nta_assign = c.execute("""
        SELECT ct.geoid, n.nta2020, n.ntaname
        FROM cent ct JOIN pop_ntas n
          ON ST_Within(ST_Point(ct.cx, ct.cy), n.geom_2263)""").df()
    blk = blk.merge(nta_assign, on="geoid", how="left")

    # metrics
    blk["coverage_ratio_ft"] = blk["sidewalk_area_sqft"] / blk["perimeter_ft"].replace(0, np.nan)
    blk["sqft_per_capita"] = np.where(blk["total_pop"] > 0,
                                      blk["sidewalk_area_sqft"] / blk["total_pop"], np.nan)
    out_cols = ["geoid", "boroname", "nta2020", "ntaname", "block_area_sqft",
                "perimeter_ft", "sidewalk_area_sqft", "coverage_ratio_ft",
                "total_pop", "sqft_per_capita", "med_hh_income"]
    blko = blk[out_cols].round(2)

    # striking gaps: populated blocks with ZERO sidewalk area
    gaps = blko[(blko["total_pop"] >= 50) & (blko["sidewalk_area_sqft"] == 0)] \
        .sort_values("total_pop", ascending=False)
    print(f"\npopulated (>=50) blocks with ZERO sidewalk area: {len(gaps)} "
          f"({gaps['total_pop'].sum():,} residents)")
    print(gaps.head(10)[["geoid", "boroname", "ntaname", "total_pop"]].to_string(index=False))

    # NTA aggregation
    nta = (blk.groupby(["nta2020", "ntaname", "boroname"], dropna=True)
           .agg(n_blocks=("geoid", "size"),
                sidewalk_area_sqft=("sidewalk_area_sqft", "sum"),
                frontage_ft=("perimeter_ft", "sum"),
                total_pop=("total_pop", "sum"),
                med_income_bgmed=("med_hh_income", "median"))
           .reset_index())
    nta["coverage_ratio_ft"] = nta["sidewalk_area_sqft"] / nta["frontage_ft"]
    nta["sqft_per_capita"] = np.where(nta["total_pop"] > 0,
                                      nta["sidewalk_area_sqft"] / nta["total_pop"], np.nan)
    nta = nta.round(2)

    # income quintiles (population-weighted, block obs with income + pop>0)
    eq = blk.dropna(subset=["med_hh_income"])
    eq = eq[eq["total_pop"] > 0].copy()
    eq["inc_q"] = pd.qcut(eq["med_hh_income"], 5,
                          labels=["Q1 (lowest)", "Q2", "Q3", "Q4", "Q5 (highest)"])
    qt = (eq.groupby("inc_q", observed=True)
          .apply(lambda g: pd.Series({
              "n_blocks": len(g),
              "population": g["total_pop"].sum(),
              "median_income_range": f"{g['med_hh_income'].min():,.0f}-{g['med_hh_income'].max():,.0f}",
              "mean_coverage_ratio_ft": np.average(g["coverage_ratio_ft"].fillna(0),
                                                   weights=g["total_pop"]),
              "sqft_per_capita": g["sidewalk_area_sqft"].sum() / g["total_pop"].sum(),
              "pct_zero_sidewalk_blocks": 100*(g["sidewalk_area_sqft"] == 0).mean()}),
          include_groups=False)
          .reset_index().round(3))
    print("\nIncome-quintile equity table:")
    print(qt.to_string(index=False))

    write_outputs(blko, "03_block_equity", sheet="blocks",
                  extra_sheets={"income_quintiles": qt,
                                "zero_sidewalk_gaps": gaps.head(500)})
    write_outputs(nta, "03_nta_coverage", sheet="nta")

    # scatter: NTA coverage vs income
    fig, ax = plt.subplots(figsize=(8, 6))
    ntap = nta.dropna(subset=["med_income_bgmed"])
    colors = {"Manhattan": "#4363d8", "Brooklyn": "#e6194b", "Queens": "#3cb44b",
              "Bronx": "#f58231", "Staten Island": "#911eb4"}
    for b, g in ntap.groupby("boroname"):
        ax.scatter(g["med_income_bgmed"]/1000, g["coverage_ratio_ft"],
                   s=np.sqrt(g["total_pop"])/5, alpha=.55,
                   color=colors.get(b, "#666"), label=b)
    ax.set_xlabel("NTA median household income ($1,000, ACS 2023 5-yr, BG median)")
    ax.set_ylabel("Sidewalk coverage ratio (sqft per frontage-ft)")
    ax.set_title("Sidewalk coverage vs income by NTA (bubble = population)")
    ax.legend(fontsize=8)
    plt.tight_layout()
    plt.savefig(opath("fig03_coverage_vs_income.png"), dpi=130)
    plt.close()

    # per-capita bar by quintile
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.bar(qt["inc_q"].astype(str), qt["sqft_per_capita"], color="#1a7f4b")
    ax.set_ylabel("Sidewalk sqft per capita")
    ax.set_title("Sidewalk area per capita by block income quintile (pop-weighted)")
    plt.tight_layout()
    plt.savefig(opath("fig03_percapita_by_quintile.png"), dpi=130)
    plt.close()
    print("  wrote fig03_coverage_vs_income.png, fig03_percapita_by_quintile.png")

    # equity gradient stat
    corr = np.corrcoef(eq["med_hh_income"], eq["coverage_ratio_ft"].fillna(0))[0, 1]
    print(f"\nblock-level pearson r (income, coverage_ratio) = {corr:.3f}")


if __name__ == "__main__":
    main()
