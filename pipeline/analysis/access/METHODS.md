# Transit Access & Isochrones — Methods

Spoke **S4** of the nycvisualizer platform: an OpenTripPlanner routing engine, a
live isochrone API, a precomputed reachability grid, and an income-decile access-equity
analysis. Everything here is **network-based** (real street + transit routing), not
straight-line/Euclidean — so the usual "as-the-crow-flies overstates access" caveat
does **not** apply.

## 1. Routing engine (OpenTripPlanner)

| Item | Value |
|------|-------|
| Engine | OpenTripPlanner (OTP) **2.5.0** (`otp-2.5.0-shaded.jar`, Java 21 / eclipse-temurin:21-jre) |
| Why 2.5.0 (not 2.9/2.10) | The isochrone sandbox (`ext.traveltime`, feature `SandboxAPITravelTime`, endpoint `/otp/traveltime/isochrone`) is the mechanism we need. It was **removed in OTP 2.6.0**. 2.5.0 is the last release that ships it. The `opentripplanner/opentripplanner:latest` Docker image is a 2.10.0-SNAPSHOT dev build and has no isochrone endpoint. |
| Host | Homelab box (HP EliteDesk 800 G5, 6-core i5-9500T, 30 GiB RAM), internal only |
| Serving container | `nycvis-otp` on the `homelab_default` docker network, `--load --serve`, `-Xmx3g`, `restart: unless-stopped`. **No host port, no public hostname** — only our backend (same network) or an ssh-tunnel reaches it. |
| Feature flag | `otp-config.json`: `{"otpFeatures":{"SandboxAPITravelTime":true}}` |

### Graph inputs

- **OSM street network**: Geofabrik `new-york-latest.osm.pbf` (~470 MB, full NY state),
  clipped with `osmium extract` to the NYC bbox `-74.30,40.47,-73.68,40.93`
  (→ ~101 MB `nyc.osm.pbf`).
- **GTFS transit feeds** (city modes only — v1 graph):
  - Subway (supplemented feed, includes SIR / Staten Island Railway)
  - Bus: Bronx, Brooklyn, Manhattan, Queens, Staten Island, MTA Bus Company (6 feeds)
  - NYC Ferry
  - **Excluded from the v1 graph: LIRR and Metro-North.** These are commuter rail
    reaching outside the five boroughs; excluding them keeps the graph "city modes"
    and avoids implying suburban commuter access we did not model. (Their GTFS is
    on-disk and can be added in a v2 graph.)
- **Router defaults** (`router-config.json`): `walkSpeed = 1.33 m/s` (OTP default,
  ~3.0 mph), `transferSlack = 2m`. **No fares** modeled (walk+transit time only).

### Build

`--build --save` with `-Xmx6g`. Street graph ~446k edges; graph serialized to
`graph.obj` (~0.37 GB). See the return note for the exact build time / size of the
final run.

## 2. Live isochrone API

Backend module `site/backend/app/isochrone.py`, endpoint:

```
GET /api/isochrone?lat=<>&lon=<>&minutes=30|45|60&depart=weekday_8am|noon|evening
```

- Snaps the origin to an **H3 res-9 cell** (~0.1 km² ; edge ~174 m) so nearby requests
  share a cache entry; the query is issued from the snapped cell centroid.
- Calls OTP `/otp/traveltime/isochrone` (`modes=WALK,TRANSIT`, `arriveBy=false`,
  `cutoff=<minutes>m`) over the internal network (`OTP_URL`, default
  `http://nycvis-otp:8080`); returns the GeoJSON `FeatureCollection` of polygons.
- **Departure windows** anchor to the next weekday (default `2026-07-22`, a Wednesday,
  overridable via `ISOCHRONE_DEPART_DATE`) at `08:00 / 12:00 / 18:00` America/New_York (EDT, `-04:00`).
- **Cache**: two-tier — in-process LRU (512 entries) over an on-disk JSON cache keyed on
  `sha1(h3_res9 | minutes | depart | date)`.
- **Honesty contract**: if OTP is unreachable or errors, the endpoint returns **HTTP 503**
  with a plain message. It **never** returns an estimated/interpolated polygon.

## 3. Precomputed reachability grid (`isochrone_grid_45min.parquet`)

The fallback path and the equity input.

- **Origin grid**: every **H3 res-8 cell** (~0.7 km²; edge ~461 m) whose interior
  contains ≥1 NYC census-block centroid → **1,196 land cells**.
- For each origin-cell centroid: one **45-min, weekday-08:00, WALK+TRANSIT** isochrone
  from box OTP. The polygon is converted to its covered set of **H3 res-9 cells**
  (`h3.geo_to_cells`), and **reachable jobs** = Σ LODES WAC `C000` over NYC census
  blocks whose res-9 cell is in that set.
- The driver is **serial and resumable**: each cell is checkpointed
  (`_cache/grid_checkpoint.parquet`); a cell whose OTP query fails is recorded
  `status=error` and retried on the next run (never fabricated).
- Columns: `res8, lat, lon, jobs_reachable, n_reach_res9, geom_wkt (isochrone polygon),
  jobs_reachable_pct`.

### Jobs-accessibility table (`jobs_accessibility_block.parquet`)

Per NYC census block: the block inherits the reachable-jobs of the res-8 origin cell that
contains its centroid, plus `frequent_transit_access`, block-group median income, and
population. One row per block (37,588).

### Frequent-transit-access flag

A block is flagged if a **frequent AM-peak stop** lies within ~400 m. A stop is
"frequent" if it has **≥8 scheduled departures in the 07:00–09:00 window** (≈ a vehicle
every ≤15 min — the "turn-up-and-go" combined-frequency threshold, counting all
routes/directions serving the stop), from the parsed `transit_gtfs_stop_times`. Trips
whose `trip_id` carries a Saturday/Sunday/Weekend token are excluded to approximate a
weekday. Proximity is done in H3: each frequent stop marks its res-9 cell + a k=2 ring
(~≤430 m); a block is flagged if its res-9 cell is in that set.

## 4. Access-equity (`access_equity.parquet` / `.xlsx`)

- Each NYC block carries: reachable-jobs (≤45 min, wk-08:00), block-group **median
  household income** (ACS 2023 `B19013_001E`; `-666666666` sentinel → null), and
  **population** (block-level where available, else equal weight).
- Blocks are sorted by income and split into **population-weighted deciles** (D1 = lowest
  income, D10 = highest).
- Per decile: population-weighted mean jobs reachable ≤45 min, that as a % of all NYC
  jobs, and the frequent-transit-access population share.

## Caveats (read before citing)

1. **Single departure window in the grid** — the precomputed grid uses weekday **08:00**
   only. The live API supports noon/evening; reachability is materially depart-time
   sensitive (evening/late service is sparser). The grid is an AM-peak snapshot.
2. **Walk speed** fixed at the OTP default 1.33 m/s; no per-person mobility differences.
3. **No fares / no fare-based transfer limits** — purely travel-time reachability.
4. **Jobs = NYC census-block jobs only.** The graph is clipped to the NYC bbox and only
   NYC block geometries are used, so jobs in NJ / Westchester / Long Island reachable
   within 45 min are **not** counted. This understates total reachable jobs for
   near-border origins but is consistent citywide.
5. **LIRR / Metro-North excluded** from the v1 graph (city modes only).
6. **res-8 origin granularity**: blocks inherit their ~0.7 km² origin cell's isochrone;
   sub-cell variation within a cell is not resolved.
7. **Frequent-transit flag** uses combined stop frequency (any vehicle ≤15 min), not
   per-route headway, and a static-schedule AM window rather than a full calendar join.
