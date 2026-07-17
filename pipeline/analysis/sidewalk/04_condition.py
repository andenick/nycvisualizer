"""B5.1(4) — Sidewalk condition overlay: 311 complaints + DOT violations + tree damage.

Signals:
  - 311 sidewalk/curb CONDITION complaints (qol_sr311_sidewalk excluding
    'Noise - Street/Sidewalk', which is 81% of the view and is not a condition
    signal). State-plane x/y (EPSG:2263) -> point-in-NTA + point-in-CDTA.
  - DOT sidewalk violations (313,297): no geometry and `bblid` is an internal id
    (NOT a BBL — 0% PLUTO join). Borough is decoded from the first digit of
    `onfrtocode` (NYC street codes: boro+5-digit), falling back to the contract
    suffix letter (M/X/K/Q/S). borough + `cb` => community district => CDTA.
  - Tree sidewalk-damage flags (2015 Street Tree Census `sidewalk` col),
    x_sp/y_sp (2263) -> point-in-NTA/CDTA; share of rated trees with Damage.
Normalization: complaints/violations per sidewalk-EDGE-mile, where edge-miles =
segment length x (has_left + has_right) from 01_coverage_segments.parquet,
segments assigned to NTA/CDTA by centerline centroid.
Composite condition index (CDTA): mean of z-scores of the three signals.
Validation: cross-CD Pearson r between remote 311 density and DOT field-found
violation density; plus the violation->repair pipeline overlap via bblid.
"""
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from _common import connect, write_outputs, opath

BOROLETTER = {"M": "1", "X": "2", "K": "3", "Q": "4", "S": "5"}
BORONAME_TO_PREFIX = {"MANHATTAN": "MN", "BRONX": "BX", "BROOKLYN": "BK",
                      "QUEENS": "QN", "STATEN ISLAND": "SI"}
DIGIT_TO_PREFIX = {"1": "MN", "2": "BX", "3": "BK", "4": "QN", "5": "SI"}


def main():
    c = connect()

    # ---------- sidewalk edge-miles per NTA / CDTA ----------
    segpq = opath("01_coverage_segments.parquet").replace("\\", "/")
    c.execute(f"CREATE TEMP VIEW seg01 AS SELECT * FROM read_parquet('{segpq}')")
    segnta = c.execute("""
        WITH segc AS (
          SELECT s.PHYSICALID, s.seg_len_ft, s.has_left, s.has_right,
                 ST_Centroid(g.geom_2263) AS cp
          FROM seg01 s JOIN geo_cscl g USING (PHYSICALID))
        SELECT n.nta2020, n.ntaname, n.cdta2020, n.boroname,
               SUM(s.seg_len_ft * (s.has_left + s.has_right)) / 5280.0 AS edge_mi,
               SUM(s.seg_len_ft) / 5280.0 AS centerline_mi
        FROM segc s JOIN pop_ntas n ON ST_Within(s.cp, n.geom_2263)
        GROUP BY 1,2,3,4""").df()
    cdta_mi = segnta.groupby("cdta2020")["edge_mi"].sum().reset_index()

    # ---------- 311 condition complaints ----------
    c311 = c.execute("""
        SELECT TRY_CAST(x_coordinate_state_plane AS DOUBLE) x,
               TRY_CAST(y_coordinate_state_plane AS DOUBLE) y,
               complaint_type, community_board
        FROM qol_sr311_sidewalk
        WHERE complaint_type != 'Noise - Street/Sidewalk'""").df()
    n_all = len(c311)
    c311 = c311.dropna(subset=["x", "y"])
    print(f"311 condition complaints: {n_all:,} total, {len(c311):,} with x/y "
          f"({100*len(c311)/n_all:.1f}%)")
    c.register("c311", c311)
    nta311 = c.execute("""
        SELECT n.nta2020, count(*) AS complaints_311
        FROM c311 p JOIN pop_ntas n ON ST_Within(ST_Point(p.x, p.y), n.geom_2263)
        GROUP BY 1""").df()
    # CDTA via community_board string ('01 QUEENS')
    cb = c311["community_board"].str.extract(r"^(\d+)\s+(.*)$")
    c311["cdta2020"] = cb[1].str.strip().str.upper().map(BORONAME_TO_PREFIX) + \
        cb[0].str.zfill(2)
    cd311 = (c311.dropna(subset=["cdta2020"]).groupby("cdta2020")
             .size().rename("complaints_311").reset_index())

    # ---------- DOT violations -> CD ----------
    viol = c.execute("""
        SELECT onfrtocode, contract, cb FROM sidewalk_violations""").df()
    boro_digit = viol["onfrtocode"].str[0].where(
        viol["onfrtocode"].str[0].isin(list("12345")))
    fallback = viol["contract"].str.extract(r"([MXKQS])(?:CO)?$")[0].map(BOROLETTER)
    viol["boro_digit"] = boro_digit.fillna(fallback)
    viol["cdta2020"] = viol["boro_digit"].map(DIGIT_TO_PREFIX) + \
        viol["cb"].str.extract(r"(\d+)")[0].str.zfill(2)
    n_geo = viol["cdta2020"].notna().sum()
    print(f"violations geolocated to CD: {n_geo:,}/{len(viol):,} "
          f"({100*n_geo/len(viol):.1f}%)")
    cdviol = (viol.dropna(subset=["cdta2020"]).groupby("cdta2020")
              .size().rename("violations_dot").reset_index())

    # ---------- tree damage ----------
    trees = c.execute("""
        SELECT x_sp x, y_sp y, sidewalk FROM qol_trees
        WHERE sidewalk IN ('Damage','NoDamage') AND x_sp IS NOT NULL""").df()
    c.register("trees", trees)
    ntatree = c.execute("""
        SELECT n.nta2020,
               count(*) AS trees_rated,
               SUM(CASE WHEN p.sidewalk='Damage' THEN 1 ELSE 0 END) AS trees_damage
        FROM trees p JOIN pop_ntas n ON ST_Within(ST_Point(p.x, p.y), n.geom_2263)
        GROUP BY 1""").df()
    cdtree = c.execute("""
        SELECT d.cdta2020,
               count(*) AS trees_rated,
               SUM(CASE WHEN p.sidewalk='Damage' THEN 1 ELSE 0 END) AS trees_damage
        FROM trees p JOIN pop_cdtas d ON ST_Within(ST_Point(p.x, p.y), d.geom_2263)
        GROUP BY 1""").df()

    # ---------- NTA table (311 + trees; violations not NTA-resolvable) ----------
    nta = (segnta.merge(nta311, on="nta2020", how="left")
                 .merge(ntatree, on="nta2020", how="left"))
    nta["complaints_311"] = nta["complaints_311"].fillna(0).astype(int)
    nta["c311_per_edge_mi"] = nta["complaints_311"] / nta["edge_mi"].replace(0, np.nan)
    nta["tree_damage_pct"] = 100 * nta["trees_damage"] / nta["trees_rated"].replace(0, np.nan)
    nta = nta.round(3)

    # ---------- CDTA table + composite ----------
    cd = (cdta_mi.merge(cd311, on="cdta2020", how="left")
                 .merge(cdviol, on="cdta2020", how="left")
                 .merge(cdtree, on="cdta2020", how="left"))
    cd = cd[cd["cdta2020"].str.match(r"^(MN|BX|BK|QN|SI)\d\d$", na=False)]
    for col in ["complaints_311", "violations_dot"]:
        cd[col] = cd[col].fillna(0).astype(int)
    cd["c311_per_edge_mi"] = cd["complaints_311"] / cd["edge_mi"].replace(0, np.nan)
    cd["viol_per_edge_mi"] = cd["violations_dot"] / cd["edge_mi"].replace(0, np.nan)
    cd["tree_damage_pct"] = 100 * cd["trees_damage"] / cd["trees_rated"].replace(0, np.nan)

    def z(s):
        return (s - s.mean()) / s.std()
    cd["condition_z"] = pd.concat(
        [z(cd["c311_per_edge_mi"]), z(cd["viol_per_edge_mi"]),
         z(cd["tree_damage_pct"])], axis=1).mean(axis=1)
    cd = cd.sort_values("condition_z", ascending=False).round(3)

    # ---------- validation: remote 311 vs DOT field violations ----------
    v = cd.dropna(subset=["c311_per_edge_mi", "viol_per_edge_mi"])
    r_val = np.corrcoef(v["c311_per_edge_mi"], v["viol_per_edge_mi"])[0, 1]
    r_rank = v["c311_per_edge_mi"].corr(v["viol_per_edge_mi"], method="spearman")
    print(f"validation across {len(v)} CDs: pearson r(311, DOT violations) = "
          f"{r_val:.3f}, spearman = {r_rank:.3f}")
    # violation -> repair pipeline via shared internal bblid
    n_v, n_rep = c.execute("""
        SELECT count(DISTINCT v.bblid),
               count(DISTINCT CASE WHEN b.bblid IS NOT NULL THEN v.bblid END)
        FROM sidewalk_violations v LEFT JOIN sidewalk_built b USING (bblid)""").fetchone()
    print(f"violation properties with a later built/repair record: "
          f"{n_rep:,}/{n_v:,} ({100*n_rep/n_v:.1f}%)")
    valdf = pd.DataFrame([
        {"metric": "pearson_r_cd(c311_density, dot_violation_density)", "value": round(r_val, 3)},
        {"metric": "spearman_cd", "value": round(r_rank, 3)},
        {"metric": "n_community_districts", "value": len(v)},
        {"metric": "violation_bblids_total", "value": n_v},
        {"metric": "violation_bblids_with_repair_record", "value": n_rep},
        {"metric": "repair_pipeline_pct", "value": round(100*n_rep/n_v, 1)}])

    write_outputs(nta, "04_condition_nta", sheet="nta",
                  extra_sheets={"validation": valdf})
    write_outputs(cd, "04_condition_cdta", sheet="cdta",
                  extra_sheets={"validation": valdf})

    # ---------- figures ----------
    fig, ax = plt.subplots(figsize=(8, 6))
    ax.scatter(v["c311_per_edge_mi"], v["viol_per_edge_mi"], s=25, alpha=.6,
               color="#4363d8")
    ax.set_xlabel("311 sidewalk-condition complaints per sidewalk-edge-mile")
    ax.set_ylabel("DOT sidewalk violations per sidewalk-edge-mile")
    ax.set_title(f"Remote (311) vs field (DOT) condition signal by community "
                 f"district (r={r_val:.2f})")
    plt.tight_layout()
    plt.savefig(opath("fig04_311_vs_dot_validation.png"), dpi=130)
    plt.close()

    worst = cd.head(15).iloc[::-1]
    fig, ax = plt.subplots(figsize=(9, 6))
    ax.barh(worst["cdta2020"], worst["condition_z"], color="#c0392b")
    ax.set_xlabel("Composite condition z-score (higher = worse)")
    ax.set_title("Worst-condition community districts (311 + DOT violations + tree damage)")
    plt.tight_layout()
    plt.savefig(opath("fig04_worst_condition_cds.png"), dpi=130)
    plt.close()

    top = nta.dropna(subset=["c311_per_edge_mi"]).nlargest(15, "c311_per_edge_mi").iloc[::-1]
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.barh(top["ntaname"].str.slice(0, 40), top["c311_per_edge_mi"], color="#e6a817")
    ax.set_xlabel("311 sidewalk-condition complaints per sidewalk-edge-mile (2010->)")
    ax.set_title("Highest 311 sidewalk-complaint density by NTA")
    plt.tight_layout()
    plt.savefig(opath("fig04_311_density_top_ntas.png"), dpi=130)
    plt.close()
    print("  wrote fig04_311_vs_dot_validation.png, fig04_worst_condition_cds.png, "
          "fig04_311_density_top_ntas.png")


if __name__ == "__main__":
    main()
