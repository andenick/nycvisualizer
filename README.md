# nycvisualizer

**NYC granular mapping platform** — a live transit map and pedestrian-infrastructure
analyses of New York City at the finest measurable grain, built from NYC Open Data and
MTA realtime feeds.

> *Where can you go, and can you walk there?* — NYC transit service and pedestrian
> infrastructure, live.

Two flagship views:

- **Live Bus Map** — every MTA bus (and positioned subway/SIR train) on the map in near
  real time, fed by a server-side poller of the MTA GTFS-RT feeds. The browser never sees
  an API key.
- **Sidewalk Explorer** — citywide sidewalk **coverage** (none / one-side / both-sides per
  street segment), sidewalk **width**, block-level **coverage-vs-population equity**, a
  condition overlay (311 + DOT violations + street-tree root heave), an ADA ramp-gap layer,
  and a per-bus-stop **Stop Accessibility Index (SAI)** that joins the two flagships.

This is a monorepo with two halves:

| Path | What it is |
|---|---|
| [`/site`](site/) | The web app: a React + Vite + Leaflet single-page frontend and a FastAPI backend that holds all server-side keys. |
| [`/pipeline`](pipeline/) | The data pipeline: acquire (NYC Open Data / MTA) → Parquet lake → DuckDB geodatabase → analysis scripts, plus the realtime poller. |

The two halves are decoupled: the pipeline builds a DuckDB database + pre-generated map
layers, and the site serves them. You can run the site against the shipped map layers
without rebuilding the whole pipeline.

---

## Quickstart

### 1. The site (frontend + backend)

**Backend** (FastAPI — from `site/backend/`):

```bash
pip install -r requirements.txt
# Copy .env.example (repo root) to .env and fill in your own MTA BusTime key (see below).
# The backend reads keys + paths from the environment / that .env file.
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Frontend** (from `site/frontend/`):

```bash
npm install
npm run dev       # http://localhost:5173 (proxies /api -> 127.0.0.1:8000)
npm run build     # production build -> dist/
npm run preview   # serve the production build
```

The frontend ships with the pre-generated Sidewalk Explorer layers
(`site/frontend/public/layers/`) and a self-hosted NYC vector basemap
(`site/frontend/public/basemap/nyc-basemap.pmtiles`) — **no CDN, no third-party tile
server**. So the Sidewalk Explorer works immediately; the Live Bus Map needs the backend
running with an MTA BusTime key.

### 2. The pipeline (rebuild the data)

See [`pipeline/README.md`](pipeline/README.md) for the full acquire → lake → database →
analysis flow. In short:

```bash
# 1. acquire NYC Open Data / MTA datasets into pipeline/data/raw/  (see pipeline README)
# 2. convert raw -> Parquet lake, then build the DuckDB geodatabase:
python pipeline/db/convert_lake.py
python pipeline/db/build_db.py
python pipeline/db/doctor.py          # health gate: exit 0 = green
# 3. run the analyses:
python pipeline/analysis/sidewalk/01_coverage_classes.py   # ... etc
# 4. run the realtime poller to collect live transit archive:
python pipeline/realtime/poller.py
```

The heavy artifacts (the raw data, the Parquet lake, the `.duckdb` database, and the
realtime archive) are **not** committed — they are regenerable from public sources. Paths
are relative by default and overridable via environment variables (`NYCV_PIPELINE_ROOT`,
`JANE_GEO_DB`, `NYCV_OUTPUTS`, `DATA_ROOT`, …).

---

## API keys — bring your own

All keys are **server-side only** — they live in the backend environment and are never sent
to the browser or committed to git. Copy [`.env.example`](.env.example) to `.env` and fill
in your own. Every key below is **free**.

| Env var | Where to get it | Needed for |
|---|---|---|
| `MTA_BUSTIME_KEY` | Register at <https://register.developer.obanyc.com/> (name, email, purpose). Emailed within ~30 min. **Rate limit: ≤ 1 request / 30 s per key** — the poller respects a 31 s floor; a violation can get the key revoked. | The **Live Bus Map** (bus GTFS-RT + SIRI arrivals). |
| `SOCRATA_TOKEN_NYC` | **Optional.** Free app token from <https://data.cityofnewyork.us/signup> → Profile → Developer Settings → Create New App Token. | Raises the Socrata rate limit for the NYC city portal. Whole-file CSV exports (the primary bulk-download path) need **no** token. |
| `SOCRATA_TOKEN_NY` | **Optional.** Free app token from <https://data.ny.gov/profile/app_tokens>. | Same, for the NY State / MTA portal (`data.ny.gov`). |
| `CENSUS_API_KEY` | Free at <https://api.census.gov/data/key_signup.html> (emailed in minutes). | Census ACS 5-year and PL 94-171 population joins in the pipeline. |

The **subway / SIR / LIRR / Metro-North GTFS-RT** feeds, service alerts, Citi Bike GBFS, and
NYC Ferry feeds are all **key-free** — no registration needed.

---

## Honest data notes

- **Subway train positions are estimated.** The NYCT GTFS-RT feeds report trains *by
  station* (last observed station + status), not by GPS coordinate. Between stations,
  positions are **interpolated** along the GTFS route shape. The API flags each train's
  `positional_basis` as `"station"` (observed at a station) vs `"interpolated"` (an honest
  estimate). Bus positions, by contrast, are real GPS from the BusTime VehiclePositions feed.
- **Bus ridership is route/stop-level APC, not fare-gated.** The stop-level boarding numbers
  come from MTA Automated Passenger Counter (APC) data (route × direction × stop × hour),
  which is a sampled/modeled estimate, not a turnstile-exact count. Subway ridership is
  station-complex × hour (MetroCard/OMNY). (Legacy turnstile data is retired and not used.)
- **Sidewalk widths are remote-derived** from DCP planimetric polygons via centerline
  extraction (the sidewalkwidths.nyc method) — a geometric estimate, not a field survey.
  Coverage classes are validated against DOT field-inspection data where available.
- **Realtime archive is snapshot-based.** The poller stores independent per-cycle snapshots;
  it holds no durable cursor, so a restart is lossless beyond the current unflushed buffer.
  Derived headways/speeds are recomputed from the archive and reported honestly (a 0-row
  schedule join is reported as such, never faked).
- **CRS:** all length/area math is done in EPSG:2263 (NY State Plane Long Island, US survey
  feet); display copies are EPSG:4326.
- Every dataset carries its source ID, retrieval date, and vintage; every map layer records
  its source and vintage. See the site's **Data** and **Methodology** sections.

## Data sources & attribution

Built entirely from public data:

- **NYC Open Data** (Socrata: `data.cityofnewyork.us`) — sidewalks, curbs, ramps, streets,
  311, trees, crashes, and more. Terms: <https://opendata.cityofnewyork.us/overview/>.
- **NY State Open Data** (`data.ny.gov`) — MTA ridership, bus segment speeds, bus stops,
  subway stations.
- **MTA** — GTFS static + GTFS-RT realtime feeds and the BusTime API.
  <https://www.mta.info/developers>. MTA data is used under the MTA developer terms; the MTA
  is not affiliated with and does not endorse this project.
- **U.S. Census Bureau** — TIGER/Line geometry, PL 94-171 and ACS population.
- **NYC Department of City Planning (BYTES of the BIG APPLE)** — PLUTO, LION, planimetrics.
- **Basemap** — © OpenStreetMap contributors, rendered via Protomaps; self-hosted, no CDN.

You must comply with each provider's terms of use and attribution requirements when you
reuse the data. See [`LICENSE`](LICENSE) for the code license and a data-terms note.

## License

Code is released under the **MIT License** (see [`LICENSE`](LICENSE)). The underlying data
is **not** covered by that license — it belongs to its respective providers (NYC Open Data,
MTA, U.S. Census, OpenStreetMap) and is subject to their terms and attribution requirements.
