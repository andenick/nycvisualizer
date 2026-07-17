# nycvisualizer — site (SPA + API)

The `/site` half of the nycvisualizer monorepo: a React + Vite + Leaflet single-page
app (`frontend/`) and a FastAPI backend (`backend/`). The pipeline (ingest, realtime
poller, geodatabase, analysis) lives in `/pipeline`.

> **Where can you go, and can you walk there?** — NYC transit service and pedestrian
> infrastructure at the finest measurable grain, live. Part of the
> [Heterodata](https://heterodata.org) ecosystem.

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

Sidewalk Explorer layers are pre-generated GeoJSON under `frontend/public/layers/`
(built by `tools/build_layers.py` from `jane_geo.duckdb` + the analysis outputs;
simplified + coordinate-rounded for the web, full resolution in the GeoParquet
downloads). Methodology pages are pre-rendered HTML built by `tools/build_content.py`
(no literal markdown ships). Interactive charts use bundled plotly (lazy chunk, no CDN)
per the Universal Graph Contract.

## Basemap

`frontend/public/basemap/nyc-basemap.pmtiles` is a NYC-extent Protomaps vector basemap
(derived from OpenStreetMap), rendered client-side by `protomaps-leaflet` — **no CDN, no
third-party tile server**. To regenerate:

```bash
pmtiles extract https://data.source.coop/protomaps/openstreetmap/v4.pmtiles \
  nyc-basemap.pmtiles --bbox=-74.30,40.45,-73.65,40.95 --maxzoom=14
```

A raster fallback exists behind `VITE_BASEMAP_MODE=raster-todo` but it hits a third-party
host and is **not** no-CDN compliant — never ship it as the default.

## Standards

Follows the Arcanum Site Kit chrome + dual-anchor footer, and the draft
`ARKMAP_STANDARD.md` (Carson DNA): self-hosted basemap, legend + attribution, per-layer
vintage, honest realtime "as of" stamp, and the D-4 geospatial download carve-out
(GeoJSON + GeoParquet for geometry; CSV/XLSX/Parquet for tabular).
