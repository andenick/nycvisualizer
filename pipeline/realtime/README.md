# NYC Platform — Realtime Infrastructure (`realtime/`)

Single-process asyncio poller that harvests every NYC realtime transit feed and
archives it to an hourly-partitioned Parquet lake, plus the **derive2** derivation engine.
Part of the **nycvisualizer** NYC Granular Mapping Platform.

```
realtime/
├── poller.py            # the always-on service (one process, all feeds)
├── derive2/             # THE LIVE derivation engine (run_derive.py + run_derive.ps1)
├── derive.py            # DEPRECATED v1 batch engine — invoked by nothing (see below)
├── POLLER_STATUS.json   # heartbeat: per-feed health, written every ~15s
├── poller.lock          # single-instance lockfile (PID + port)
├── logs/poller-YYYY-MM-DD.log
└── derived/             # observed_headways / adherence / kpis / trajectories / data_quality

# raw archive (location is env-driven — see below):
$NYCV_ARCHIVE_ROOT/<feed>/date=YYYY-MM-DD/hour=HH/part-*.parquet   # raw snapshots
                                          └── (alerts feeds write part-*.jsonl instead)
```

**Archive location is env-driven.** Set `NYCV_ARCHIVE_ROOT` (and `REALTIME_ARCHIVE`) in `.env`;
poller, derive2 and the site backend all read it from there, never from a literal in code. It
defaults to `realtime/archive/` but is normally pointed at a **separate drive** so archive growth
never contends with the working tree — which is how the reference deployment runs it, so the
in-tree `realtime/archive/` directory may not exist at all.

## Feeds polled

| Feed(s) | Cadence | Key | Format |
|---|---|---|---|
| `bus_vehicle_positions` | **31 s** | MTA BusTime | parquet (vehicles) |
| `bus_trip_updates` | 62 s | MTA BusTime | parquet (stop-time updates) |
| `bus_alerts` | 5 min | MTA BusTime | jsonl |
| `subway_gtfs`,`_ace`,`_bdfm`,`_g`,`_jz`,`_nqrw`,`_l`,`_si` | 30 s | none | parquet (vehicles) |
| `lirr`, `mnr` | 60 s | none | parquet (vehicles) |
| `subway_alerts` (camsys all-alerts) | 5 min | none | jsonl |
| `citibike_station_status` (GBFS) | 60 s | none | parquet (stations) |
| `ferry_vehicle_positions`, `ferry_trip_updates` | 60 s | none | parquet |

### ⚠️ BusTime rate floor — the one hard rule
All three BusTime feeds share **one key** and are driven by a **single serialized
scheduler** (`bus_scheduler_loop`). No two BusTime HTTP calls are ever concurrent or
closer than **31 s** apart (`MIN_BUS_GAP`). One floor violation can get the key
**revoked**. Never add a second bus caller, never parallelise bus feeds. On a BusTime
`403`/`5xx` the poller backs off ≥ 60 s (max ~1 retry/min) and logs an explicit
"key may be invalid/revoked — REPORT" line; it does **not** hammer.

Subway/rail feeds are key-free and staggered 2 s apart so the 8 subway feeds don't
fire simultaneously.

## Start / stop

The service runs under **Windows Task Scheduler** as task **`JaneNYCPoller`**
(registered to run at logon/startup and on demand). It is a single long-lived
process — no shell background job.

```powershell
# start now
schtasks /Run   /TN JaneNYCPoller
# stop
schtasks /End   /TN JaneNYCPoller
# status / next run
schtasks /Query /TN JaneNYCPoller /V /FO LIST
# remove
schtasks /Delete /TN JaneNYCPoller /F
```

Manual foreground run (dev):
```powershell
python realtime/poller.py
```

**Single-instance guard:** on launch the poller binds `127.0.0.1:47654` and writes
`poller.lock`. A second launch fails the bind and exits with code 3 — double-launch
is impossible. If you get "ANOTHER INSTANCE IS RUNNING", one is already up (check the
`pid` in `poller.lock` / `POLLER_STATUS.json`).

## Status file semantics (`POLLER_STATUS.json`)

Rewritten atomically every ~15 s. Top level: `pid`, `started_at`, `updated_at`,
`archiving_enabled`, `disk_free_gb`, `disk_floor_gb`, `bus_key_present`,
`total_rows_archived`. Per feed under `feeds.<name>`:

| field | meaning |
|---|---|
| `last_success` | ISO time of last 200-with-parse |
| `last_status` | last HTTP code or `ERR:<Type>` |
| `error_count` | cumulative errors |
| `rows_archived` | cumulative rows flushed to disk |
| `rows_dropped` | rows dropped while disk guard active |
| `buffer_size` | rows waiting to flush |
| `last_header_ts` | feed's own header timestamp (staleness signal) |
| `stale` | true if header ts unchanged > 5 min (feed frozen / MTA maintenance) |
| `backoff_active` | true if currently in 429/5xx/403 backoff |
| `last_error` | last error string |

**Health check:** a feed is healthy when `last_success` is recent, `stale=false`, and
`buffer_size` is climbing then resetting on flush (~every 5 min).

## Archive layout & buffering

Rows buffer in memory per feed and flush to
`archive/<feed>/date=YYYY-MM-DD/hour=HH/part-<hhmmss>-<rand>.parquet` roughly every
**5 min** (`FLUSH_SECONDS`) or at 200k buffered rows. Each flush is an independent
part file (many small files per hour) — query the whole lake with DuckDB
`read_parquet(..., union_by_name=true)`; per-file schema drift (all-null columns) is
tolerated. Alerts feeds write `.jsonl` (nested translations/informed-entities).

Vehicle columns: `feed, poll_ts, header_ts, vehicle_id, trip_id, route_id,
direction_id, lat, lon, bearing, speed, timestamp, stop_id, current_stop_seq,
current_status, occupancy_status`. Trip-update columns: `… trip_id, route_id,
vehicle_id, stop_id, stop_seq, arrival_time, arrival_delay, departure_time,
departure_delay, schedule_relationship`. GBFS: per-station availability counts.

## Resilience

- **Backoff**: 429 / 5xx → exponential backoff (base 2, cap 300 s); bus feeds floor
  the backoff at 60 s. Success resets the streak.
- **Stale detection**: unchanged header timestamp > 5 min logs a `STALE` warning and
  sets `stale=true` (clears when the feed advances again).
- **Disk guard**: every cycle checks `D:` free. Below **30 GB** archiving is
  suspended (loud log), polling continues, buffers are dropped above a 1M-row cap to
  avoid OOM (`rows_dropped` counts them); it auto-resumes when space returns.
- **Crash-safety**: `POLLER_STATUS.json` is written atomically (temp + `os.replace`).
  Task Scheduler restarts the process on failure/reboot; on restart the poller simply
  resumes polling (in-memory buffers since the last 5-min flush are lost — acceptable
  for snapshot data).

## Retention policy (keep-indefinitely)

- **Raw snapshots**: **kept indefinitely** — the archive is the raw material for the
  telemetry we preserve (per-bus behavior, the motion model). It is **never silently
  deleted**.

  **Measured growth.** Over the six **complete** days in the reference deployment's archive
  (2026-07-18, 07-19, 07-20, 07-22, 07-23, 07-24 — excluding a partial start day, a disk-guard
  outage day, and the in-progress day):

  | | |
  |---|---|
  | per-day | 0.517 · 0.488 · 0.529 · 0.522 · 0.492 · 0.541 GiB |
  | **mean** | **0.515 GiB/day** |
  | | **15.7 GiB/month ≈ 188 GiB/year** |
  | archive total at measurement | **3.790 GiB across 17 feeds** |

  Budget ~**190 GiB/year** for all 17 feeds. (An earlier "~0.3 GB/day (≈110 GB/yr)" figure in
  this file was wrong — it understated growth by ~1.7×.)

  **Two feeds dominate the volume** (>77% of all archive bytes):

  | Feed | Share | Size | Note |
  |---|---|---|---|
  | `bus_trip_updates` | **38.8%** | 1.472 GiB | second compaction candidate |
  | `subway_alerts` | **38.3%** | 1.451 GiB | **the compaction target** — 0.188 GiB/day ≈ 69 GiB/yr on complete days |

  `subway_alerts` is **uncompressed JSONL that re-publishes the FULL alert set every 5 minutes**,
  so successive parts are almost entirely redundant — the obvious place to compact first.
  **Compaction is NOT implemented and is deferred**: there is no compaction script and no
  schedule. Recorded so the growth budget is honest, not as a pending action.

- **Cold-storage move at ~200 GB** — when the archive crosses ~200 GB, MOVE the *oldest whole
  month* of raw partitions to cold storage, never delete: a manual/curated, size-triggered move,
  not a rolling age prune.

  > ⚠️ **The cold-storage destination must be a DIFFERENT PHYSICAL VOLUME than the archive.**
  > Check for symlinks/junctions first — a "cold" path that resolves onto the same volume as
  > `NYCV_ARCHIVE_ROOT` frees **zero bytes**, which is exactly the trap the earlier version of
  > this guidance fell into. Verify with the resolved target, not the pretty path.

  ```powershell
  # Archive size check (run periodically; act only when over ~200 GB):
  $archive = $env:NYCV_ARCHIVE_ROOT
  if (-not $archive) { $archive = 'realtime/archive' }
  '{0:N1} GB' -f ((Get-ChildItem $archive -Recurse -File |
    Measure-Object Length -Sum).Sum / 1GB)
  # If over threshold: MOVE (never Remove) the oldest date=YYYY-MM-* partitions to a
  # cold-storage dir on a DIFFERENT physical volume.
  ```
  There is **no age-based pruning routine** in the poller: it only writes/flushes and, on a
  low-disk guard, *suspends* archiving — it never deletes archive data.
- **Derived** trajectories/tables (`derived/`): kept indefinitely — they are the
  compact analytical product, with `vehicle_id` preserved (the per-bus-profile raw material).

## Resume behavior

The poller holds **no durable cursor** — every cycle is an independent snapshot pull,
so restart is trivial and lossless beyond the current unflushed buffer. derive2 is
likewise fully re-runnable: it is **idempotent by day-partition** and reprocesses only
days whose archive input changed (state in `derive2/DERIVE2_STATE.json`).

## Derivations — `derive2/` is the live engine

**`realtime/derive2/` is the only derivation engine that runs.** It is driven by the
scheduled task **`JaneNYCDerive`**, which fires **every 30 minutes** — implemented as two
`PT1H` repeat triggers, one at **:20** and one at **:50**. Verify with
`(Get-ScheduledTask -TaskName JaneNYCDerive).Triggers`.

```powershell
# what the scheduled task actually runs:
powershell -NoProfile -ExecutionPolicy Bypass -File realtime/derive2/run_derive.ps1

# or the two steps directly (both idempotent, safe to run anytime):
python realtime/derive2/run_derive.py         # incremental derivation
python realtime/derive2/package_headways.py   # published dataset roll
```

It reads the settled Parquet archive only (never the live feeds — no BusTime key contention)
and writes `derived/{trajectories,observed_headways,adherence,kpis,data_quality}/date=*`.
Full method: **`derive2/METHODS_derive2.md`**.

**This cadence is local to the machine that derives.** Publishing the derived tree to a serving
host is a separate deployment step on its own, slower cadence — do not quote the 30-minute
interval as the freshness of anything a site visitor sees.

### `derive.py` — DEPRECATED v1 engine (uninvoked)

`realtime/derive.py` is the original v1 batch engine. It is **superseded by `derive2/` and is
invoked by nothing** — no scheduled task, no wrapper script, no import (the only remaining
references are documentation and its own docstring). It is retained for provenance only.
**Do not use it**; it defines an arrival differently from derive2 (see `METHODS_derive2.md` §1)
and its output is not what any site surface reads.

## Known issues (ops)

- **`subway_l` intermittent SSL EOF (observed 2026-07-17):** the poller's fetches of
  `nyct%2Fgtfs-l` recurringly fail with `SSL: UNEXPECTED_EOF_WHILE_READING`
  (urllib3 "Max retries exceeded"), while every other NYCT feed on the same host is
  clean and a fresh one-shot client (httpx) fetches gtfs-l fine. Effect: sparse L
  archive coverage (gaps of 5–20 min between successful polls). Likely a
  connection-reuse/keep-alive sensitivity specific to that endpoint. Suggested fix:
  give `subway_l` a fresh connection per request (`Connection: close`, or a per-fetch
  session / httpx client) instead of the shared pooled session. The site backend
  (`site/backend/app/subway.py`) already compensates: any stale feed falls back to a
  key-free live fetch per feed, and per-feed source/staleness is reported honestly.
