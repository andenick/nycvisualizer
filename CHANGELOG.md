# Changelog

All notable changes to nycvisualizer are recorded here.

## 2026-07-23 — Q1 map visualization overhaul (dots → centerlines)

Streets become the canvas: sidewalk coverage and bus reliability now read ON the
road lines, not in dots. Verified live (containers serving new dist + retiled
tiles + new endpoints).

### Sidewalk Explorer
- Coverage centerlines are the HERO layer, ON by default, from a vector-tile
  overlay (`/layers/coverage.pmtiles`, Z10–16) via protomaps-leaflet paint rules
  — replacing the multi-MB per-borough GeoJSON fetch (files kept for downloads).
- Deficiency-forward: no-sidewalk = loud red + dashed (CVD redundancy), one-side
  = amber, both-sides = quiet thin green; zoom-scaled widths.
- Width-mode toggle: thickness ∝ √(median sidewalk width) — new `w` attribute
  joined from `02_width_segments` into the tiles (97% of segments measured).
- One-hot color law: SAI is mutually exclusive with hot coverage (coverage →
  neutral hairline when SAI active); SAI ramp swapped viridis → green-free
  magma-style; theme-aware paint; per-layer vintage stamps from the tile sidecar.

### Bus Observatory / dossier
- Reliability ribbon: stop-pair segments colored by within-route speed percentile
  (diverging red→gray→blue); live buses as oriented arrow markers. New additive
  `GET /api/obs/ribbon?route=` (parquet-only; `02_segment_geometry.parquet`).
  Width is color-only — per-segment ridership is not derivable, so none is faked.
- The /bus selected-route line is upgraded to the same ribbon coloring.

### Renter's Map
- Nested 15/30/45/60-min isochrone bands (darkest = nearest); compare mode =
  outlines only (A accent, B violet).

### Ops Wall
- Bunching connector line between the two paired buses (severity color + width);
  pulsing midpoint dot stays. `/api/wall` hotspots now carry both bus positions.

### Palette discipline
- Every ramp run through the dataviz `validate_palette.js` (light + dark); the
  one categorical risk (coverage amber↔green) is covered by the redundant width +
  dash channels.


## 2026-07-23 — Q0 hotfix wave

Refinement-campaign hotfix wave. Small, root-caused fixes; no map-rendering
overhaul (that lands in a later wave). All fixes verified live on
https://nycvisualizer.com.

### Fixed
- **Dark-mode white panels.** Defined the never-defined `--ark-surface` /
  `--ark-border` CSS tokens (aliased to the theming neutrals `--ark-bg-soft` /
  `--ark-line`). ~15 surfaces — hub cards, all Leaflet map controls/legends,
  observatory panels/chips, tables — were falling back to a light literal in
  dark mode. They now theme correctly in both schemes and under the manual
  theme toggle.
- **Renter's Map blank basemap on cold load.** Added `preferCanvas`, a
  `ResizeObserver → invalidateSize()`, and a post-mount re-center tick so the
  map is correctly sized (and its tile grid instantiated) even when it mounts
  before the flex container resolves height.
- **Mobile bus alert overlap.** Collapsed the stacked service-alert callouts
  into a single dismissible "⚠ N service alerts" pill (top-right) that expands
  to a scrollable drawer and never covers the top-left filter control.

### Added
- **Subdomain spoke routing.** On boot, a spoke subdomain root
  (`observatory.` / `ops.` / `renters.` / `changes.`) lands on its spoke path
  instead of the hub; deep/shared URLs are left untouched.
- **`/api/healthz`** health route (edge-reachable; a bare `/healthz` is shadowed
  by the SPA fallback at the edge).

### Changed
- **Typography.** Tabular-nums on data-table numeric cells; stray prose capped
  at a 72ch measure (landing "What this is", methodology intro/outro,
  observatory exclusion caption); methodology intro bumped to 15px; small
  green/amber status numerals darkened to AA-contrast (`#1a7f37` / `#b8860b`);
  Marey diagram gains a "live trip" legend entry and a wider y-axis label gutter
  with middle-truncation.

### Performance
- **Deferred Plotly.** The ~1.49 MB Plotly chunk now mounts via
  IntersectionObserver, so landing first-paint no longer fetches it (verified:
  0 fetches before scroll, 1 after).
- **Warm `/api/wall`.** A 25 s server-side background refresher keeps the Ops
  Wall aggregate warm so a cold visitor gets the cached payload.
- **SSE reconnect.** `streamJSON` now drives its own bounded exponential backoff
  (2 s → 30 s, reset on a good frame) instead of relying on the browser's
  uncontrolled EventSource auto-reconnect, eliminating the
  `/api/rt/vehicles/stream` `ERR_ABORTED` churn.
- **Dossier fetch dedupe.** The SBS "+" sibling dossier is probed only when the
  routes catalog confirms a sibling exists, instead of for every plain route.
- **Long-cache geo assets.** `/layers/*` and `/basemap/*` now serve
  `Cache-Control: public, max-age=86400, immutable` (edge Caddy config).
