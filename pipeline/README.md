# nycvisualizer — pipeline

The data half of nycvisualizer: turn public NYC Open Data + MTA feeds into a queryable
geodatabase and a set of reproducible analyses. The web app (`/site`) is a thin serving
layer on top of what this pipeline produces.

```
NYC Open Data (Socrata × 2 portals) ─┐
NYC DCP BYTES (PLUTO / LION / planimetrics)   ├─► data/raw/  ──►  data/parquet/  ──►  db/jane_geo.duckdb
U.S. Census (PL 94-171, ACS, TIGER)  ─┘        (verbatim + PROVENANCE)  (EPSG:2263 lake)   (DuckDB + spatial)
                                                                                              │
MTA GTFS-RT (bus key; subway/rail key-free) ──► realtime/poller.py ──► realtime/archive/*.parquet
                                                                    │                         │
                                          realtime/derive2/ ◄───────┘                         ▼
                                    (trajectories, observed headways,          analysis/{sidewalk,bus,sai,access,renters}/
                                     adherence, KPI rollups, dataset)  ──► outputs/           ──► outputs/
MTA GTFS static (6-hourly snapshots) ──► changes/ (snapshot + gtfs_diff) ──► changes/deltas/*.jsonl + CHANGELOG
```

Four stages: **acquire → lake → database → analyze** (plus a continuously-running
**realtime** poller feeding the live map).

The heavy artifacts (`data/`, `realtime/archive/`, `db/*.duckdb`, `outputs/`) are
**gitignored and regenerable** — this repo ships the code that produces them, not the data.
All paths default to the repo layout and are overridable via environment variables
(`NYCV_PIPELINE_ROOT`, `JANE_GEO_DB`, `NYCV_OUTPUTS`, `DATA_ROOT`, `OUTPUTS_ROOT`).

---

## 0. Prerequisites

```bash
pip install duckdb pandas pyarrow openpyxl requests numpy matplotlib
```

DuckDB's `spatial` extension is loaded automatically by the scripts (`INSTALL spatial;
LOAD spatial;`). All distance/area math uses **EPSG:2263** (NY State Plane Long Island, US
survey feet); display copies are **EPSG:4326**.

Get your free API keys (see the root README's "API keys — bring your own"). Only the
**MTA BusTime key** is strictly required (for the realtime bus feed); Socrata tokens are
optional and the Census key is only needed for population joins.

---

## 1. Acquire — `data/raw/<source>/`

Download each dataset verbatim into `data/raw/<source>/` with a `PROVENANCE.json` alongside
(URL, dataset id, retrieved-at, row/feature count, license). No standalone downloader is
committed (acquisition is a one-time bulk pull), but the mechanics are simple and worth
documenting so you can reproduce them:

### Whole-file Socrata exports (the primary bulk path)

Every Socrata dataset (both `data.cityofnewyork.us` and `data.ny.gov`) exposes a
**whole-file export** endpoint with **no row cap and no token required**:

```
https://<portal>/api/views/<4x4-id>/rows.csv?accessType=DOWNLOAD
```

Stream it to disk (some are multi-GB — e.g. the 311 dataset `erm2-nwe9` is ~40M rows):

```bash
curl -L -o data/raw/sr311/erm2-nwe9.csv \
  "https://data.cityofnewyork.us/api/views/erm2-nwe9/rows.csv?accessType=DOWNLOAD"
```

The response header `X-SODA2-Truth-Last-Modified` tells you the dataset's freshness (use it
to decide whether to re-pull). This is the preferred path for any large table.

### Keyset (cursor) pagination — for incremental / API pulls

If you need the SODA JSON API instead of the whole-file export (e.g. for incremental
refresh), page with **keyset pagination on the `:id` system column**, never deep `$offset`
(deep offset is O(n²) on Socrata and times out on big tables):

```python
# Minimal generic Socrata keyset downloader.
# Pages a dataset by ascending :id so it scales to tens of millions of rows.
import requests

def socrata_keyset(portal: str, four_by_four: str, *,
                   app_token: str | None = None, page: int = 50000,
                   where: str | None = None, select: str = "*"):
    """Yield rows from a Socrata dataset using :id keyset pagination.

    portal        e.g. "data.cityofnewyork.us" or "data.ny.gov"
    four_by_four  the dataset id, e.g. "erm2-nwe9"
    app_token     optional; only raises the rate limit (bulk exports need none)
    page          rows per request (Socrata hard max is 50000)
    where         optional SoQL filter, ANDed with the keyset condition
    """
    url = f"https://{portal}/resource/{four_by_four}.json"
    headers = {"X-App-Token": app_token} if app_token else {}
    last_id = 0
    while True:
        cond = f":id > {last_id}"
        if where:
            cond = f"({where}) AND {cond}"
        params = {
            "$select": select,
            "$where": cond,
            "$order": ":id",       # ascending :id is the cursor
            "$limit": page,
        }
        rows = requests.get(url, params=params, headers=headers, timeout=120).json()
        if not rows:
            return
        for r in rows:
            yield r
        # Socrata exposes :id as ":id" only via $select=:id; when selecting * it is not
        # returned, so request it explicitly when you page:
        last_id = int(rows[-1][":id"])   # requires ":id" in $select (e.g. select=":id,*")
```

> Notes: request `:id` in your `$select` (e.g. `select=":id, *"`) so the cursor advances.
> Geo datasets sometimes 403 or return empty on `/resource/*.json` — for those use the
> **Export** endpoint (GeoJSON / Shapefile) or the DCP BYTES GDB downloads instead.
> Domain split is strict: MTA / NY-state datasets live on `data.ny.gov`, city datasets on
> `data.cityofnewyork.us` — use the matching token, no cross-domain calls.

### Non-Socrata sources

- **MTA GTFS static** — subway supplemented feed (`rrgtfsfeeds.s3.amazonaws.com`) + per-borough
  bus feeds; `shapes.txt` gives route geometry for the map.
- **NYC DCP BYTES of the BIG APPLE** — PLUTO / MapPLUTO, LION, and planimetric GDBs fetch
  fine from `nyc.gov/assets/planning/download/...` even when the landing pages 403. These
  arrive in native EPSG:2263.
- **U.S. Census** — TIGER/Line geometry + PL 94-171 / ACS counts (ACS needs `CENSUS_API_KEY`).

---

## 2. Lake — `python db/convert_lake.py`

Converts everything in `data/raw/` to a Parquet **lake** at `data/parquet/`, standardizing
geometry to EPSG:2263 (keeping 4326 display copies), partitioning giant tables (e.g. 311) by
year, and writing `db/LAKE_INVENTORY.json`. The lake is the source of truth; the database is
a regenerable query layer over it.

```bash
python db/convert_lake.py                     # everything
python db/convert_lake.py --only <slug1,slug2> # a subset
python db/convert_lake.py --skip-giants        # skip the multi-GB tables
```

## 3. Database — `python db/build_db.py`

Builds `db/jane_geo.duckdb` from the Parquet lake: `geo_*` (sidewalks, curbs, ramps, street
segments, census geometry, PLUTO, buildings, transit stops/stations), `pop_*` (block/BG/NTA
population + LODES), `transit_*` (GTFS static + ridership + segment speeds), `rt_*` (realtime
views over `realtime/archive/`), `qol_*` (311, crashes, trees, air quality), and the granular
cross-join tables `x_*` (per-block sidewalk stats, per-segment coverage, per-stop walkshed,
per-block service intensity). Every table carries `source_dataset_id, retrieved_at, vintage`
provenance columns. Full schema in [`db/SCHEMA.md`](db/SCHEMA.md).

```bash
python db/build_db.py     # lake -> jane_geo.duckdb (fresh build)
python db/doctor.py       # health gate: row counts vs inventory, CRS uniformity,
                          # GEOID join coverage, geometry validity — exit 0 = green
```

`doctor.py` is the phase gate — a green doctor means the database is coherent enough to
analyze and serve.

## 4. Analyze — `analysis/{sidewalk,bus,sai,access,renters}/`

Each analysis suite is a set of numbered, re-runnable scripts that read `jane_geo.duckdb`
(read-only) and write tables (Parquet + one-sheet XLSX) to `outputs/<suite>/`. Each suite
has a `METHODS.md` (with honest caveats) and a `FINDINGS_*.md` brief.

- **`analysis/sidewalk/`** — coverage classes (none / one-side / both-sides per segment),
  width derivation (centerline extraction), block-level coverage-vs-population equity,
  condition overlay (311 + DOT + tree root-heave), ADA ramp gaps.
- **`analysis/bus/`** — route demand (APC), segment speeds, service supply, realtime observed
  headways + bunching (from the poller archive).
- **`analysis/sai/`** — the per-bus-stop **Stop Accessibility Index**: walkshed population,
  sidewalk provision, ramp access, comfort (shelter/bench), condition, safety, and service
  intensity, joined into one 0–100 index. This is the cross-flagship signature analysis.
- **`analysis/access/`** — transit **accessibility / isochrones** via OpenTripPlanner
  (`otp_client.py` talks to a local/box OTP2 graph; `build_access.py` precomputes an
  isochrone grid + per-block jobs-reachable-≤45min equity table, joining LODES WAC). Ships a
  precomputed-grid fallback when OTP isn't running. See `access/METHODS.md`.
- **`analysis/renters/`** — the **Renter's Map** per-cell profile grid: `build_renters_grid.py`
  aggregates transit access, quality-of-life densities (percentile-ranked citywide), building
  facts (PLUTO/HPD/DOB) and flood risk per H3 cell; `verify_renters.py` sanity-gates it.
  Place-based metrics only — no demographic inputs (fair-housing). See `renters/METHODS.md`.
- **`analysis/bus/05_obs_precompute.py`** — precomputes the Bus Observatory dossier/league
  aggregates (segment speeds, observed-headway/bunching summaries with archive-depth stamps)
  the backend serves under `/api/obs/*`.

Run a suite in order:

```bash
python analysis/sidewalk/01_coverage_classes.py
python analysis/sidewalk/02_width_derivation.py
# ... 03_block_equity, 04_condition, 05_accessibility
```

## Realtime — `realtime/`

A single always-on asyncio poller harvests every NYC realtime transit feed (bus GTFS-RT +
all subway/SIR/LIRR/MNR feeds + alerts + Citi Bike + Ferry) into an hourly-partitioned
Parquet archive. See [`realtime/README.md`](realtime/README.md) for the feed table, the
BusTime 31 s rate floor (one hard rule — a violation can revoke your key), archive layout,
and ops. The site's backend can also serve live data directly; the archive gives history.

The archive path is env-driven (`NYCV_ARCHIVE_ROOT`, defaulting to `realtime/archive/`) so
the collection store can live on a separate drive — set it in `.env`, never in code.

### Derivation engine v2 — `realtime/derive2/`

Productionized replacement for the original `derive.py`. Reads the settled Parquet archive
(never the live feeds) and derives, idempotently by day-partition:

1. **Trip trajectories** (`trajectories.py`) — vehicle positions map-matched to GTFS shapes
   (nearest-point projection in EPSG:2263) → per-trip distance-along-route time series.
2. **Observed headways + bunching** (`headways.py`) — per route×stop×direction arrival events
   → headway series, scheduled-headway join, deviation, and a bunching index (headway CV +
   %<50% scheduled). Metrics from <14 days of archive are stamped **PRELIMINARY**.
3. **Adherence** (`adherence.py`) — observed vs scheduled per trip.
4. **Systemwide KPI rollups** (`kpis.py`) — the numbers the Ops Wall shows, per 5-min bin.
5. **Public dataset** (`package_headways.py`) — packages `derived/observed_headways/` as a
   downloadable CSV/Parquet dataset ("NYC Observed Bus Headways"), refreshed daily — a novel
   artifact MTA does not publish.

`run_derive.py` runs the incremental cycle; `run_derive.ps1` is the `JaneNYCDerive` scheduled
task wrapper (hourly, offset from poller flush windows). Methods: `derive2/METHODS_derive2.md`.

### GTFS change monitor — `changes/`

`snapshot.py` fetches the MTA GTFS static feeds every ~6h and stores content-hashed snapshots
(dedup by hash). `gtfs_diff.py` diffs consecutive snapshots into structured deltas (routes
added/removed, headway shifts per route×period, stop/service-span/shape changes) → a JSONL
feed + human-readable `CHANGELOG.md`. `run_diffs.py` is the scheduled driver; `run_snapshot.ps1`
the task wrapper. Powers the Service-Change Monitor page + `/observatory/changes`.

```bash
python realtime/derive2/run_derive.py     # incremental derivation cycle
python changes/run_diffs.py               # snapshot all feeds + diff new pairs
python analysis/access/build_access.py    # isochrone grid + equity table (OTP or precomputed)
python analysis/renters/build_renters_grid.py <stage>   # renter profile grid
```

---

## Rebuild recipe (TL;DR)

```bash
# acquire (one-time bulk pull; see §1) -> data/raw/
python db/convert_lake.py        # -> data/parquet/
python db/build_db.py            # -> db/jane_geo.duckdb
python db/doctor.py              # green gate
python analysis/sidewalk/01_coverage_classes.py    # ... run each suite
python realtime/poller.py        # start collecting the live archive
```
