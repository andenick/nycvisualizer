# `jane_geo.duckdb` — Schema (B4, Pass 1)

**Generated:** 2026-07-17 · **Engine:** DuckDB 1.4.0 + `spatial` · **Canonical CRS for measurement:** EPSG:2263 (NY State Plane Long Island, ftUS)

The database is a **regenerable query layer** over the GeoParquet/Parquet **lake** at
`data/parquet/<category>/<slug>[.parquet | /year=YYYY/]`. The lake is the source of truth
(`convert_lake.py`); the DB is rebuilt from it by `build_db.py`; `doctor.py` is the phase gate.

**Scope (Pass 1):** the four originally-landed raw categories — `ridership`, `population`, `landuse`,
`transit_static` — plus `rt_*` views over the realtime archive. **Pass 2 (2026-07-17)** added the three
remaining categories — `sidewalk_pedestrian`, `street_network`, `qol` — now fully landed and registered
(see the Pass-2 sections at the end of this document). No `category_skipped` entries remain.

## Conventions

- **Provenance columns** — every lake table/view carries `source_dataset_id`, `retrieved_at`,
  `vintage`, copied verbatim from each dataset's `data/raw/**/PROVENANCE.json`. Giants also carry
  these (dictionary-encoded → negligible size).
- **Storage classes**
  - **table** — copied into `jane_geo.duckdb` (small/medium; DB file ≈ 1.8 GB, dominated by the
    two large geo layers).
  - **view_giant** — external Parquet VIEW over hive-partitioned `year=YYYY/` dirs; the 882 M
    giant rows are **never** copied into the DB file.
  - **view_rt** — VIEW over `realtime/archive/<feed>/date=…/hour=…/` parquet (or jsonl for alerts).
- **Geometry** — geo tables store two geometry columns, physically WKB via GeoParquet:
  - `geom_wkb` — geometry in its **source CRS** (unreprojected).
  - `geom_2263` — same geometry reprojected to **EPSG:2263** (via `ST_Transform(…, always_xy:=true)`;
    identity for sources already in 2263). Use this for all `ST_Area`/`ST_Length` math.
  - `geometry_crs` (VARCHAR) — the authoritative **source** CRS string (GeoParquet file-level CRS
    metadata does not distinguish the two geometry columns; `geometry_crs` + the `geom_2263`
    construction contract are canonical).
  Point tables (`transit_bus_stops`, `transit_subway_stations`, `transit_subway_entrances`) derive
  point geometry from their lat/lon columns (source 4326).

---

## `pop_*` — Population & denominators

| Table | Source dataset id | Grain | Key columns | CRS |
|---|---|---|---|---|
| `pop_census_blocks` | Socrata `wmsu-5muw` (2020 Census blocks, NYC) | 1 row / census block (37,588) | `geoid` (15-digit), `bctcb2020`, `ct2020`, `cb2020`, `boroname`, geom | 4326 (+geom_2263) |
| `pop_block_pop` | Census API `2020/dec/pl` P1_001N | 1 row / block (37,984) | `GEOID15` (join key ← `pop_census_blocks.geoid`, 100%), `total_pop`, `P1_001N` | — |
| `pop_bg_acs` | Census API `2023/acs/acs5` | 1 row / block group (6,807) | `GEOID12`, `B01003_001E` (pop), `B19013_001E` (median HH income; −666666666 = Census null, kept verbatim), `B08301_*` (means-of-transport-to-work) | — |
| `pop_tracts` | Socrata `63ge-mke6` (2020 tracts) | 1 row / tract (2,325) | tract id, geom | 4326 (+2263) |
| `pop_ntas` | Socrata `9nt8-h7nd` (2020 NTAs) | 1 row / NTA (262) | NTA code/name, geom | 4326 (+2263) |
| `pop_cdtas` | Socrata `xn3r-zk6y` (2020 CDTAs) | 1 row / CDTA (71) | `cdta2020`, `cdtaname`, geom | 4326 (+2263) |
| `pop_nta_demographics` | Socrata `rnsn-acs2` | 1 row / NTA (197) | NTA code, 2000/2010 population fields | — |
| `pop_lodes_od` | LEHD LODES8 NY 2023 (JT00) | 1 row / (work block × home block × part) (8,529,759) | `w_geocode`, `h_geocode`, `S000`, `part` (main/aux) | — |
| `pop_lodes_rac` | LODES8 NY RAC S000 2023 | 1 row / home block (223,405) | `h_geocode`, `C000`, `CNS*`, … | — |
| `pop_lodes_wac` | LODES8 NY WAC S000 2023 | 1 row / work block (108,030) | `w_geocode`, `C000`, `CNS*`, … | — |
| `pop_lodes_xwalk` | LODES8 NY crosswalk | 1 row / block (288,819) | `tabblk2020` → tract/county/CBSA lookups | — |

## `geo_*` — Land use & reference geometry

| Table | Source dataset id | Grain | Key columns | CRS |
|---|---|---|---|---|
| `geo_pluto_lots` | MapPLUTO 26v1 FGDB (DCP BYTES; Socrata `f888-ni5f`) | 1 row / tax lot (856,614) | `BBL`, `Borough`,`Block`,`Lot`, `LandUse`, `BldgClass`, `ZoneDist1`, `UnitsRes`, `LotArea`, `BldgArea`, geom (native 2263) | **2263** |
| `geo_building_footprints` | Socrata `5zhs-2jue` | 1 row / building (1,082,881) | `bin`, `heightroof`, `cnstrct_yr`, `feat_code`, geom | 4326 (+2263) |
| `geo_tiger_blocks` | TIGER/Line 2024 tabblock20 (5 NYC counties) | 1 row / block (37,984) | `GEOID20`, `COUNTYFP20`, `ALAND20`, geom | 4269 (+2263) |
| `geo_tiger_bg` | TIGER/Line 2024 bg (5 NYC counties) | 1 row / block group (6,807) | `GEOID`, `COUNTYFP`, geom | 4269 (+2263) |
| `geo_tiger_tracts` | TIGER/Line 2024 tract (5 NYC counties) | 1 row / tract (2,327) | `GEOID`, `COUNTYFP`, geom | 4269 (+2263) |
| `geo_bus_lanes` | Socrata `ycrg-ses3` | 1 row / bus-lane segment (4,068) | `Street`, `Boro`, `Lane_Type`, `SBS_Route1`, geom (MULTILINESTRING) | 4326 (+2263) |

*TIGER block/bg/tract layers are 4269-native alternates to the Socrata/PLUTO geometry, filtered to
FIPS 36005/047/061/081/085; useful when a TIGER-keyed join (LODES `*_geocode`, ACS `GEOID`) needs
native block geometry.*

## `transit_*` — GTFS static, stations, ridership & operations

### Static network / stations

| Table | Source dataset id | Grain | Key columns | CRS |
|---|---|---|---|---|
| `transit_gtfs_routes` | GTFS (subway supplemented + 6 bus feeds + ferry/LIRR/MNR) | 1 row / (feed × route) (1,684) | `feed`, `route_id`, `route_short_name`, `route_type` | — |
| `transit_gtfs_trips` | " | 1 row / (feed × trip) (297,224) | `feed`, `trip_id`, `route_id`, `service_id`, `shape_id`, `direction_id` | — |
| `transit_gtfs_stops` | " | 1 row / (feed × stop) (16,116) | `feed`, `stop_id`, `stop_lat`, `stop_lon`, `parent_station` | 4326 (lat/lon) |
| `transit_gtfs_stop_times` | " | 1 row / (feed × trip × stop) (8,722,621) | `feed`, `trip_id`, `stop_id`, `stop_sequence`, `arrival_time`, `departure_time` | — |
| `transit_gtfs_shapes` | " | 1 row / (feed × shape point) (765,955) | `feed`, `shape_id`, `shape_pt_sequence`, `shape_pt_lat/lon` | 4326 (lat/lon) |
| `transit_bus_stops` | Socrata (data.ny.gov) `2ucp-7wg5` | 1 row / (route × stop × direction, in-effect) (22,951) | `route_id`, `stop_id`, `direction`, `latitude`,`longitude`, geom | 4326 (+2263) |
| `transit_subway_stations` | data.ny.gov `39hk-dx4f` | 1 row / GTFS stop (496) | `GTFS Stop ID`→`gtfs_stop_id`, `complex_id`, `daytime_routes`, `ada`, geom | 4326 (+2263) |
| `transit_subway_entrances` | data.ny.gov `i9wp-a4ja` | 1 row / entrance (2,120) | `station_id`, `gtfs_stop_id`, `entrance_type`, geom | 4326 (+2263) |
| `transit_citibike_stations` | Citi Bike GBFS `station_information` | 1 row / dock station (2,459) | `station_id`, `name`, `lat`, `lon`, `capacity` | 4326 (lat/lon) |

*GTFS `feed` values:* `subway` (supplemented feed), `bus_bronx`, `bus_brooklyn`, `bus_manhattan`,
`bus_queens`, `bus_staten_island`, `bus_mta_bus_company`, `ferry`, `lirr`, `mnr`. All GTFS columns
are read as text (`all_varchar`) so heterogeneous per-feed schemas union cleanly under `feed`.

### Ridership & operations (tables)

| Table | Source dataset id | Grain | Key columns | CRS |
|---|---|---|---|---|
| `transit_ace_violations` | data.ny.gov `kh8p-hcbm` | 1 row / ACE violation (5,915,324) | `violation_id`, `bus_route_id`, `violation_type`, `stop_id`, lat/lon | 4326 (lat/lon) |
| `transit_ace_routes` | data.ny.gov `ki2b-sg5y` | 1 row / ACE route (85) | route id, program dates | — |
| `transit_elev_esc` | data.ny.gov `rc78-7x78` | 1 row / (month × equipment) (81,003) | `equipment_code`, `equipment_type`, availability fields | — |
| `transit_daily_ridership` | data.ny.gov `vxuj-8kew` | 1 row / (mode × day) (1,776) | `date`, per-mode ridership | — |

### Ridership giants (external-Parquet VIEWS, hive-partitioned by `year`)

| View | Source dataset id | Grain | Rows | Partitions |
|---|---|---|---|---|
| `transit_ridership_bus_hourly` | `kv7t-n8in` (2020-24) + `gxb3-akrn` (2025→) | route × payment × fare-class × hour | 583,850,304 | year=2020..2026 |
| `transit_ridership_subway_hourly` | `wujg-7c2s` (2020-24) + `5wq4-mkjj` (2025→) | station-complex × fare-class × hour | 162,261,448 | year=2020..2026 |
| `transit_od_matrix` | `jsu2-fbtj` (2024→) | origin-complex → destination-complex × hour | 116,279,069 | year=2024 |
| `transit_segment_speeds` | `58t6-89vi` (2023-24) + `kufs-yh3x` (2025→) | timepoint-segment × hour × DOW | 19,948,689 | year=2023..2026 |

*Note (bus hourly): schema is `transit_timestamp, bus_route, payment_method, fare_class_category,
ridership, transfers` — route × hour APC aggregation, **no stop/direction column** (the plan's
"route×direction×stop×hour" description does not match this dataset; recorded in PROVENANCE).*
*Partitioning is by `year(transit_timestamp)`; a small `year=2026` partition reflects data with
2026 timestamps present in the source extracts.*

## `rt_*` — Realtime archive VIEWS (`realtime/archive/<feed>/date=…/hour=…/`)

Row counts grow while the poller runs (values below are the build-time snapshot). Vehicle-position
views are cast to one canonical schema (`feed, poll_ts, header_ts, vehicle_id, trip_id, route_id,
direction_id, lat, lon, bearing, speed, timestamp, stop_id, current_stop_seq, current_status,
occupancy_status, date, hour`).

| View | Feed(s) | Contents |
|---|---|---|
| `rt_bus_vehicle_positions` | `bus_vehicle_positions` | BusTime GTFS-RT vehicle positions |
| `rt_bus_trip_updates` | `bus_trip_updates` | BusTime TripUpdates (stop-level arrival/departure delays) |
| `rt_subway_positions` | 8 subway feeds (`subway_bdfm/g/jz/l/nqrw/si/gtfs/ace`) | NYCT subway GTFS-RT vehicle positions |
| `rt_rail_positions` | `lirr`, `mnr` | LIRR + Metro-North GTFS-RT positions |
| `rt_ferry_vehicle_positions` | `ferry_vehicle_positions` | NYC Ferry GTFS-RT positions |
| `rt_ferry_trip_updates` | `ferry_trip_updates` | NYC Ferry TripUpdates |
| `rt_citibike_status` | `citibike_station_status` | Citi Bike GBFS live dock status |
| `rt_all_vehicle_positions` | bus+subway+ferry+rail | UNION-ALL of the four position families |
| `rt_bus_alerts` | `bus_alerts` (jsonl) | BusTime service alerts |
| `rt_subway_alerts` | `subway_alerts` (jsonl) | Subway service alerts |

# `jane_geo.duckdb` — Schema (B4, Pass 2 additions)

**Pass 2 (2026-07-17):** the three previously-skipped categories are now **landed and registered** —
`sidewalk_pedestrian`, `street_network`, `qol`. Phase-2 lake footprint: **68 parquet files / 3.69 GiB**
(3 of these are hive-partitioned giant dirs). Same conventions as Pass 1 (provenance columns; two-axis
geometry `geom_wkb` source-CRS + `geom_2263`; giants stay external). Doctor OVERALL PASS, 0 FAIL,
`category_skipped` list now empty.

> **Provenance-id note:** several Socrata datasets export a viz-shell id in `dataset_id` while the real
> data-bearing backing dataset is in `data_id` (roadbed `i36f-5ih7`, sidewalk `52n9-sdep`, benches
> `kuxa-tauh`, seating `esmy-s8q5`, speed limits `5mad-ntua`). `source_dataset_id` records the **backing**
> id (`data_id`) where present.

## `geo_*` (Pass 2) — sidewalk / street reference geometry

All `the_geom` layers are Socrata-reprojected to **EPSG:4326** (WKT); LION + traffic-volume points are
native **EPSG:2263**. Every row carries `geom_wkb` (source CRS) + `geom_2263` + `geometry_crs`.

| Table | Source dataset id | Grain | Geometry | CRS |
|---|---|---|---|---|
| `geo_sidewalk_polys` | `52n9-sdep` (Planimetric Sidewalk) | 1 row / sidewalk polygon (**50,865**) | MULTIPOLYGON | 4326 (+2263) |
| `geo_curbs` | `5xvt-8cbk` (Planimetric Curbs) | 1 row / curb segment (217,662) | MULTILINESTRING | 4326 (+2263) |
| `geo_roadbed` | `i36f-5ih7` (Planimetric Roadbed) | 1 row / roadbed polygon (104,961) | MULTIPOLYGON | 4326 (+2263) |
| `geo_ramps` | `ufzp-rrqu` (Pedestrian Ramps) | 1 row / ramp (217,679) | POINT | 4326 (+2263) |
| `geo_plazas` | `k5k6-6jex` (DOT Pedestrian Plazas) | 1 row / plaza (93) | MULTIPOLYGON | 4326 (+2263) |
| `geo_open_streets` | `uiay-nctu` (Open Streets) | 1 row / open-street seg (391); WKT col `The_Geom` | MULTILINESTRING | 4326 (+2263) |
| `geo_shelters` | `t4f2-8md7` (Bus Stop Shelters) | 1 row / shelter (3,381) | POINT | 4326 (+2263) |
| `geo_benches` | `kuxa-tauh` (City Benches, historical) | 1 row / bench (2,164) | POINT | 4326 (+2263) |
| `geo_seating` | `esmy-s8q5` (Seating Locations) | 1 row / seat asset (3,562) | POINT | 4326 (+2263) |
| `geo_cscl` | `inkn-q76z` (Centerline CSCL) | 1 row / street segment (122,245) | MULTILINESTRING | 4326 (+2263) |
| `geo_bike_routes` | `mzxg-pwib` (Bike Routes) | 1 row / bike seg (28,983) | MULTILINESTRING | 4326 (+2263) |
| `geo_truck_routes` | `jjja-shxy` (Truck Routes) | 1 row / truck seg (32,939) | MULTILINESTRING | 4326 (+2263) |
| `geo_lion` | `2v4z-66xt` (LION File-GDB blob) | 1 row / LION segment (139,674) | LINE, native | **2263** |

## Pass-2 analysis + tabular layers

| Table | Source dataset id | Grain / rows | Notes |
|---|---|---|---|
| `ped_counts_biannual` | `cqsj-cfgu` | 114 count stations | POINT geom; May/Sept AM/PM/MD counts 2007→ |
| `ped_mobility_demand` | `fwpa-qxaf` | 127,277 segments | MULTILINESTRING geom; DOT Pedestrian Mobility Plan demand rank |
| `ped_counts_automated` | `ct66-47at` | **20,704,366** (view_giant) | automated bike/ped sensor counts; hive by `year(timestamp)`; external |
| `sidewalk_violations` | `6kbp-uz6m` | 313,297 | Sidewalk Mgmt violations (no geometry) |
| `sidewalk_built` | `ugc8-s3f6` | 105,990 | Sidewalk Mgmt built/repair records (no geometry) |
| `traffic_volumes` | `7ym2-wayt` | 1,875,154 | Automated Traffic Volume Counts; `WktGeom` POINT in **2263** (+2263) |
| `traffic_volumes_hist` | `btm5-ppia` | 42,756 | Traffic Volume Counts (historical, hourly-wide, no geom) |
| `speed_limits` | `5mad-ntua` | 141,440 | VZV Speed Limits; MULTILINESTRING 4326 (+2263); 4 null-geom records dropped (source 141,444) |
| `parking_signs` | `nfid-uabd` | 440,429 | Parking Regulation Signs; `sign_x_coord/sign_y_coord` are 2263 ftUS (kept as columns, no geom built) |

## `qol_*` — Quality-of-life overlays (Pass 2)

| Table/View | Source dataset id | Grain / rows | Storage |
|---|---|---|---|
| `qol_sr311` | `erm2-nwe9` (311, FULL pull per D-6) | **21,826,798** rows | view_giant, hive by `year(created_date)`; embedded newlines in quoted fields (DuckDB-parsed count is authoritative) |
| `qol_sr311_sidewalk` | derived from `qol_sr311` | 1,381,235 rows | VIEW; `complaint_type IN` (Sidewalk Condition, DEP Sidewalk Condition, Curb Condition, Root/Sewer/Sidewalk Condition, Noise - Street/Sidewalk) |
| `qol_nypd_complaints` | `qgea-i56i` (NYPD Historic) | **10,071,507** rows | view_giant, hive by `year(rpt_dt)`; external |
| `qol_nypd_ytd` | `5uac-w243` (NYPD YTD) | 133,114 | POINT geom (lat/lon 4326) |
| `qol_crashes` | `h9gi-nx95` (MVC Crashes) | 2,269,187 | POINT geom (lat/lon 4326); joins `qol_crashes_persons` on `collision_id` |
| `qol_crashes_persons` | `f55k-p6yu` (MVC Person) | 5,984,110 | person-level (no geom); `person_type` filters ped/cyclist |
| `qol_trees` | `uvpi-gqnh` (2015 Street Tree Census) | 683,788 | POINT geom (lat/lon 4326); carries root_stone/root_grate/sidewalk-damage flags |
| `qol_air_quality` | `c3uy-2p5r` (NYCCAS) | 19,827 | indicator/geo/time-period overlay (no geom) |

*Row-count validation: giants (`qol_sr311`, `qol_nypd_complaints`, `ped_counts_automated`) validated
EXACT against provenance parser counts. Non-giant geo tables may drop null-geometry features (e.g.
`speed_limits` 141,440 of 141,444) and whole-file exports may differ from a line-based counter by ≤1 due
to embedded newlines (`qol_crashes` 2,269,187 vs line-count 2,269,188); doctor reports these deltas and
tolerates them. `automated_bike_ped_counts` PROVENANCE landed mid-pass; final snapshot = complete 415-page
keyset (20,704,366).*

## Not-yet-landed (a later pass registers these)

*(none — all three Pass-2 categories `sidewalk_pedestrian` / `street_network` / `qol` are now landed and
registered; `_build_meta` `category_skipped` list is empty.)*

## Regeneration

```
PYTHONIOENCODING=utf-8 python db/convert_lake.py   # raw -> lake (giants: --only <slug> per giant to stay in foreground limits)
PYTHONIOENCODING=utf-8 python db/build_db.py       # lake -> jane_geo.duckdb (fresh)
PYTHONIOENCODING=utf-8 python db/doctor.py         # phase gate (exit 0 = green)
```
Every geometry op requires `LOAD spatial;` on the connection.
