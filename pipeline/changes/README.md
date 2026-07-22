# S3 — GTFS Snapshot + Diff Engine

Content-hashed GTFS static snapshots + a structured schedule-change differ for the
Jane / nycvisualizer NYC Platform. Answers "what changed in the published schedule, and
when" — routes, headways, stops, service spans, trip counts, routings.

## What's here

| File | Role |
|------|------|
| `snapshot.py` | Fetch dynamic feeds, content-hash, store only on a **changed** hash; seed baselines from `data/raw/transit_static/`. |
| `gtfs_diff.py` | Structured diff between two snapshots of one feed → JSONL deltas + `CHANGELOG.md`. |
| `run_diffs.py` | Orchestrator: snapshot all feeds → diff every new snapshot vs its predecessor. Idempotent. |
| `_common.py` | Shared paths + the logical content-hash. |
| `run_snapshot.ps1` | Scheduled-task wrapper (sets `NYCV_PIPELINE_ROOT`, logs to `logs/`). |
| `gtfs_snapshots/` | `SNAPSHOT_INDEX.json` + `<feed>/<UTC-ts>_<hash8>.zip` (only stored on change). |
| `deltas/` | `<feed>__<from_ts>__to__<to_ts>.jsonl` structured delta records. |
| `CHANGELOG.md` | Human-readable change log, newest first. |

## Run

```
# env-parameterized root (no absolute paths baked into code)
set NYCV_PIPELINE_ROOT=<...>/NYCPlatform      # optional; defaults to the dir above changes/

python run_diffs.py          # snapshot all + diff new pairs  (the scheduled job)
python snapshot.py --seed-only   # (re)seed baselines from disk, no network
python run_diffs.py --no-fetch --all-pairs   # re-diff every consecutive pair
python gtfs_diff.py --feed X --from-zip a.zip --to-zip b.zip \
    --from-ts T0 --to-ts T1                   # ad-hoc diff of any two zips
```

## Feeds tracked

**Dynamic (re-fetched every 6 h):** the supplemented subway feed
(`gtfs_supplemented.zip`, includes SIR) + the 6 NYCT/MTA bus feeds
(`gtfs_bx/b/m/q/si/busco.zip`) from `rrgtfsfeeds.s3.amazonaws.com`.

**Static baselines (seeded, referenced in place — not re-fetched here):** base subway
`20260526`, ferry, LIRR, MNR. Seeded so their vintage is a first-class snapshot available
for diffing (e.g. the proof backfill below).

## Disk discipline (mandatory — D: is under pressure)

Dedup is by **logical GTFS content hash**, not raw zip bytes: `_common.content_hash`
sha256s the sorted, newline-normalized schedule members (`routes/trips/stops/stop_times/
calendar*/shapes/...`). The supplemented feed is **re-zipped hourly**; when the underlying
schedule is unchanged the logical hash is identical and **nothing is stored**. A snapshot
(~5–20 MB) lands only on a real content change. Baselines are **referenced in place** via a
relative `ref` in the index — the existing `data/raw/transit_static` zips are never copied.

## Feed semantics — read before trusting a diff

**The supplemented subway feed includes the next ~7 days of service changes.** It is the
MTA's operational feed: planned weekend GO (General Orders) work, reroutes, and temporary
frequency changes are folded in as **dated** service. Consequences:

- **A supplemented diff reflects TEMPORARY changes too.** A headway jump you see today may
  be a single weekend's track work, not a permanent timetable change.
- **Permanent vs temporary classification matures with history.** The honest rule: a change
  is *temporary* if it disappears from a later snapshot and *permanent* if it persists
  across snapshots spanning the affected dates. With only two snapshots you cannot tell —
  the label firms up as the snapshot series lengthens. The engine records every snapshot so
  this becomes decidable over time; it does not guess prematurely.
- **Supplemented (dated) vs base (repeating) are different animals.** The base subway feed
  uses 3 repeating service_ids (Weekday/Saturday/Sunday, ~20 k trip rows). The supplemented
  feed enumerates ~100+ dated service_ids (~84 k trip rows). **Raw trip-count diffs between a
  supplemented and a base snapshot are therefore meaningless** (they show a ~77 % "drop" that
  is pure feed-structure, not service). Only diff **like-for-like**: supplemented↔supplemented,
  bus↔bus. `run_diffs.py` only ever diffs consecutive snapshots of the *same* feed key, so it
  is always like-for-like; the base-vs-supplemented proof diff is a deliberate one-off.

## Diff method (what each change_type means)

- **route_added / route_removed** — `route_id` set difference in `routes.txt`.
- **headway_delta** — per `route × service_period × time-of-day window × direction`: the
  **median of consecutive scheduled arrival gaps at the route's trunk stop** (the stop with
  the most visits on that route). Flagged when |Δ| > 10 %. Service period is read from
  `calendar.txt` day-flags, falling back to the majority day-of-week of `calendar_dates.txt`
  added dates (needed for the supplemented feed's dated services). Windows: am_peak 06–10,
  midday 10–16, pm_peak 16–20, evening 20–24.
  *Caveat:* on the supplemented feed, many dated service_ids can each contribute an arrival
  at nearly the same clock time at a trunk stop, compressing the median gap; very tight
  baseline headways (≈1–2 min) and their large % deltas should be read as directional
  signal, not exact timetable values. Consecutive 6-h supplemented snapshots (stable
  calendar structure) give the cleanest headway deltas.
- **trip_count_delta** — trips per `route_id` in `trips.txt` (like-for-like feeds only).
- **service_span_change** — per `route × service_period`, change in earliest departure /
  latest arrival (> 5 min).
- **stop_added / stop_removed** — revenue `stop_id` (location_type 0) set difference.
- **stop_relocated** — common `stop_id` whose lat/lon moved > 25 m (haversine).
- **shape_change** — count of common `trip_id`s whose `shape_id` changed, per route.
  Advisory: shape_ids churn between vintages even without a real reroute.

Delta record shape: `{feed, from_ts, to_ts, change_type, route_id, detail, magnitude}`.

## Schedule

Windows Scheduled Task **`JaneNYCGtfsSnap`** runs `run_snapshot.ps1` **every 6 hours**
(interactive user, `python`). It is a sibling of `JaneNYCPoller`. The
wrapper sets `NYCV_PIPELINE_ROOT`, silences the benign urllib3 warning, and appends output
to `changes/logs/gtfssnap-<date>.log`.

```
schtasks /Query /TN JaneNYCGtfsSnap /V /FO LIST     # status
schtasks /Run   /TN JaneNYCGtfsSnap                 # run now
```

## Public-repo hygiene

No absolute `workspace-root` literals in any code file — the root resolves from
`NYCV_PIPELINE_ROOT` (else the dir above `changes/`), matching the poller/derive/build
convention. Stored snapshot zips live under `gtfs_snapshots/` (gitignore per repo policy for
`data/`-scale artifacts if published; the index + deltas + changelog are the shareable
record).
