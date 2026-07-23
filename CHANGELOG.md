# Changelog

All notable changes to nycvisualizer are recorded here.

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
