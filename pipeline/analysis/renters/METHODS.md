# Renter's Map — precompute methods (S7)

**Build:** `build_renters_grid.py` (stages `bbl`, `grid`, `all`).
**CRS for all distance/area math:** EPSG:2263 (NY State Plane Long Island, ftUS).
**Neighbourhood radius:** 400 m = 1312.34 ft. **Populated-test radius:** 300 m = 984.25 ft.
**Grid resolution:** H3 res-10 (avg hexagon area ≈ 0.0150 km², edge ≈ 66 m).

Every score describes **places and infrastructure only**. No demographic / protected-class variable
enters any score — see the fair-housing note at the end.

---

## 0. Cell universe (land cells)

Land cells = the union of the **res-10 children of every res-8 origin cell** in the S4 access grid
(`analysis/access/_cache/origin_cells.parquet`, 1,196 res-8 cells, each derived from ≥1 2020-census-block
centroid). 1,196 × 49 children ⇒ ~58.6 k res-10 cells covering all populated NYC land. Each cell carries
its centroid (`lat`,`lon`) and its EPSG:2263 centroid (`x`,`y` ftUS via `ST_Transform(..., always_xy)`).

> H3 list-returning functions (`cell_to_children`, `grid_disk`) are evaluated with the **Python `h3` lib**
> because the DuckDB h3 community extension throws an internal-null error when unnesting its list results.
> The scalar `h3_latlng_to_cell` (used for binning the point layers, entirely in DuckDB) returns the **same
> integer id** as `h3.str_to_int(h3.latlng_to_cell(...))` — verified exactly — so binned counts join the
> Python-built cell table with no representation drift.

### Neighbour map (the 400 m disk)
For each cell C, candidate neighbours = `h3.grid_disk(C, 5)` (91 cells, a superset of 400 m) intersected
with the land set. Each candidate pair is kept iff the **2263 centroid-to-centroid distance ≤ 1312.34 ft**.
Result: `nbr(cell, ncell, dist_ft)`, ~29 neighbour cells/cell on average. All "within 400 m" aggregates are
`SUM` over `nbr` of a per-cell binned value — a hex-disk approximation of a 400 m circle, exact to
res-10-cell granularity (±~66 m at the boundary), applied **identically to every cell** so citywide
percentiles are consistent.

### Populated flag (honest ranking)
`pop_300m(C)` = Σ block population over land cells whose centroid is within **300 m** of C
(2020 Census P1_001N binned to res-10, rolled up on the `nbr` map filtered to ≤ 984.25 ft).
`populated = pop_300m > 0`. **All citywide percentiles are ranked over populated cells only** — parks,
water, rail yards and other unpopulated cells keep their raw values but get `NULL` percentiles, so a park
next to a highway does not deflate a neighbourhood's noise ranking.

---

## 1. Transit (supply within 400 m + nearest subway)

Source: the **Stop Access Index (SAI)** stop table (`Outputs/NYCPlatform/sai/sai_scores.parquet`,
13,621 MTA bus stops with lat/lon, routes, `trips_am`, and the composite `sai`). Binned to res-10, then
rolled up over `nbr`:

| Grid field | Formula |
|---|---|
| `transit_stops_400m` | Σ SAI stops in the 400 m disk |
| `best_sai_400m` | MAX(`sai`) over those stops — the best-access stop you can walk to |
| `sched_am_trips_400m` | Σ `trips_am` (scheduled AM-peak departures) over those stops |

`nearest_subway_*`: exact 2263 nearest of the 496 `transit_subway_stations` (name, borough, distance ft).
Percentiles: `transit_supply_pctile` (on `sched_am_trips_400m`), `transit_sai_pctile` (on `best_sai_400m`);
higher = more service / better access.

## 2. Quality of life (densities within 400 m, percentile-ranked citywide)

Each layer is binned to res-10 in DuckDB (`h3_latlng_to_cell(lat,lon,10)`) then summed over `nbr`.
Percentiles use `cume_dist()` over **populated** cells; **higher percentile = more of the thing** (raw
direction, not "good/bad" — the frontend supplies the plain-language reading).

| Grid field (raw) | Percentile | Source & filter |
|---|---|---|
| `noise_400m` | `noise_pctile` | 311 `complaint_type LIKE 'Noise%'` (all Noise-* subtypes) |
| `sidewalk311_400m` | `sidewalk311_pctile` | 311 `complaint_type IN (Sidewalk Condition, DEP Sidewalk Condition, Curb Condition, Root/Sewer/Sidewalk Condition)` |
| `rodent_fail_rate` = `rodent_fail_400m / rodent_insp_400m` | `rodent_fail_pctile` | DOHMH rodent inspections; failure = `result LIKE 'Failed%'`. Rate is NULL (unranked) where 0 inspections. |
| `ped_crash_400m` | `ped_crash_pctile` | MV crashes with `number_of_pedestrians_injured>0 OR ..._killed>0` |
| `trees_400m` | `trees_pctile` | 2015 Street Tree Census, `status='Alive'` |
| `sidewalk_full_share` = `len_full / len_total` | `sidewalk_cov_pctile` | DOT planimetric sidewalk coverage classes joined to CSCL centerline geometry; `len_full` = length of `both_sides` segments, `len_none` = `none` segments, within 400 m. Higher share = better coverage. `sidewalk_none_share` also stored (the no-sidewalk signal). |

Rodent is a true **rate** (fails ÷ inspections) not a raw count, so a heavily-inspected block isn't
penalised for being inspected. Sidewalk coverage is a **length share** of nearby street segments.

## 3. Flood flags (point-in-polygon on the cell centroid)

- `flood_sw_moderate` / `flood_sw_extreme` — `ST_Intersects(cell_pt_2263, stormwater_part)`
  for `scenario='moderate_current'` (2.13 in/hr, current sea level) / `extreme_2080` (3.66 in/hr, 2080 SLR).
- `flood_firm_sfha` / `firm_zone` — intersects a FEMA NFHL **Special Flood Hazard Area** (`SFHA_TF='T'`);
  `firm_zone` = the FLD_ZONE string (AE, VE, A…). Non-SFHA Zone-X is **not** flagged.

> **Implementation (performance):** `geo_flood_stormwater` stores each scenario as a single dissolved
> citywide **OGC-invalid MultiPolygon** (7 k–98 k rings); a raw `ST_Intersects` join of 58 k points
> against it is catastrophic (hours / crash). The flood stage first `ST_Dump`s the stormwater layer into
> **170,973 individual parts** and the SFHA FIRM layer into 6,562 parts (~1.4 s), which lets DuckDB
> bbox-prune the point-in-polygon join — all 58,604 cells in ~9 s. Actual flagged cells:
> stormwater-moderate 753, stormwater-extreme 6,287, FEMA-SFHA 9,054.

## Build (resumable, checkpointed stages)

The build is split into foreground-safe stages, each writing a checkpoint parquet under
`Outputs/NYCPlatform/renters/_stage/` so a killed run resumes without recomputation:
`cells` (→ cells/nbr) → `base` (populated + transit + subway + jobs) → `qol` (giant point layers) →
`flood` → `assemble` (join + percentiles → `renters_grid.parquet`). Typical timings: cells 8 s,
base 13 s, qol 3 s, flood 9 s, assemble <1 s. Final grid = **58,604 cells, 46,702 populated**.

## 4. 45-minute 8am job access

Each cell inherits its **res-8 parent** cell's precomputed reachability from the S4 OpenTripPlanner grid
(`analysis/access/isochrone_grid_45min.parquet`): `jobs_45min` (LEHD-WAC jobs reachable by WALK+TRANSIT
in 45 min departing weekday 8am) and `jobs_45min_pct` (share of all NYC jobs). Percentile
`jobs_pctile` over populated cells. The res-8 polygon (`geom_wkt`) is also the **approximate-isochrone
fallback** the backend serves when live OTP is unreachable.

---

## 1b. Per-BBL building aggregates (join key = 10-digit NYC BBL string)

Written to `Outputs/NYCPlatform/renters/`:

- **`hpd_open_violations_by_bbl.parquet`** — HPD violations with `violationstatus='Open'`, counted per BBL
  and split by class (`open_class_a/b/c/i`; A=non-hazardous, B=hazardous, C=immediately hazardous,
  I=informational) + `open_total`.
- **`dob_permits_5y_by_bbl.parquet`** — DOB permit filings per BBL with effective date
  `coalesce(filing_date, issuance_date, pre__filing_date, latest_action_date)` in the **last 5 years**
  (`permits_5y`, `last_permit_date`).
- **`landlord_portfolio_by_bbl.parquet`** — ownership **proxy** (documented approximation): from HPD
  registration **contacts** we take each registration's head-officer / owner contact, normalise an
  `owner_key = UPPER(owner name) | business house-number + street + zip`, count that owner's **distinct
  buildings**, and give each BBL its registration-owner's `portfolio_buildings` (+ `owner_name`,
  `owner_key`). This is a *same-registration-contact* grouping, **not** a legal beneficial-ownership
  determination — shell entities and address variants can split or merge true portfolios.

BBL construction: HPD violations already carry a 10-digit `bbl`; registrations build it as
`boroid || lpad(block,5,'0') || lpad(lot,4,'0')`; PLUTO joins via `CAST(BBL AS BIGINT)::VARCHAR`.

---

## Fair-housing / no-demographics guarantee

The score inputs are, exhaustively: transit stops & schedules, subway locations, 311 complaint locations,
rodent inspections, vehicle crashes, street trees, sidewalk geometry, flood polygons, job-reachability
(LEHD workplace counts), and building/permit/registration records. **None** references resident race,
national origin, religion, sex, family status, disability, age, or household income. Median-income and
population appear only as the S4 job-access denominator and the populated-cell mask — never as a score —
and are not surfaced per location. The profile describes a place, not the people in it.
