"""B5.1(5) — Pedestrian-ramp accessibility at intersections (ADA gap map data).

Intersections are derived from the CSCL network itself: endpoints of pedestrian
roadway segments (RW_TYPE='1', NONPED IS NULL) via ST_LineMerge, snapped to a
1-ft grid (CSCL is topologically noded so endpoints coincide); a node with >= 3
incident segment-endpoints is an intersection (degree-2 = midblock pseudo-node,
degree-1 = dead end/stub — both excluded).

Each intersection is tested for pedestrian ramps (DOT ufzp-rrqu, 217,679 points)
within RAMP_RADIUS ft. Outputs: node-level parquet (degree, ramp count, nearest
ramp presence), per-NTA and per-borough ramp coverage %, plus ADA slope
compliance (running slope > 8.33% fails; slope values >= 100 are sentinels and
excluded). EPSG:2263 ftUS.
"""
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from _common import connect, write_outputs, opath

RAMP_RADIUS = 50.0
SLOPE_SENTINEL = 100.0   # slopes >= this are treated as not-measured
ADA_MAX_SLOPE = 8.33


def main():
    c = connect()

    # ---------- nodes from CSCL endpoints ----------
    c.execute("""
        CREATE TEMP TABLE nodes AS
        WITH seg AS (
          SELECT PHYSICALID, ST_LineMerge(geom_2263) gm
          FROM geo_cscl WHERE RW_TYPE='1' AND NONPED IS NULL),
        ends AS (
          SELECT PHYSICALID, ST_StartPoint(gm) p FROM seg
          UNION ALL
          SELECT PHYSICALID, ST_EndPoint(gm) p FROM seg),
        snapped AS (
          SELECT PHYSICALID, round(ST_X(p)) AS nx, round(ST_Y(p)) AS ny FROM ends
          WHERE p IS NOT NULL)
        SELECT nx, ny, count(*) AS degree,
               count(DISTINCT PHYSICALID) AS n_segments
        FROM snapped GROUP BY nx, ny""")
    deg = c.execute("""
        SELECT CASE WHEN degree>=3 THEN 'intersection (>=3)'
                    WHEN degree=2 THEN 'midblock pseudo-node'
                    ELSE 'dead end' END k, count(*)
        FROM nodes GROUP BY 1""").df()
    print(deg.to_string(index=False))

    # ---------- ramps within radius of each intersection ----------
    inter = c.execute(f"""
        WITH ix AS (
          SELECT nx, ny, degree, ST_Point(nx, ny) AS pt,
                 ST_Buffer(ST_Point(nx, ny), {RAMP_RADIUS}) AS buf
          FROM nodes WHERE degree >= 3),
        rj AS (
          SELECT i.nx, i.ny, count(r.RampID) AS n_ramps,
                 SUM(CASE WHEN r.RAMP_RUNNING_SLOPE_TOTAL > {ADA_MAX_SLOPE}
                          AND r.RAMP_RUNNING_SLOPE_TOTAL < {SLOPE_SENTINEL}
                          THEN 1 ELSE 0 END) AS n_ramps_steep
          FROM ix i JOIN geo_ramps r ON ST_Intersects(i.buf, r.geom_2263)
          GROUP BY i.nx, i.ny)
        SELECT i.nx, i.ny, i.degree,
               COALESCE(rj.n_ramps, 0) AS n_ramps,
               COALESCE(rj.n_ramps_steep, 0) AS n_ramps_steep
        FROM (SELECT nx, ny, degree FROM nodes WHERE degree >= 3) i
        LEFT JOIN rj USING (nx, ny)""").df()
    inter["has_ramp"] = (inter["n_ramps"] > 0).astype(int)
    print(f"intersections: {len(inter):,}  with >=1 ramp within {RAMP_RADIUS:.0f} ft: "
          f"{inter['has_ramp'].sum():,} ({100*inter['has_ramp'].mean():.1f}%)")

    # ---------- NTA / borough assignment ----------
    c.register("inter", inter)
    ntaj = c.execute("""
        SELECT i.nx, i.ny, n.nta2020, n.ntaname, n.boroname
        FROM inter i JOIN pop_ntas n
          ON ST_Within(ST_Point(i.nx, i.ny), n.geom_2263)""").df()
    inter = inter.merge(ntaj, on=["nx", "ny"], how="left")

    nta = (inter.dropna(subset=["nta2020"])
           .groupby(["nta2020", "ntaname", "boroname"])
           .agg(n_intersections=("has_ramp", "size"),
                n_with_ramp=("has_ramp", "sum"),
                total_ramps=("n_ramps", "sum"),
                steep_ramps=("n_ramps_steep", "sum"))
           .reset_index())
    nta["ramp_coverage_pct"] = (100 * nta["n_with_ramp"] / nta["n_intersections"]).round(1)
    nta["steep_ramp_pct"] = (100 * nta["steep_ramps"] /
                             nta["total_ramps"].replace(0, np.nan)).round(1)
    nta = nta.sort_values("ramp_coverage_pct")

    boro = (inter.dropna(subset=["boroname"]).groupby("boroname")
            .agg(n_intersections=("has_ramp", "size"),
                 n_with_ramp=("has_ramp", "sum"),
                 total_ramps=("n_ramps", "sum"),
                 steep_ramps=("n_ramps_steep", "sum"))
            .reset_index())
    boro["ramp_coverage_pct"] = (100 * boro["n_with_ramp"] / boro["n_intersections"]).round(1)
    boro["steep_ramp_pct"] = (100 * boro["steep_ramps"] / boro["total_ramps"]).round(1)
    city = pd.DataFrame([{
        "boroname": "Citywide",
        "n_intersections": len(inter),
        "n_with_ramp": inter["has_ramp"].sum(),
        "total_ramps": inter["n_ramps"].sum(),
        "steep_ramps": inter["n_ramps_steep"].sum(),
        "ramp_coverage_pct": round(100*inter["has_ramp"].mean(), 1),
        "steep_ramp_pct": round(100*inter["n_ramps_steep"].sum() /
                                max(inter["n_ramps"].sum(), 1), 1)}])
    boro = pd.concat([boro, city], ignore_index=True)
    print(boro.to_string(index=False))

    # citywide ramp ADA slope stats (measured ramps only)
    slope = c.execute(f"""
        SELECT count(*) n_measured,
               SUM(CASE WHEN RAMP_RUNNING_SLOPE_TOTAL > {ADA_MAX_SLOPE} THEN 1 ELSE 0 END) n_fail
        FROM geo_ramps WHERE RAMP_RUNNING_SLOPE_TOTAL < {SLOPE_SENTINEL}""").df()
    slope["pct_fail"] = (100*slope["n_fail"]/slope["n_measured"]).round(1)
    print("ADA slope (measured ramps):", slope.to_dict("records")[0])

    outn = inter[["nx", "ny", "degree", "n_ramps", "n_ramps_steep", "has_ramp",
                  "nta2020", "ntaname", "boroname"]]
    write_outputs(outn, "05_accessibility_intersections", sheet="intersections",
                  extra_sheets={"nta": nta, "borough": boro, "ada_slope": slope})
    write_outputs(nta, "05_accessibility_nta", sheet="nta")

    # ---------- figures ----------
    # pseudo-map: intersections lacking ramps
    fig, ax = plt.subplots(figsize=(8, 9))
    ok = inter[inter["has_ramp"] == 1]
    gap = inter[inter["has_ramp"] == 0]
    ax.scatter(ok["nx"], ok["ny"], s=.5, c="#b8d8c6", label="Has ramp(s)")
    ax.scatter(gap["nx"], gap["ny"], s=1.2, c="#c0392b",
               label=f"No ramp within {RAMP_RADIUS:.0f} ft ({len(gap):,})")
    ax.set_aspect("equal")
    ax.set_axis_off()
    ax.set_title("NYC intersections lacking pedestrian ramps (CSCL nodes vs DOT ramps)")
    ax.legend(loc="upper left", markerscale=8)
    plt.tight_layout()
    plt.savefig(opath("fig05_ada_gap_map.png"), dpi=150)
    plt.close()

    worst = nta[nta["n_intersections"] >= 20].head(15).iloc[::-1]
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.barh(worst["ntaname"].str.slice(0, 40), worst["ramp_coverage_pct"], color="#c0392b")
    ax.set_xlabel(f"% of intersections with >=1 ramp within {RAMP_RADIUS:.0f} ft")
    ax.set_title("Lowest intersection ramp coverage by NTA (>=20 intersections)")
    plt.tight_layout()
    plt.savefig(opath("fig05_worst_ramp_coverage_ntas.png"), dpi=130)
    plt.close()
    print("  wrote fig05_ada_gap_map.png, fig05_worst_ramp_coverage_ntas.png")


if __name__ == "__main__":
    main()
