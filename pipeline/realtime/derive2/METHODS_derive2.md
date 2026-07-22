# derive2 — Realtime Derivation Engine v2 (methods)

**Owner:** S2 of the nycvisualizer spokes campaign. **Home:** `realtime/derive2/`.
**Consumes:** the poller's Parquet/JSONL archive under `realtime/archive/` + GTFS static
under `data/raw/transit_static/`. **Produces:** `realtime/derived/{trajectories,
observed_headways,adherence,kpis,data_quality}/date=*/…` and the public dataset
`analysis/headways_dataset/`.

Public-repo hygiene: every module resolves the platform root from `NYCV_PIPELINE_ROOT`
(fallback: three levels up from `_common.py`); no absolute path literals. EPSG:2263 (US
survey feet) is the measurement CRS.

---

## 0. The `current_status` discovery (why v2 exists)

The legacy `derive.py` defined an arrival as the earliest poll where a trip is reported
`STOPPED_AT` (`current_status = 1`) a stop. **`current_status` and `current_stop_seq` are
100% NULL in the entire bus vehicle-positions archive** (verified: 2,046,002/2,046,002 NULL
on 2026-07-19; identical every day). The legacy rule therefore yields **zero** arrival
rows. `stop_id`, by contrast, is 100% populated, and `trip_id` joins to GTFS `trips.txt`
at **~99.4%**. v2 builds arrival detection on **shape-offset crossings** (primary) and
**first-seen-per-(trip, stop_id)** (fallback) instead. Nothing in v2 reads `current_status`.

---

## 1. Trajectories (`trajectories.py`)

Per archive day:

1. Read `bus_vehicle_positions` (`trip_id, route_id, vehicle_id, ts = COALESCE(timestamp,
   poll_ts), lat, lon`); drop null trip/lat/lon; de-dup exact `(trip_id, ts)`.
2. Join `trip_id → GTFS trips.txt` (from all six borough/operator bus feeds; route→feed
   ownership is 1:1, **zero collisions**) to get `shape_id, direction_id, feed`. Pings whose
   trip has no GTFS match are counted as `trips_unmatched_no_gtfs` and dropped.
3. Project every ping GPS (4326 → **2263**) and, grouped by shape, compute its
   **distance-along-shape offset** with `shapely.line_locate_point` against the shape's
   LineString (also built in 2263). Offset units are feet.
4. **Monotonic-offset filter:** walking the trip's pings in time order, drop any ping whose
   offset falls more than `MONO_BACKTRACK_FT = 500 ft` below the running max (GPS jitter /
   wrong-branch matches on looping routes). Count dropped pings (`non_monotonic_pings`).
5. **Resample to 30 s** (`RESAMPLE_S`): interpolate offset onto a regular 30 s grid between
   the trip's first and last surviving ping (offsets forced non-decreasing first).

Output `derived/trajectories/date=*/part-000.parquet`:
`trip_id, route_id, direction_id, shape_id, feed, ts, offset_ft, frac_along`
(`frac_along = offset_ft / shape_length` — the Marey y-coordinate in [0,1]).

Honest rates (per day, in the run summary + state): `unmatched_trip_rate` (≈0.6%),
`non_monotonic_rate` (≈3–4% of matched pings), `trips_too_few_points`.

---

## 2. Observed headways + bunching (`headways.py`)

**Arrival events**, two detectors, unioned with a `method` tag:

- **PRIMARY — shape-offset crossing.** For each trip's resampled offset series and each
  stop's projected offset on that shape (`stop_offsets`, computed once in `gtfs_index`),
  find the grid interval bracketing the stop offset and **linearly interpolate the crossing
  timestamp**. That timestamp is the arrival.
- **FALLBACK — first-seen.** For trips with no usable trajectory (unmatched shape / too few
  pings), arrival = earliest archive `ts` the trip reports each `stop_id`. S0 validated this
  gives plausible rush headways.

**Clock / timezone.** Observed `ts` are UTC epoch. NYC is EDT (UTC−4) for the whole archive
window (no DST transition inside it), so local seconds = `ts − 14400`. Everything is
**bucketed by local date/hour** so rush buckets and the scheduled join line up.

**Scheduled arrival** per `(trip, stop)` comes from GTFS `stop_times` by direct `trip_id`
join (RT ids == GTFS ids). `deviation_s = observed_local_seconds − (sched_arr_sec mod
86400)`.

**Observed headway** = gap between consecutive arrivals at a stop for a `route × direction`,
kept when `MIN_HEADWAY_S (30) ≤ h ≤ MAX_HEADWAY_S (7200)`.

**Scheduled headway** per `route × direction × stop × local_hour` = median gap between
consecutive *scheduled* arrivals, restricted to services active that calendar day
(`calendar` weekday flags + `calendar_dates` exceptions).

**Aggregate grain** (`derived/observed_headways/date=*/part-000.parquet`), one row per
`route × direction × stop × local_date × local_hour`:
`n_arrivals, n_headways, median/mean/min/max_headway_s, headway_cv,
sched_median_headway_s, headway_deviation_s (= median_obs − sched),
bunch_share_lt50_sched, bunch_share_lt50_obs, bunching_index, median_deviation_s,
stop_name, archive_depth_days, preliminary`.

**Bunching index.** Two honest components:
- `headway_cv` = σ/μ of observed headways in the cell.
- `bunch_share_lt50_sched` = share of observed gaps `< 0.5 × scheduled` headway
  (`BUNCH_SHORT_FRAC`). `bunch_share_lt50_obs` is the schedule-free analogue (`< 0.5 ×`
  observed median) so bunching is still defined where no schedule joins.
`bunching_index` = mean of `headway_cv` and `bunch_share_lt50_sched` (skipping NaN).

Event-level arrivals are also written (`arrivals-000.parquet`) for the adherence and KPI
stages.

---

## 3. Adherence (`adherence.py`)

Arrival events ⋈ `stop_times` (adds `stop_seq`, `sched_arr_sec`); one arrival per
`(trip, stop_seq)`. Per trip:
- `start_delay_s` = observed − scheduled at the first stop; `end_delay_s` at the last.
- **Running-time delta by segment**: for consecutive stops,
  `run_delta_s = (obs_arr[next] − obs_arr[prev]) − (sched[next] − sched[prev])`.

Outputs `derived/adherence/date=*/`: `trips-000.parquet` (per-trip start/end delay,
mean/total running delta) and `segments-000.parquet` (per stop-to-stop segment).

---

## 4. Systemwide KPIs (`kpis.py`) — feeds the Ops Wall

5-minute **local** bins, systemwide:

- `vehicles_reporting` — distinct vehicles in the **last poll** of the bin. The poller
  cadence is irregular (30 s nominal, real multi-minute gaps), so bins with no poll are
  **forward-filled** from the last known value and flagged `vehicles_stale = 1`. Binned by
  `poll_ts` (the liveness clock), not by GPS `timestamp` (which clusters and leaves spurious
  empty bins).
- `scheduled_active` — trips whose scheduled span `[first_stop_sec, last_stop_sec]` covers
  the bin on the active service day. `service_ratio = vehicles_reporting / scheduled_active`
  (≈1.0 at peak, as expected).
- `mean_abs_headway_dev_s` — mean `|observed headway − scheduled headway|` over the
  **trailing 60 min** of arrival events; `n_arrivals_trailing60` alongside.
- `active_bunching_pairs` — arrivals `< 0.25 × scheduled` headway (`BUNCH_PAIR_FRAC`) after
  the previous arrival at the same stop (same route × direction), counted in the bin.
- `alerts_high/medium/low/total` — distinct GTFS-rt `alert_id`s present in the
  `bus_alerts` + `subway_alerts` feed during the bin, bucketed by a severity tier derived
  from the `effect` enum (no native severity field exists). Forward-filled across
  alert-poll gaps (alert state is slowly varying).

`effect → severity`: `{1 NO_SERVICE, 2 REDUCED_SERVICE, 3 SIGNIFICANT_DELAYS} = high;
{4 DETOUR, 6 MODIFIED_SERVICE, 9 STOP_MOVED} = medium;` everything else `= low`.

Output `derived/kpis/date=*/part-000.parquet`, one row per 5-min bin.

---

## 5. Orchestration, idempotency, DATA_QUALITY (`run_derive.py`)

- Runs the four stages in order per day. **Idempotent / incremental:** each day carries an
  input **signature** (file count + max mtime over the high-volume feeds); a day is skipped
  when unchanged, so the hourly task only reprocesses days that gained complete hours. State
  in `DERIVE2_STATE.json` (canonical, resumable). `--backfill`, `--day D`, `--force`.
- After the stages it stamps `archive_depth_days` + `preliminary (< 14 days)` into the
  headway aggregate — consumers add PRELIMINARY badges from these.
- **`DATA_QUALITY.json` per day** (`derived/data_quality/date=*/`): for each high-volume
  feed, per-hour `rows`, `coverage_pct` (vs the median rows for that feed × hour-of-day over
  full ≥20-hour days), and a `status`:
  `ok | partial (<60% ) | missing | known_gap | in_progress`. `exclude_from_stats_hours`
  lists the hours the headway dataset must drop.

### The 2026-07-21 poller suspension (known gap)

Archiving was suspended **2026-07-21T00:51Z → 22:55Z** (disk guard); rows were buffered and
only partially flushed (some dropped above the buffer cap). In the archive this shows as
`bus_vehicle_positions` having **only hours 00, 22, 23** on 2026-07-21 (hour 22 partial:
~32k rows vs a ~228k baseline). The window is declared in `_common.KNOWN_GAPS`; those hours
are flagged `known_gap` in `DATA_QUALITY.json` and **excluded** from the published headway
dataset. Honesty over volume.

---

## 6. Public dataset (`package_headways.py`)

Rolls `derived/observed_headways` into `analysis/headways_dataset/` as **"NYC Observed Bus
Headways (beta)"**: per-service-day CSV + Parquet, a concatenated `…_all.parquet`, a
`datapackage.json` (Frictionless-style, CC-BY 4.0, cadence daily), and a `README.md`. Drops
PARTIAL/known-gap local hours (from `DATA_QUALITY.json`) and cells with `< 2` observed
headways. Every file carries `archive_depth_days` + `preliminary`. This is the novel
artifact — MTA publishes schedules, not observed headways.

---

## 7. Thresholds (all in `_common.py`)

| Const | Value | Meaning |
|---|---|---|
| `RESAMPLE_S` | 30 s | trajectory resample cadence |
| `MIN_HEADWAY_S` / `MAX_HEADWAY_S` | 30 / 7200 s | observed-headway keep band |
| `MONO_BACKTRACK_FT` | 500 ft | GPS-jitter tolerance in the monotonic filter |
| `STOP_MATCH_TOL_FT` | 660 ft | "at a stop" proximity (reserved) |
| `BUNCH_SHORT_FRAC` | 0.5 | gap < 0.5× ⇒ counts toward bunching share |
| `BUNCH_PAIR_FRAC` | 0.25 | KPI bunched-pair threshold |
| `COVERAGE_PARTIAL_FRAC` | 0.60 | hour < 60% of baseline ⇒ PARTIAL, excluded |
| EDT offset | 14400 s | UTC−4, whole archive window |

## 8. Scheduling

`JaneNYCDerive` — Windows Scheduled Task, hourly at **:20** (offset from poller flush
windows), interactive user, `python`, wrapper `run_derive.ps1` (UTF-8 +
logging, mirrors `changes/run_snapshot.ps1`). Runs `run_derive.py` (incremental) then
`package_headways.py` (dataset roll).
