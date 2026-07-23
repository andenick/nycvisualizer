# Bus Service & Ridership — METHODS (Jane NYC-Platform, B5.2)

All analyses are scripted and reproducible against `jane_geo.duckdb`
(regenerable query layer over the parquet lake). Run order:

```
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 01_route_demand.py
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 02_segment_speeds.py
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 03_service_supply.py
PYTHONIOENCODING=utf-8 C:/Python313/python.exe 04_realtime_headways.py   # RERUNNABLE
```

Outputs (Parquet + one-sheet XLSX per file, Druck-compliant) → `Outputs/NYCPlatform/bus/`;
headline PNG charts → `Outputs/NYCPlatform/bus/charts/`.
Shared helpers (connection, borough-from-route-prefix, writers) in `common.py`.

## Data sources (dataset IDs)

| Analysis | View/table | Socrata / source id | Grain | Rows | Coverage |
|---|---|---|---|---|---|
| 01 demand | `transit_ridership_bus_hourly` | `kv7t-n8in` (2020-24) + `gxb3-akrn` (2025→) | route × payment × fare-class × hour | 583.8M | 2020-01-01 … 2026-07-07 |
| 02 speed | `transit_segment_speeds` | `58t6-89vi` (2023-24) + `kufs-yh3x` (2025→) | timepoint-segment × hour × DOW | 19.9M | 2023-01-01 … 2026-05-01 |
| 02 ACE | `transit_ace_routes`, `transit_ace_violations` | `ki2b-sg5y`, `kh8p-hcbm` | route program dates; per-violation | 85; 5.9M | 2019-10 … 2026-06 |
| 03 supply | `transit_gtfs_trips/_stop_times/_routes/_stops` | MTA GTFS static (6 bus feeds) | trip / stop-time / route / stop | 8.7M stop-times | current pick |
| 04 realtime | `rt_bus_vehicle_positions` | BusTime GTFS-RT (live poller archive) | vehicle position frame | grows | see runtime stamp |

## Key formulas

- **Trip-weighted speed** (02): `Σ(average_road_speed·bus_trip_count) / Σ(bus_trip_count)` — weights each
  segment observation by the number of bus trips it summarizes, so busy segments dominate.
- **Scheduled headway by period** (03): `period_span_minutes / trips_starting_in_period` per route×direction.
  Periods: AM_peak 06–09 (240 m), Midday 10–15 (360 m), PM_peak 16–19 (240 m), Evening 20–23 (240 m),
  Night else (360 m). A trip's start = min `departure_time` across its stops (parsed to seconds; GTFS
  times >24:00 bucketed mod 24).
- **Boardings per trip** (03, demand×supply): avg-weekday route boardings (trailing from 2025-07-01, ISO
  DOW ≤ 5) ÷ representative-weekday scheduled trips. High = crowded/under-served; low = over-served.
- **Observed headway** (04): gap between consecutive vehicle *passages* at a (route,direction,stop);
  a passage = first RT frame where a vehicle's reported `stop_id` changes (lag over vehicle by time).
- **Bunching index** (04): headway CV = `stddev(headway)/mean(headway)` per route; CV≈0 regular, CV>0.5 bunched.

## Design decisions & data-quality discoveries

1. **Bus APC is ROUTE-LEVEL, not stop-level.** `transit_ridership_bus_hourly` schema is
   `transit_timestamp, bus_route, payment_method, fare_class_category, ridership, transfers` — **no
   stop and no direction column.** The master plan's "stop-level hourly boardings" (B5.2 item 3) does
   not match the delivered dataset. All demand here is per route. Genuine stop-level service exists only
   on the **supply** side (GTFS `stop_times`, script 03).
2. **Borough from route prefix.** Ridership has no borough; derived by MTA route-prefix regex
   (SIM/BXM/QM/BM/BX then M/B/Q/S/X + digit; see `common.py::BOROUGH_CASE`). Express routes attributed
   to home borough. A residual `Other/MTA Bus Co.` bucket (D/F/J/L/T prefixes, 21 routes, ~28k lifetime
   boardings) is negligible.
3. **GTFS feeds overlap in `routes.txt` but not in trips.** Each of the 5 borough feeds + MTA Bus Co
   carries the *full* routes list, but a route's **trips live in exactly one feed** (verified:
   B62→brooklyn, M15→manhattan). So grouping trips by `route_short_name` does **not** double-count.
4. **Representative weekday.** MTA ships many weekday `service_id`s; the prefixes (MQ/MV/OF/GH/EN/QV/CA…)
   are **garage codes sharing one pick** (`_C6-`), i.e. complementary across garages. Script 03 unions
   all `%Weekday%` service_ids **excluding `Weekday-SDon`** (the school-open variant that duplicates base
   weekday trips) → 54,273 trips, a coherent single school-closed weekday.
5. **Local + SBS combined for the demand join.** Route names normalized (strip `-SBS`/`+`, non-alnum,
   upper) so GTFS `M15`+`M15-SBS` and ridership `M15`+`M15+` combine to one corridor. This slightly
   inflates a corridor's supply vs a single branded route; noted where it matters.
6. **Segment-speed layover artifacts.** Terminal/layover "segments" (null next-timepoint, ~0-distance)
   yield spurious ~0.06 mph speeds; the slowest-segment league table filters `road_distance ≥ 0.1 mi`
   and non-null endpoints.

## ACE before/after caveats (02)

Descriptive pre/post trip-weighted peak speed on each ACE route's own segments in the ±120-day windows
around `implementation_date` (only routes going live 2023-05…2025-12, so both windows fall inside speed
coverage; ≥500 trips each side). **This is NOT causal.** Confounders: seasonality, post-COVID ridership
recovery, concurrent street redesigns/SBS rollouts, route changes, and the fact that ACE targets
blocked-bus-lane/double-park delay rather than through-traffic. Read the ±0 mph aggregate result as
"no clean speed signal at this crude resolution," not "ACE doesn't work."

## Congestion-pricing context (Jan 2025) — why these speed trends matter now

NYC launched the United States' first cordon-based **congestion pricing** program (the CBD Tolling / Congestion Relief Zone, Manhattan **south of 60th St**) on **5 January 2025**. Our segment-speed panel straddles that date — the `kufs-yh3x` vintage (2025→) is the **post-congestion-pricing era** — so any 2025+ speed trend on these pages must be read against this policy backdrop, not as an isolated result.

Two peer references, dated and cited (Jane KB):

- **NBER w33584** — Cook, Kreidieh, Vasserman, Allcott et al., *The Short-Run Effects of Congestion Pricing in New York City* (March 2025, rev. Jan 2026; KB DOC0343): using a generalized synthetic-controls design, the policy *"increased speeds on CBD roads by 11%, with little-to-no effect on air quality, transactions at shops and restaurants, or overall foot traffic in the CBD,"* with spillover speed gains on roads leading into the CBD. Note the estimand: that **+11%** is CBD **road** speed for all vehicles, **not** a bus through-speed benchmark — it is context for our numbers, not a target to match.
- **arXiv:2606.17530** — Li, Zhuang et al. (MIT), *Public transit gains and spatially uneven travel demand changes after NYC congestion pricing* (2026; KB DOC0407): post-policy bus and subway ridership rose significantly vs expected no-policy demand, and *"the effects are spatially heterogeneous: while reductions in overall travel demand are concentrated within the Congestion Relief Zone, transit gains extend beyond Manhattan's core"* — a caution against reading a single citywide speed/ridership average as the whole story.

## Realtime archive depth (04) — honest stamp

Script 04 is **rerunnable** and prints/writes (`04_archive_stamp.txt`) the exact window it computed over.
At authoring the archive was only **~1.9 hours deep** (2026-07-17 05:51–07:43 America/New_York, AM-peak
edge; 209k frames / 4,219 vehicles / 341 routes). **These headway/bunching/adherence numbers are
PRELIMINARY** — illustrative of method, not stable reliability findings. They strengthen as the poller
archive accumulates; re-run the script to refresh. The passage approximation (stop_id transition) leads
true arrival slightly and is not a fare-gate count.
