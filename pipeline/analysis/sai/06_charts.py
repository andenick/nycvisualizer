"""06 - SAI + context charts (PNG). Reads the parquet outputs from 01-05; no DB access.

All numbers come straight from the analysis parquets (nothing recomputed/fabricated).
"""
from __future__ import annotations
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import common as C

plt.rcParams.update({"figure.dpi": 130, "font.size": 10, "axes.grid": True,
                     "grid.alpha": 0.3, "axes.axisbelow": True})
BORO_ORDER = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"]
s = pd.read_parquet(C.OUT + "/sai_scores.parquet")
sub = ["walkshed_population", "sidewalk_provision", "ada_ramp_access", "comfort",
       "condition", "safety", "service_intensity"]

# 1. SAI distribution
fig, ax = plt.subplots(figsize=(8, 4.5))
ax.hist(s.sai, bins=50, color="#2c7fb8", edgecolor="white", linewidth=0.3)
ax.axvline(s.sai.median(), color="#d95f02", ls="--", label=f"median {s.sai.median():.1f}")
ax.set_xlabel("Stop Accessibility Index (0-100)"); ax.set_ylabel("bus stops")
ax.set_title("Distribution of the Stop Accessibility Index — 13,621 NYC bus stops"); ax.legend()
C.savefig(fig, "01_sai_distribution"); plt.close(fig)

# 2. SAI by borough boxplot
fig, ax = plt.subplots(figsize=(8, 4.5))
data = [s[s.borough == b].sai.values for b in BORO_ORDER]
bp = ax.boxplot(data, labels=BORO_ORDER, patch_artist=True, showfliers=False)
for p in bp["boxes"]:
    p.set_facecolor("#7fcdbb"); p.set_alpha(0.8)
ax.set_ylabel("SAI"); ax.set_title("SAI by borough (box = IQR, line = median)")
C.savefig(fig, "02_sai_by_borough_box"); plt.close(fig)

# 3. subscore distributions (violin-ish via boxplot)
fig, ax = plt.subplots(figsize=(9, 4.5))
bp = ax.boxplot([s[c].dropna().values for c in sub],
                labels=[c.replace("_", "\n") for c in sub], patch_artist=True, showfliers=False)
for p in bp["boxes"]:
    p.set_facecolor("#c7e9b4")
ax.set_ylabel("subscore (0-100)"); ax.set_title("SAI subscore distributions")
C.savefig(fig, "03_subscore_distributions"); plt.close(fig)

# 4. shelter / ramp / seating coverage by borough
bs = pd.read_parquet(C.OUT + "/sai_borough_summary.parquet").set_index("borough").reindex(BORO_ORDER)
fig, ax = plt.subplots(figsize=(8.5, 4.5))
x = np.arange(len(BORO_ORDER)); w = 0.27
ax.bar(x - w, bs.pct_sheltered, w, label="% sheltered (<=100 ft)", color="#1f78b4")
ax.bar(x, bs.pct_ramp, w, label="% ramp (<=150 ft)", color="#33a02c")
ax.bar(x + w, bs.pct_seating, w, label="% seating (<=250 ft)", color="#ff7f00")
ax.set_xticks(x); ax.set_xticklabels(BORO_ORDER); ax.set_ylabel("% of stops")
ax.set_title("Pedestrian amenity coverage by borough"); ax.legend(fontsize=8)
C.savefig(fig, "04_amenity_coverage_borough"); plt.close(fig)

# 5. all-stops map-ish scatter colored by SAI
fig, ax = plt.subplots(figsize=(7.5, 7.5))
sc = ax.scatter(s.lon, s.lat, c=s.sai, s=4, cmap="RdYlGn", alpha=0.7, linewidths=0)
plt.colorbar(sc, label="SAI"); ax.set_xlabel("lon"); ax.set_ylabel("lat")
ax.set_title("Every NYC bus stop, colored by Stop Accessibility Index"); ax.set_aspect(1.3)
C.savefig(fig, "05_sai_map_all_stops"); plt.close(fig)

# 6. worst-50 map-ish scatter over faint all-stops
fig, ax = plt.subplots(figsize=(7.5, 7.5))
ax.scatter(s.lon, s.lat, s=2, color="#cccccc", alpha=0.5, linewidths=0)
w50 = s.sort_values("sai").head(50)
ax.scatter(w50.lon, w50.lat, s=45, color="#d7191c", edgecolor="black", linewidths=0.4, label="worst 50")
ax.set_title("The 50 lowest-SAI bus stops"); ax.legend(); ax.set_aspect(1.3)
ax.set_xlabel("lon"); ax.set_ylabel("lat")
C.savefig(fig, "06_worst50_map"); plt.close(fig)

# 7. pop served vs SAI
fig, ax = plt.subplots(figsize=(8, 4.5))
ax.scatter(s.pop_400m, s.sai, s=4, alpha=0.25, color="#2c7fb8", linewidths=0)
ax.set_xlabel("residents within 400 m walkshed"); ax.set_ylabel("SAI")
ax.set_title("Walkshed population served vs SAI")
C.savefig(fig, "07_pop_vs_sai"); plt.close(fig)

# 8. AM-peak service intensity distribution
fig, ax = plt.subplots(figsize=(8, 4.5))
ax.hist(np.clip(s.trips_am / 3.0, 0, 40), bins=40, color="#756bb1", edgecolor="white", linewidth=0.3)
ax.set_xlabel("scheduled weekday AM-peak buses/hour (clipped at 40)"); ax.set_ylabel("stops")
ax.set_title("AM-peak (7-10) scheduled service intensity per stop")
C.savefig(fig, "08_service_intensity_hist"); plt.close(fig)

# 9. sensitivity: weighted vs equal-weight SAI
fig, ax = plt.subplots(figsize=(6.5, 6.5))
ax.scatter(s.sai_equal_weight, s.sai, s=4, alpha=0.25, color="#238b45", linewidths=0)
lim = [s.sai.min() - 2, s.sai.max() + 2]
ax.plot(lim, lim, "k--", lw=1, alpha=0.6)
r = np.corrcoef(s.sai, s.sai_equal_weight)[0, 1]
ax.set_xlabel("SAI (equal 1/7 weights)"); ax.set_ylabel("SAI (default weights)")
ax.set_title(f"Weighting sensitivity (r = {r:.3f})")
C.savefig(fig, "09_weight_sensitivity"); plt.close(fig)

# 10. shelter presence: SBS vs non-SBS
fig, ax = plt.subplots(figsize=(6, 4.5))
vals = [(s[s.sbs_flag].shelter_100ft > 0).mean() * 100,
        (s[~s.sbs_flag].shelter_100ft > 0).mean() * 100]
ax.bar(["SBS stops", "local stops"], vals, color=["#e6550d", "#9ecae1"])
for i, v in enumerate(vals):
    ax.text(i, v + 1, f"{v:.1f}%", ha="center")
ax.set_ylabel("% sheltered"); ax.set_title("Shelter coverage: Select Bus Service vs local stops")
C.savefig(fig, "10_shelter_sbs_gap"); plt.close(fig)

# 11. population density gradient (block centroids)
try:
    bd = pd.read_parquet(C.OUT + "/ctx_block_pop_density.parquet")
    bd = bd[bd.pop_density_sqmi > 0]
    fig, ax = plt.subplots(figsize=(7.5, 7.5))
    sc = ax.scatter(bd.lon, bd.lat, c=np.log10(bd.pop_density_sqmi + 1), s=3,
                    cmap="magma", alpha=0.6, linewidths=0)
    cb = plt.colorbar(sc, label="log10 residents / sq mi")
    ax.set_title("Population-density gradient (2020 Census blocks)"); ax.set_aspect(1.3)
    ax.set_xlabel("lon"); ax.set_ylabel("lat")
    C.savefig(fig, "11_pop_density_gradient"); plt.close(fig)
except Exception as e:
    print(f"  [skip 11] {e}")

# 12. PMI demand-rank crash exposure gradient
try:
    grad = pd.read_parquet(C.OUT + "/ctx_pmi_crash_gradient.parquet").sort_values("demand_rank")
    fig, ax = plt.subplots(figsize=(7.5, 4.5))
    ax.bar(grad.demand_rank.astype(str), grad.mean_ped_crashes_per_seg, color="#c51b8a")
    ax.set_xlabel("DOT pedestrian-demand rank (1 = highest demand)")
    ax.set_ylabel("mean ped-injury crashes /segment (<=100 ft, 2020+)")
    ax.set_title("Pedestrian-crash exposure rises with demand rank")
    C.savefig(fig, "12_pmi_crash_gradient"); plt.close(fig)
except Exception as e:
    print(f"  [skip 12] {e}")

print("charts done")
