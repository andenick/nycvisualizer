# nycvisualizer — site (SPA + API)

The `/site` half of the nycvisualizer monorepo: a React + Vite + Leaflet single-page
app (`frontend/`) and a FastAPI backend (`backend/`). The pipeline (ingest, realtime
poller, geodatabase, analysis) lives in `/pipeline`.

> **Where can you go, and can you walk there?** — NYC transit service and pedestrian
> infrastructure at the finest measurable grain, live. A standalone product built by
> Nick Anderson ([nickanderson.us](https://nickanderson.us)); de-federated from the
> Heterodata ecosystem 2026-07-24 (keeps the engineering standards, drops the federation).

## Layout

```
site/
  frontend/            React 18 + Vite + TypeScript + Leaflet
    public/
      _shared/         Vendored Arcanum Site Kit chrome (css/js/fonts/favicon/ecosystem) — NO CDN
      basemap/         nyc-basemap.pmtiles  (self-hosted Protomaps/OSM vector basemap, NYC extent)
    src/
      chrome/          Compilable copies of ReactChrome.tsx + ArkTriad.tsx + ecosystem.json
      components/      BusMap.tsx (Live Bus Map)
      lib/             api.ts (typed backend client + SSE), basemap.ts (pmtiles loader)
      pages/           Landing, Bus, Sidewalks, Data, Code, Methodology, About, NotFound
  backend/             FastAPI — holds ALL server-side keys; browser talks only to this
    app/               main.py, config.py, realtime.py, gtfs.py, siri.py
```

## Architecture (keys never reach the client)

The browser talks **only** to the backend. The MTA BusTime / Socrata / Census keys live
in the backend environment (a gitignored `.env` at the NYCPlatform root) and are never
sent to the client or committed. The Vite dev server proxies `/api` to the backend.

## Run it locally

**Backend** (from `site/backend/`):
```bash
pip install -r requirements.txt
# reads keys + paths from ../../.env (NYCPlatform root) by default; override via env:
#   DATA_ROOT, REALTIME_ARCHIVE, GTFS_STATIC_ROOT, MTA_BUSTIME_KEY, CORS_ORIGINS
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Frontend** (from `site/frontend/`):
```bash
npm install
npm run dev      # http://localhost:5173 (proxies /api -> 127.0.0.1:8000)
npm run build    # production build -> dist/
npm run preview  # serve the production build
```

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness + archive/gtfs/key presence |
| `GET /api/rt/vehicles` | freshest bus vehicle positions (archive-first, live GTFS-RT fallback) |
| `GET /api/rt/vehicles/stream` | SSE, one snapshot ~every 30s |
| `GET /api/rt/alerts` | service alerts (archive or live) |
| `GET /api/rt/subway` | positioned subway/SIR trains, all 8 NYCT feeds (archive-first, key-free live fallback). NYCT reports trains by station; between stations positions are interpolated along the GTFS shape and flagged `positional_basis: "interpolated"` (vs `"station"` for observed at-station reports) |
| `GET /api/rt/subway/stream` | SSE, one subway snapshot ~every 30s |
| `GET /api/routes` | GTFS static bus route catalog |
| `GET /api/routes/{route_id}` | simplified route shape polylines + stops |
| `GET /api/stops/{stop_id}/arrivals` | on-demand SIRI StopMonitoring arrival board (bus) |
| `GET /api/stations` | subway station catalog (parent stations + serving routes) |
| `GET /api/stations/{id}/arrivals` | live arrivals board for one station (key-free trip-updates, cached ~30s per line-group feed) |
| `GET /api/downloads` | download inventory (whitelist registry; D-4 formats) |
| `GET /api/downloads/{key}` | file download with correct content-type (GeoJSON `application/geo+json`, parquet `application/octet-stream`, etc.) |
| `GET /api/changes` | paginated/filterable detected GTFS service changes (S3 diff engine) |
| `GET /api/changes/feed.json` · `GET /api/changes/rss` | machine + RSS feeds of changes |

### Bus Observatory (`/api/obs/*`, S5)

The route-reliability + Marey-diagram surface. Reads derive2's hourly-refreshed outputs
(`realtime/derived/{trajectories,observed_headways}`) + its GTFS static cache
(`realtime/derive2/cache/`), the bus analysis outputs (`Outputs/NYCPlatform/bus/`), SAI
(`Outputs/NYCPlatform/sai/`), live positions (the `/api/rt` layer), and two precomputed
dossier aggregates (`Outputs/NYCPlatform/bus/obs/`, built by `analysis/bus/05_obs_precompute.py`
on the `JaneNYCDerive` cadence — route-hourly ridership + ACE counts, to keep the dossier off
the 5.4 GB jane_geo DB at request time). All roots are env-overridable (`NYCV_DERIVED_ROOT`,
`NYCV_DERIVE2_CACHE`, `NYCV_OUTPUTS_ROOT`, `NYCV_BUS_OUTPUTS`, `NYCV_OBS_PRECOMPUTE`,
`NYCV_SAI_DIR`), relative by default.

| Endpoint | Purpose |
|---|---|
| `GET /api/obs/routes` | all bus routes + borough group, SBS flag, yesterday's headline stats (median headway, bunching index, coverage) |
| `GET /api/obs/marey?route&direction=0\|1&window=3h\|6h\|today&date=YYYY-MM-DD&end=<epoch>` | Marey trajectory data: observed trips (archive, ~60 s-resampled) **+** scheduled ghost trips (from GTFS stop_times) **+** stop gridlines; merges LIVE positions for a window ending now. `end` (epoch s) is optional (defaults to now / last data point) and drives brush-zoom |
| `GET /api/obs/marey/stream?route&direction` | SSE, incremental live trajectory points ~every 30 s |
| `GET /api/obs/headways?route&stop_id&date_range` | observed-vs-scheduled headway series + bunching per hour (stop grain if `stop_id`, else route-hour) |
| `GET /api/obs/headways/summary?route&direction` | per-stop medians for the strip view (ordered by along-route offset) |
| `GET /api/obs/dossier?route` | full route profile: ridership-by-hour, slowest segments, ACE, SAI-of-stops, stop spacing, scheduled span/frequency, reliability summary, active alerts |
| `GET /api/obs/leagues` | league tables: most/least reliable routes (≥3 observed days & ≥50 headways, else excluded), slowest corridors, most-improved-vs-schedule |

Every reliability response carries an `archive` block `{archive_depth_days, preliminary
(depth<14), gap_note, observed_dates}` — frontends render a PRELIMINARY badge until 14-day
depth. **Route ids that contain `+` (SBS variants, e.g. `M15+`) MUST be percent-encoded as
`%2B` in query strings** (a bare `+` decodes to a space). Marey y-axis is distance-along-shape
in feet on the route+direction's canonical (most-used) shape; timestamps are UTC epoch seconds.
Marey is cached 30 s per `(route,dir,window,date)`; dossier/leagues 10 min.

Sidewalk Explorer layers are pre-generated GeoJSON under `frontend/public/layers/`
(built by `tools/build_layers.py` from `jane_geo.duckdb` + the analysis outputs;
simplified + coordinate-rounded for the web, full resolution in the GeoParquet
downloads). Methodology pages are pre-rendered HTML built by `tools/build_content.py`
(no literal markdown ships). Interactive charts use bundled plotly (lazy chunk, no CDN)
per the Universal Graph Contract.

## Basemap

`frontend/public/basemap/nyc-basemap-z15b.pmtiles` is a NYC-extent Protomaps vector basemap
(derived from OpenStreetMap), rendered client-side by `protomaps-leaflet` — **no CDN, no
third-party tile server**. 94.65 MiB (99,248,382 B), zoom 0–15, bounds
`-74.28,40.49,-73.69,40.92`, Protomaps basemap schema **v4.15.0**, OSM vintage
**2026-07-22T04:00:00Z** (built upstream by Planetiler 0.10.2).

Regenerate with the committed script — **`tools/build_basemap.sh`**, which wraps:

```bash
pmtiles extract https://build.protomaps.com/20260722.pmtiles \
  nyc-basemap-z15b.pmtiles --bbox=-74.28,40.49,-73.69,40.92 --maxzoom=15
```

Verified 2026-07-24: re-running this reproduces the shipped file **byte-for-byte**
(sha256 `6fee904a…5e72b79`). This corrects two earlier claims in this repo — the older
`data.source.coop … --maxzoom=14` recipe documented here was superseded by the z15 rebuild,
and `PERF_BASELINE.md` / `CHANGELOG.md` described the file as "built with Planetiler". It is
a **`pmtiles extract` of a Protomaps planet build that Planetiler produced upstream**; no
Planetiler run happens here. (Proof: the archive still contains whole-planet low-zoom tiles —
z4 covers Toronto, Cuba and the Bahamas — which a locally bounded Planetiler build cannot
emit, because Planetiler clips tile *content* while `pmtiles extract` copies whole tiles.)

⚠️ **Ship every rebuild under a NEW filename.** `/basemap/*` is immutably cached at Caddy and
Cloudflare, so overwriting serves stale bytes for 24 h — hence the `-z15b` suffix. Update
`BASEMAP_URL` in `frontend/src/lib/basemap.ts`; the canaries read that constant.

⚠️ **Always run `tools/rule_canary.mjs` after a rebuild** (the build script does it for you).
A newer planet build can change the tile schema, and a schema the bundled `protomaps-leaflet`
style does not match renders a **map with no roads and no street labels that still passes a
pixel check** — that shipped for weeks and was only caught by eye on 2026-07-24. See
"Canaries" below.

A raster fallback exists behind `VITE_BASEMAP_MODE=raster-todo` but it hits a third-party
host and is **not** no-CDN compliant — never ship it as the default.

### Canaries

| Tool | Answers | Blind to |
|---|---|---|
| `tools/paint_canary.py` | Did the live edge serve APIs, assets and **painted basemap pixels**? | Which features painted — buildings alone keep it green |
| `tools/rule_canary.mjs` | Do the shipped style's **rules actually match features** in the shipped tileset (roads, named streets)? | Whether the browser drew them |

`paint_canary.py` runs both. A deploy is not done until it passes against the live edge.

## Standards

Follows the Arcanum Site Kit chrome ("heterodata-LEVEL" standards) with the standalone
footer (single "Built by Nick Anderson — nickanderson.us" line, no ecosystem switcher /
dual anchors — de-federated 2026-07-24), and the draft
`ARKMAP_STANDARD.md` (Carson DNA): self-hosted basemap, legend + attribution, per-layer
vintage, honest realtime "as of" stamp, and the D-4 geospatial download carve-out
(GeoJSON + GeoParquet for geometry; CSV/XLSX/Parquet for tabular).
