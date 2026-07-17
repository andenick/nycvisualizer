# Stop Accessibility Index (SAI) — Methods

**Analysis:** B5.2 item 4 (cross-flagship signature) + B5.3 municipal context
**Scripts:** `Technical/NYCPlatform/analysis/sai/01–06_*.py` · **Outputs:** `Outputs/NYCPlatform/sai/`
**Source DB:** `jane_geo.duckdb` (DuckDB 1.4 + spatial) · **Distance/area CRS:** EPSG:2263 (NY State Plane Long Island, ftUS) throughout.
**Generated:** 2026-07-17.

The SAI scores **every one of the 13,621 in-effect NYC local-bus stops** on how walkable, safe, comfortable,
and well-served its immediate pedestrian environment is. No public dataset publishes a per-stop pedestrian-access
index of this kind; this is the site's headline original contribution.

> **Universal honesty caveat.** Every figure traces to a query in these scripts. Where a signal cannot be
> honestly derived from the data (DOT violations, network walksheds, stop-level boardings), that is stated
> plainly below rather than approximated.

---

## 0. Stop universe

`transit_bus_stops` holds 22,951 route×stop×direction rows; **13,621 distinct `stop_id`** are in-effect physical
stops (`in_effect = true` for all). We collapse to one row per `stop_id` (`01_walksheds.py`), keeping: a
representative EPSG:2263 point, `stop_name`, route count, comma-joined route short-names, an SBS flag
(`route_short_name ILIKE '%SBS%'`), and CBD flag. **Borough is assigned by physical location** — the point-in-polygon
containing 2020-Census block's `boroname` — not by route-name prefix, so a stop sits in the borough it is actually in.

## 1. Walkshed — population & jobs served (`01_walksheds.py`)

- **Walkshed = a Euclidean 400 m (1312.34 ftUS) buffer** around the stop point. 400 m ≈ a 5-minute walk, the
  standard transit catchment.
- **⚠ Euclidean, not network.** A straight-line buffer is the *honest baseline* but an *upper bound*: real walking
  follows the street grid and is blocked by rivers, rail cuts, and superblocks. A true network walkshed would
  typically **shrink these catchments ~20–30%**, and the population/jobs figures with them. We publish the
  Euclidean number and label it as a ceiling; a network-walkshed refinement is future work (needs a routable
  sidewalk/street graph).
- **Population within** = area-weighted apportionment of 2020-Census block population:
  `pop_400m = Σ_blocks [ block_pop × area(buffer ∩ block) / area(block) ]`, using `pop_census_blocks.geom_2263`
  ∩ the buffer and `pop_block_pop.total_pop`. A bbox pre-filter makes the spatial join a fast range join before
  the exact `ST_Intersection`.
- **Jobs within** = the same apportionment applied to **LODES8 2023 WAC** total jobs (`pop_lodes_wac.C000`,
  joined `w_geocode = block geoid`). Jobs are a workplace-density proxy for non-residential trip demand.

## 2. Stop environment (`02_stop_environment.py`)

Point-layer counts use `scipy.cKDTree` radius queries (exact Euclidean in ftUS — fast and index-backed); polygon
area uses DuckDB `ST_Intersection` with a bbox pre-filter.

| Field | Definition | Source |
|---|---|---|
| `sidewalk_sqft_400m` | planimetric sidewalk-polygon area inside the 400 m walkshed | `geo_sidewalk_polys` |
| `sidewalk_sqft_100ft` | sidewalk area within 100 ft (immediate) | `geo_sidewalk_polys` |
| `ramps_150ft` | pedestrian ramps within 150 ft (ADA access at nearby corners) | `geo_ramps` |
| `shelter_100ft` | bus-stop shelters within 100 ft (≥1 ⇒ sheltered) | `geo_shelters` |
| `seats_250ft` | City benches + Seating-Locations assets within 250 ft | `geo_benches` + `geo_seating` |
| `complaints_400m` | 311 sidewalk/curb-condition service requests (2020+) within 400 m | `qol_sr311_sidewalk` |
| `ped_crashes_400m` | MVC crashes injuring/killing a pedestrian (2020+) within 400 m | `qol_crashes` |

- **311 condition signal:** `qol_sr311_sidewalk` (Sidewalk/Curb Condition families). We use **all statuses from
  2020 on**, not just "open": only ~12.7k of 1.37M citywide are still open — too sparse for a per-stop signal —
  so cumulative complaint density (99.3% geocoded via 2263 state-plane coords) is the honest condition proxy.
  Higher complaints ⇒ worse condition ⇒ the subscore is **inverted**.
- **Pedestrian crashes:** crash-level flags (`number_of_pedestrians_injured/killed > 0`) carry the point geometry,
  so a crash-level join is used (person-level `qol_crashes_persons` has no geometry and adds nothing joinable here).
  Window 2020+ aligns with the 311 window. 51,186 ped-injury crashes with valid NYC geometry.
- **⚠ DOT sidewalk violations excluded from the per-stop score.** `sidewalk_violations` (6kbp-uz6m) has **no
  geometry and no usable BBL** (its `bblid` is a 6-digit internal id, not a 10-digit PLUTO BBL), so it cannot be
  attributed at stop granularity without geocoding street names. Rather than fabricate a location, we drop it from
  the SAI and report violations only at **borough / community-board** level as context (`05_context` set).
  The 311 layer carries the spatially-precise condition signal.

## 3. Service intensity (`03_service.py`)

Stop-level **scheduled supply is available from GTFS** `transit_gtfs_stop_times` (unlike the APC ridership giant,
which is route×hour with **no stop column** — so *boardings* are not available per stop; see §5).

- Windows: **AM peak 07:00–09:59 (3 h), midday 10:00–15:59 (6 h), evening 19:00–21:59 (3 h)**; `tph_* = trips ÷ window hours`.
- **Weekday-variant de-duplication (critical):** MTA GTFS carries several weekday `service_id`s per route (base vs
  school-open "SDon" picks, date-range picks), each representing *one* weekday's schedule; counting all of them
  double-counts service (observed 2× inflation on BX19, 4 variants at a sample stop). We therefore pick, **per
  (feed, route_id), the single weekday `service_id` with the most trips** as the representative weekday schedule and
  count only its trips. A stop's total sums across the routes serving it (distinct physical buses). After-midnight
  GTFS hours ≥24 are wrapped mod 24.
- 13,370 / 13,621 stops (98.2%) match a GTFS bus `stop_id`; the 251 unmatched get service = 0 (flagged `gtfs_matched=false`).

## 4. Composite index (`04_sai.py`)

Seven subscores, each **percentile-ranked 0–100 across all 13,621 stops** (percentile, not min-max: raw inputs are
heavily right-skewed and min-max would be dominated by a handful of Midtown outliers). Inverted subscores flip so
**higher = better access** everywhere.

| Subscore | Raw input | Direction |
|---|---|---|
| `walkshed_population` | `pop_400m` | higher better |
| `sidewalk_provision` | `sidewalk_sqft_400m` | higher better |
| `ada_ramp_access` | `ramps_150ft` | higher better |
| `comfort` | `shelter_100ft × 2 + seats_250ft` | higher better |
| `condition` | `complaints_400m` | **inverted** |
| `safety` | `ped_crashes_400m` | **inverted** |
| `service_intensity` | `trips_daytime` (weekday 05–21) | higher better |

**Composite `sai` = weighted mean** with default weights (documented in `sai_weights.json`):

```
walkshed_population 0.25 · sidewalk_provision 0.20 · ada_ramp_access 0.15 ·
comfort 0.10 · condition 0.10 · safety 0.10 · service_intensity 0.10   (Σ = 1.00)
```

Rationale: an *access-equity* reading — how many people the stop serves and whether they can physically walk to it
come first; comfort/condition/safety/service are secondary modifiers.

**Sensitivity:** `sai_equal_weight` uses 1/7 each. The two rank stops almost identically (**Pearson r = 0.85**),
so the borough gradient and the best/worst tails are **not artifacts of the weighting** — see FINDINGS.

**Caveats on the composite.** (a) Subscores are *within-NYC ranks*, so SAI is relative, not absolute — a score of 50
means "typical NYC stop", not "half-accessible". (b) Percentile normalization means the citywide mean of every
subscore is 50 by construction. (c) Amenity layers are **planimetric vintages** (sidewalk/ramp/shelter snapshots),
not continuously updated; a newly built ramp or removed shelter may lag. (d) Ramp *presence* is scored, not ramp
*compliance* (slope/condition fields exist in `geo_ramps` but are not graded here).

## 5. What the SAI deliberately does **not** claim

- **Not boardings-based.** The demand proxy is population + jobs in the walkshed, **not** actual ridership: the
  hourly APC ridership dataset is route×hour with no stop/direction column (recorded in the DB PROVENANCE), so
  stop-level boardings do not exist in this data. SAI measures *access supply and environment*, not realized demand.
- **Not a network walkshed** (see §1) — Euclidean upper bound.
- **Not a violations-weighted condition** (see §2) — 311-only, spatially honest.

## 6. Municipal context (`05_context.py`, B5.3)

- **Population-density gradient:** residents ÷ land-area (`ST_Area(geom_2263)`→sq mi) per 2020 block, with WGS84
  centroids for a graduated map; borough rollup.
- **Subway O-D flows:** `transit_od_matrix` (jsu2-fbtj, 2024) aggregated to top origin→destination station-complex
  pairs by `estimated_average_ridership`, overall and for the 08:00 peak hour.
- **Crash exposure on high-demand corridors:** DOT `ped_mobility_demand` (Rank 1 = highest demand … 5 = lowest) ×
  ped-injury crashes (2020+): ped crashes within 100 ft of each segment, aggregated to an exposure gradient by rank
  and the 50 worst individual segments.

## Reproduce

```
cd Technical/NYCPlatform/analysis/sai
PYTHONIOENCODING=utf-8 python 01_walksheds.py      # ~50 s
PYTHONIOENCODING=utf-8 python 02_stop_environment.py  # ~160 s
PYTHONIOENCODING=utf-8 python 03_service.py        # ~5 s
PYTHONIOENCODING=utf-8 python 04_sai.py            # ~12 s
PYTHONIOENCODING=utf-8 python 05_context.py        # ~150 s
PYTHONIOENCODING=utf-8 python 06_charts.py         # ~15 s
```
