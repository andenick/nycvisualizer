# B5.1 Sidewalk Coverage Analysis — Methods

**Suite:** `Technical/NYCPlatform/analysis/sidewalk/01..05_*.py` · **Outputs:** `Projects/Jane/Outputs/NYCPlatform/sidewalk/`
**Engine:** DuckDB 1.4.0 + `spatial`, read-only against `Technical/NYCPlatform/db/jane_geo.duckdb`
**CRS discipline:** every measurement (`ST_Area`, `ST_Length`, `ST_Perimeter`, buffers, distances) uses `geom_2263` — EPSG:2263, NY State Plane Long Island, **US survey feet**. No measurement is ever taken in 4326.

## Universe definition (all scripts)

Street segments = CSCL (`geo_cscl`, DCP `inkn-q76z`) filtered to `RW_TYPE='1'` (ordinary roadway; excludes highways, bridges, tunnels, paths) **and** `NONPED IS NULL` (excludes `V` vehicle-only and `D` non-pedestrian-designated segments): **96,553 segments** citywide. Sidewalk geometry = planimetric sidewalk polygons (`geo_sidewalk_polys`, `52n9-sdep`; 50,865 merged MULTIPOLYGONs).

## 01 — Coverage classes (`none / one_side / both_sides`)

1. Each segment is buffered by `(street_width/2 + 18 ft)` (street width from CSCL `Street Width`; default 30 ft when null/0 — 8,610 segments). 18 ft of reach beyond the curb line captures the sidewalk band without crossing into the next block's sidewalk on typical streets.
2. Every sidewalk polygon intersecting the buffer is assigned to the segment's LEFT or RIGHT via a cross-product side test: the sign of `(P1−P0) × (C−P0)` where P0/P1 are the merged centerline's endpoints and C is the **nearest point of the polygon to the centerline** (`ST_EndPoint(ST_ShortestLine(seg, poly))`).
3. `both_sides` = sidewalk found on both signs; `one_side` = exactly one; `none` = no polygon within reach.

**Caveats:** (a) The side test uses the segment's straight chord for orientation; on strongly curved segments a polygon near an inflection can be side-misassigned — this can flip `one_side`↔`both_sides` on a small number of curved segments, it cannot create coverage where none exists. (b) The reach band at intersections can pick up the cross-street's sidewalk corner; corner polygons are shared geometry, so this inflates `one_side`→`both_sides` only when a corner quadrant wraps. (c) Planimetric vintage: the sidewalk layer derives from the NYC 2022 aerial flight; CSCL is continuously updated — new streets may show `none` spuriously.

## 02 — Width derivation (approximation; cite Meli Harvey 2020)

Reference method: sidewalkwidths.nyc (Meli Harvey, 2020; `github.com/meliharvey/sidewalkwidths-nyc`) computes a true **medial axis** (skeleton) of each sidewalk polygon and measures clearance along it. We deliberately use a cheaper proxy and validate it:

- **Proxy:** `w = 2·Area/Perimeter` per polygon. For a corridor of width W (Area≈WL, Perimeter≈2L) this recovers W exactly; it is the right first-order statistic for strip-like sidewalk geometry.
- **Per-segment width** = median (and min, p90) of the proxies of polygons in the segment's search band (same band as 01), with proxies outside 2–120 ft discarded as non-corridor artifacts.
- **Validation** (`fig02_width_validation.png`): against a **max-inscribed width** computed by 18-step binary search on the negative buffer (`ST_Buffer(poly, −r)` empty ⇔ 2r > max width) on a 300-polygon reservoir sample (seed 42): Pearson r = **0.47**, median proxy/inscribed ratio = **0.69**.

**Honest limits:** the proxy and the inscribed width measure different things (typical vs widest point), so 0.69 is expected, not an error; but r = 0.47 means per-polygon noise is substantial. The proxy is biased LOW for L-shaped corner-wrapping polygons (perimeter inflated) and unreliable on plaza-like blobs (not corridors at all — Manhattan plazas are the worst case). Treat per-segment medians as a **relative** width signal (borough/NTA comparisons, narrow-vs-wide screening), not as engineering-grade clearance.

## 06 — Medial-axis width (Harvey method; ALTERNATIVE estimate, not promoted)

`06_medial_axis_width.py` implements the **true medial-axis method** from Meli Harvey's *Sidewalk Widths NYC* (2020) on our own planimetric polygons, as the upgrade path flagged in 02. Per polygon: densify the boundary → **scipy Voronoi** → keep Voronoi vertices inside the polygon (the medial axis) → each vertex's distance to the boundary is the maximal-inscribed-circle radius (local half-width) → **typical width = 2 × median half-width**. All math is in EPSG:2263 (US survey feet), so no metre→foot conversion. Widths are aggregated onto CSCL segments with the same buffer band as 01/02. Ran on **50,773 polygons** (~71 s, 12 workers).

**Validation — two independent references (honest r for both):**

- vs **Harvey's own published widths** (`sidewalkwidths_nyc.geojson`, 101 MB): each polygon centroid matched to the nearest Harvey centerline within 25 ft → **Pearson r = 0.727** over **n = 17,895** matched pairs. Central tendency is very close — our median **8.6 ft** vs Harvey's **8.1 ft** (nearer Harvey than the 2A/P proxy's 9.7 ft).
- vs the **02 proxy**: r = **0.937** per polygon, r = **0.943** per CSCL segment.

**Decision — KEEP 2A/P as primary, do NOT promote.** The plan's promotion bar was **r > 0.75 vs Harvey**; the definitive full-population value is **0.727**, so the medial-axis is **not** promoted: the map's width channel (`w`) and the primary width download stay the 2A/P proxy, and the width confidence tier stays **🔵 exploratory**. The medial-axis is shipped as an **alternative estimate** (`06_medial_axis_segments.parquet`, `06_medial_axis_polys.parquet` on the Data page) with this comparison stated openly. Two honest reasons the correlation sits below the bar despite a near-identical median: (1) our planimetric vintage (DCP 2022) differs from Harvey's (NYC 2024 sidewalk dataset), so some polygons genuinely differ; (2) our estimator uses the **median** inscribed radius (robust to corner spurs) where Harvey averages along sampled centerline segments — a defensible difference we did **not** tune away to chase the threshold.

## 03 — Block equity

DCP census-block polygons follow **street centerlines**, so each block polygon contains its own half of the street right-of-way including its sidewalks. Per block: `sidewalk_area = Σ ST_Area(block ∩ sidewalk polys)`; **frontage proxy** = block polygon perimeter (centerline-bounded ⇒ perimeter ≈ street frontage); `coverage_ratio = area/perimeter` (ft of average sidewalk width per frontage foot, both sides combined); population = 2020 Census P1_001N via `pop_block_pop` (GEOID15, 100% join); income = ACS 2023 5-yr B19013 at block group (GEOID12 = first 12 chars of block GEOID; −666666666 → null). NTA assignment by block-centroid point-in-polygon. Quintiles are block-level, population-weighted within quintile.

**Caveats:** shoreline/park-edge blocks have perimeter that is not street frontage (ratio biased low there); Census blocks with pop>0 but no DCP block geometry (396 of 37,984) are excluded by the geometry join; block-group income applied to blocks assumes within-BG homogeneity.

## 04 — Condition overlay

- **311**: `qol_sr311_sidewalk` **excluding `Noise - Street/Sidewalk`** (1,116,022 rows = 81% of the view — a noise signal, not a condition signal; kept out). Remaining 265,213 condition complaints (Sidewalk Condition / Root-Sewer-Sidewalk / Curb Condition / DEP Sidewalk Condition, 2010→): 99.6% carry state-plane x/y (already 2263) → point-in-NTA and CDTA.
- **DOT violations** (`6kbp-uz6m`, 313,297): **no geometry; `bblid` is an internal id, NOT a BBL** (0% join to MapPLUTO). Borough decoded from the first digit of `onfrtocode` (NYC street-code triplet: boro+5-digit ×3), fallback to the contract suffix letter (M/X/K/Q/S); borough + `cb` → community district → CDTA. 96.9% geolocated to CD; **CD is the finest honest geography for violations.**
- **Trees**: 2015 Street Tree Census `sidewalk` flag (Damage/NoDamage; 31,616 unrated excluded), x_sp/y_sp (2263) point-in-polygon. Note vintage: 2015.
- **Normalization:** complaints/violations **per sidewalk-edge-mile**: edge-miles = Σ `seg_len × (has_left + has_right)` from 01, segments assigned to NTA/CDTA by centerline centroid.
- **Composite (CDTA only):** mean of z-scores of the three signals. NTA table carries 311 + trees only.
- **Validation:** cross-CD (n=71 CDTAs incl. joint-interest areas) Pearson r between 311 density and DOT violation density = **0.87** (Spearman 0.88) — the remote signal tracks field inspections tightly. Property-level: 36.3% of violation `bblid`s later appear in `sidewalk_built` repair records.

**Caveats:** 311 density conflates condition with propensity-to-report (demographics-correlated); violation issuance dates span 1930–2028 (data-entry outliers) and are treated as a stock, not a flow; tree-damage flags are 2015-vintage; CD-level violations cannot be pushed to NTA without an allocation assumption (not done).

## 05 — Accessibility (ramps at intersections)

Intersection nodes derived from the CSCL network itself: endpoints of merged pedestrian-roadway segments snapped to a 1-ft grid (CSCL is topologically noded); node **degree ≥ 3** ⇒ intersection (48,717); degree-2 midblock pseudo-nodes (8,323) and degree-1 dead ends (5,215) excluded. Ramp test: ≥ 1 DOT pedestrian ramp (`ufzp-rrqu`, 217,679 points) within **50 ft** of the node. ADA slope screen: `RAMP_RUNNING_SLOPE_TOTAL > 8.33%` fails; values ≥ 100 are sentinels (999 observed) and excluded (212,194 measured).

**Caveats:** 50 ft catches typical corner ramps but slightly under-counts at very wide intersections; a "has ramp" intersection may still lack ramps on *all* corners (corner-level completeness would need corner geometry, e.g. `CornerID` clustering — upgrade path); dead-end/cul-de-sac pedestrian access is out of scope; ramp survey vintage per DOT collection cycles.

## Reproduction

```
cd Technical/NYCPlatform/analysis/sidewalk
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 01_coverage_classes.py   # ~2 min
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 02_width_derivation.py   # ~35 s
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 03_block_equity.py       # ~30 s
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 04_condition.py          # ~1 min (needs 01 output)
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 05_accessibility.py      # ~2 min
```

## Sources

- DCP Planimetric Database (sidewalk `52n9-sdep`, roadbed, curbs — 2022 flight), CSCL `inkn-q76z`, LION.
- DOT: Pedestrian Ramps `ufzp-rrqu`, Sidewalk Management violations `6kbp-uz6m` / built `ugc8-s3f6`, Pedestrian Mobility Plan `fwpa-qxaf`.
- NYC 311 `erm2-nwe9`; 2015 Street Tree Census `uvpi-gqnh`.
- Census 2020 PL blocks + ACS 2023 5-yr (B19013, B01003); DCP 2020 NTAs/CDTAs.
- Harvey, M. (2020). *Sidewalk Widths NYC* — sidewalkwidths.nyc; github.com/meliharvey/sidewalkwidths-nyc (medial-axis method we approximate in 02).
