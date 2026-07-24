# Changelog

All notable changes to nycvisualizer are recorded here.

## 2026-07-24 — Ant Farm v3 W1 (client) + W6.1 basemap depth

The client half of the "make the ant farm appear continuous — simply, honestly" motion
upgrade, plus the "roads must never disappear" basemap fix. Deployed + verified live
(paint canary 10/10 PASS).

- **Shape-following motion model** (`VehicleFlowLayer` + `lib/shapeCache.ts`): a bus carrying
  a backend `shape_id` + `route_offset_ft` now glides ALONG its route shape from its last
  reported offset at `speed_est_fps` — never a straight line through blocks, never a teleport.
  Shape geometry is lazy-fetched per visible route from `/api/rt/route_shapes` into an
  LRU cache (~50 shapes), with precomputed cumulative-length arrays for an O(log n)
  offset→point lookup. Buses without shape data keep the straight prev→cur glide.
- **Decay-to-stop (sparse-data humility):** with no fresh report a gliding bus eases to a
  full stop over ~45 s and resumes on the next ping — it never sails on indefinitely.
  Dwelling buses (offset not advancing) dock in place with a subtle pulse; **no fake creep**.
- **Snap-correct, honestly:** a fresh report landing > 200 ft from the prediction closes the
  gap with a fast ease (≤ 1 s), never a visible rubber-band. Between-tick prediction error is
  sampled to a ring buffer — **median ~73 ft** live (via the `?perf` hook).
- **On/offline:** new vehicles fade in; a vehicle missing > 3 ticks fades out and emits a
  coalesced `bus_offline` telemetry beacon.
- **Frame budget:** z11–z13 with motion trails on measured **< 8 ms/frame @ 60 fps** live
  (peak z12 6.31 ms at ~825 units); the degrade ladder never engaged across z10→z19.
- **W6.1 — roads never disappear:** the NYC basemap is rebuilt at **maxzoom 15** with
  **Planetiler** (official Protomaps profile) — `nyc-basemap-z15b.pmtiles`, replacing the
  36 MB maxzoom-14 extract. `basemap.ts` sets `maxDataZoom: 15` + `maxNativeZoom: 16` so
  z16 resolves real z15 road data and z17–z19 CSS-scale that tile — every road stays
  rendered on the deepest overzoom instead of blanking. Verified at z16/z17/z19 in dense
  (Midtown) and suburban areas, light + dark. Size: 36 MB → ~95 MiB (range-served,
  edge-cached).

## 2026-07-23 — Ant Farm v3 W1 (server): shape-following motion model + route adherence

Backend half of the "make the ant farm appear continuous — simply, honestly" motion upgrade.
The client glide (W1-client) lands separately; this ships the data it needs. Deployed +
verified live (paint canary 10/10 PASS).

- **Bus route→shape LUT, built once at startup** (`app/busshapes.py`) — mirrors the subway
  seg-LUT pattern: a disk-cached pickle keyed by a GTFS-static content fingerprint, holding
  per (route_id, direction_id) the canonical (most-detailed) shape decimated with a
  Ramer–Douglas–Peucker pass in **EPSG:2263 feet**, carrying each kept vertex's *full-shape*
  cumulative offset so a projected offset stays in the same ft space as derive2's speed table.
  **683 route×directions / 345 routes**, median 47 verts/shape; build ~4 s cold, ~0 ms warm.
- **`/api/rt/vehicles` additive fields** (`app/motion.py`, enrichment folded into the existing
  10 s TTL cache — runs once per build, not per request): `shape_id`, `route_offset_ft`
  (nearest-point projection of the GPS onto the route shape), `speed_est_fps` + `speed_basis`.
  Honesty guards ported from `trajectories.py`: **off-shape > 200 ft** or a **> 500 ft backward
  (non-monotonic) offset jump** between a bus's prev and latest ping → shape fields **omitted
  and counted** (surfaced in a new `motion` summary block). Shape coverage **~99.5 %** of live
  buses. Projection validated: reconstructing a bus's position from `route_offset_ft` lands
  within **p50 2.3 ft / p99 12.5 ft** of its actual GPS.
- **Blended `speed_est_fps`** — observed displacement/Δt (archive path, sane 1–90 fps) →
  per-route×half-mile-segment median → per-route median → 12 fps citywide default, tagged by
  `speed_basis`. Medians come from a new consolidated **speed table** (`route_segment_speeds/`,
  13,396 segment rows over 23.1 M along-shape observations, citywide median **10.4 fps ≈ 7.1 mph**).
- **Route-adherence metric** (`pipeline/realtime/derive2/adherence2.py`, new stage folded into
  `run_derive.py`; backfilled all 8 archive days) — per route×day share of pings within 100 ft
  of the trip shape, first/last 500 ft excluded. **Honest finding: MTA BusTime reports positions
  already map-matched to the route path** (97 % of pings within 1 ft), so on-route reads
  **≈99.999 % citywide / 100 % median route** and chiefly confirms position quality; only genuine
  reroutes push a bus past 100 ft (worst routes BX46/S98/M8 ≈ 99.98 %). Exposed at
  **`/api/obs/adherence?route=`** (summary + daily series; citywide distribution when no route),
  with the snapping caveat baked into the payload.
- **`/api/rt/route_shapes?route=&direction=`** — the exact decimated lat/lon polyline
  `route_offset_ft` is measured against, with a cumulative `offset_ft` per vertex, so the motion
  client can place a bus along the same geometry.
- **Dep:** the API image now installs **pyproj** (coordinate transform only; projection +
  decimation are hand-rolled in numpy — no shapely in the API).

## 2026-07-23 — Ant Farm v2 F5: reliability (never ship a blank map silently)

Graceful degradation + observability + a mechanical deploy gate, so the F0 blank-basemap
class of bug can never ship or persist unseen. Deployed + verified live on nycvisualizer.com
(post-deploy paint canary **10/10 PASS**).

- **Raster basemap fallback, auto-engaged** — the OSM raster path was tree-shaken out of the
  build; it is now re-included and wired to the F0 regression guard. On **empty paint rules**
  (the exact `flavor`→`theme` failure) OR **>30 % tile errors in the first 15 s** (measured via
  `tileloadstart` vs `tileload`, since protomaps-leaflet swallows fetch errors) OR **zero painted
  pixels**, the guard swaps the broken vector basemap for OSM raster tiles and shows a visible
  **"simplified basemap"** chip — a real map instead of a blank void. Proven by a simulated
  failure (bogus theme → empty paint rules → auto-engage screenshotted), then reverted. The
  raster path is a deliberate, chip-labelled degraded-mode exception to the no-CDN rule, engaged
  only when the self-hosted basemap is provably broken.
- **Client error beacon** — map pages POST `{page, kind, detail, ua}` to `/__track` on caught
  map-init errors, guard-triggered fallback, zero-painted-tiles after 10 s, and SSE
  permanently-down (>5 consecutive failures). The backend `/__track` now appends events as
  greppable JSONL (`kind=map_error`); a Caddy route was added so the bare `/__track` path
  actually reaches the API instead of being swallowed by the SPA fallback. Ops: **grep the box
  telemetry for `kind=map_error`**.
- **Post-deploy paint canary** — `site/tools/paint_canary.py` drives a headless browser to prove
  the basemap paints **pixels** on /bus, /live/subway, /sidewalks and that the RT endpoints serve
  live counts + the pmtiles assets are servable. One PASS/FAIL line per check, exit code gates the
  deploy: **a deploy is not done until paint_canary PASSES against the live edge.** Added to the
  REFRESH.md regeneration/verify chain and the box deploy README.
- **Periodic synthetic check** — `JaneNYCCanary` (Windows Scheduled Task, every 6 h, offset 3 h
  from `JaneNYCGtfsSnap`) runs the canary against the live edge and logs PASS/FAIL to
  `realtime/logs/canary.log` — the silent-regression net.
- **bbox adoption on immersive + /bus** — rt polls now send `?bbox=<viewport>` (updated on
  `moveend`, debounced; **SSE unchanged**), and refetch on pan so units entering the viewport
  appear immediately. Measured live payload reduction: **79 % (borough view) → 92 % (neighborhood)
  → 97 % (few blocks)**; the whole-city default view trims ~23 % (little to cut there).

## 2026-07-23 — Ant Farm v2 F4: restrained live-map enhancements

Four subtle, intelligibility-serving additions to the live maps — nothing else (the
not-overcrowding pact holds). All four ride the shared `VehicleFlowLayer`, so /bus and
/live/* get them at once; theme-aware; verified live on nycvisualizer.com in both themes + 390px.

- **Follow mode** — click a vehicle → its popup gains a **▸ Follow** action; the camera then
  eases to track it (`panTo` easing, zoom kept) while a minimal *"Following M15 bus 4821 —
  tap map or press ESC to stop"* pill shows. Works for buses **and** subway worms (tracks the
  worm's head). Dismisses on ESC, map-tap, or the unit going away. No standing UI otherwise.
- **Focus dim** — from the vehicle popup (and the follow pill) **◎ Focus route/line** drops all
  other units to **25 % alpha with their trails off**, so the chosen flow pops; the focused
  bus route's **shape overlays** (subway is dim-only — line shape isn't cheap). One-tap clear
  chip. Plays with the legend + filters.
- **Motion trails** — a ~20 s fading tail per moving unit (thin, theme-aware, rendered from a
  per-unit ring buffer into the same canvas; ≤12 points, alpha ramp to 0, **banded** to ≤3
  strokes/unit). Perf-budgeted and measured headless at **3,000 units**: trails-on stays
  ≤ **8.9 ms/frame** at z11–13 (the ~9 ms at z12 is the base all-visible shape draw, not
  trails). Trails are the **first** thing the degrade ladder sheds (before dropping fps).
  Legend **"Motion trails"** toggle — default **ON** for /live/*, **OFF** for /bus.
- **Honest clock** — the as-of chip promoted to an always-visible, glanceable *"live · updated
  mm:ss ago"* corner chip on /live/*, stacked by the legend chip; real age, stale/error dot.

## 2026-07-23 — Ant Farm v2 F3: capacity hardening (origin O(1) in users)

Load-testing the live edge showed the RT poll endpoints re-read parquet/GTFS-RT via
duckdb on **every request** (no shared connection), so origin CPU scaled ~linearly with
concurrent users: the p95 < 5 s knee was **below 50 users**, and polls started timing out
and erroring at ~100 concurrent users. This wave makes the origin **O(1) in users**.

- **In-process TTL single-flight cache** (`app/runtime.py::TTLCache`,
  `NYCV_RT_CACHE_TTL_S=10`) wrapping `get_vehicles` / `get_subway`. The expensive read now
  runs at most once per 10 s per worker regardless of load; concurrent misses await ONE
  recompute (no thundering herd). Measured effect at 500 VU: poll errors **88.8 % → 23.4 %**,
  api-container CPU **~365 % → ~190 %**, box load **~10.2 → ~7.2**; **0 % errors through
  200 users** (was 20–29 %).
- **`Cache-Control: public, s-maxage=10, stale-while-revalidate=20`** on `/api/rt/vehicles`,
  `/api/rt/subway`, `/api/wall` (origin-side edge-cache hint; SSE stays `no-cache`). Worst-case
  data staleness bounded ~61 s, typical ~35 s; the `as_of` stamp always shows true age.
- **`?bbox=minLon,minLat,maxLon,maxLat`** viewport filter on the two RT endpoints —
  server-side, **additive, default = full**, applied to the cached payload (never mutated),
  sets `bbox_filtered` + recomputed `count`, malformed bbox → full payload. A Manhattan
  viewport cuts payload **−78 % (vehicles) / −63 % (subway)**.
- **SSE ceiling** (`app/runtime.py::SSELimiter`, `NYCV_SSE_MAX=200` per worker) shared across
  the vehicles/subway/wall streams; over cap → **`429` + `Retry-After: 30`**, and the client's
  existing 30 s poll fallback engages automatically.
- **uvicorn tuning** (`Dockerfile.backend`): `--workers 2 --timeout-keep-alive 15 --backlog 2048`.

See `CAPACITY.md` (project tree) for the full before/after tables and the ⛔ Cloudflare Cache
Rule paste-block (Cloudflare does **not** cache these JSON paths on `s-maxage` alone —
`cf-cache-status` stayed `DYNAMIC`; the rule is required to add the edge/bandwidth half).

## 2026-07-23 — Ant Farm v2 Wave 1: at-station train rings + shared legend

Trains reported *at a station* (~54% of the fleet at rush hour) were hidden under the
opaque white station discs at zoom ≥ 13 — the map looked like most trains had vanished.

- **At-station rings:** docked trains now render as a **line-colored ring** around the
  station position, drawn on the vehicle canvas which was raised to its own Leaflet pane
  at `z-index 450` (above the station SVG at 400). Moving units — in-transit worms and
  buses — now pass cleanly *over* stations instead of under them. Station discs shrink
  (r 3.5 → 2.5, fill-opacity 1 → 0.85) so the ring reads as "wrapped around" the stop.
  Every train now has a visible, distinct state: solid worm (moving) · faded (estimated
  between stations) · ring (docked).
- **Shared `MapLegend`:** one collapsible corner "Legend" chip across `/bus`,
  `/live/bus`, `/live/subway`, `/sidewalks`, and `/ops` (replacing the ad-hoc per-map
  legends). Shows true-scale shapes, color meanings (subway line bullets / borough
  colors / coverage classes / bunching severity), motion semantics ("updates ~30 s;
  movement between updates is estimated"), and a state row; folds the data-vintage /
  as-of stamps in. ≤ 8 visible lines with a "Details" expander; collapsed by default on
  immersive `/live/*`, expanded elsewhere. Both themes, verified at 390 px.
- **SSE console noise:** the `/api/rt/*/stream` `ERR_ABORTED` churn is silenced — the
  EventSource handlers are detached before each close, and the bus/subway streams no
  longer re-subscribe on visibility toggles (visibility is handled separately).
- **`seg_basis` (forward-compat):** the client consumes the backend's new
  `seg_basis` field ("straight" prev→next glide vs real "shape" polyline) when present,
  with a marginally simpler underlay for straight-basis worms; fully backward-compatible
  when the field is absent.

Verified with a real paint check (headless CDP; all five surfaces, both themes, 390 +
1280) locally and live on nycvisualizer.com: docked trains render as visible rings at
z13–15, worms pass over stations, legends present on every surface. Frontend-only deploy;
the paired subway seg-coverage backend change ships separately.

## 2026-07-23 — P0 fix: basemap now paints on every map page

The Protomaps vector basemap was fetching tiles but painting nothing on every map
page, in production, for all users. Root cause: `addBasemap()` passed `flavor:` to
protomaps-leaflet's `leafletLayer()`, but that library (v4.1.1) reads `theme:` —
`flavor` is the separate MapLibre `@protomaps/basemaps` API. An unrecognized option
falls through to empty `paintRules`/`labelRules`, so the layer renders blank.

- `basemap.ts`: `flavor:` → `theme:` (`"dark"`/`"light"` are valid keys in the lib's
  themes registry). Basemap now paints in both light and dark.
- Regression guard: after layer construction, assert non-empty `paintRules`; on an
  empty rule set, `console.error` and show a "basemap style failed to load" chip in
  the map corner, so a silent recurrence can never ship again.
- Cosmetic: Leaflet container background now uses the theme bg token (Leaflet's
  default `#ddd` was a wrong-colored void in dark mode before tiles paint).

Verified with a real paint check (headless CDP; `/bus`, `/live/subway`, `/sidewalks`;
light + dark) locally and live: every basemap tile canvas paints (nonzero-alpha
pixels), guard silent.

## 2026-07-23 — Immersive full-window ant-farm views (`/live/bus` + `/live/subway`)

_Bus view canonical path is `/live/bus` (singular) on `bus.nycvisualizer.com`; the legacy
`/live/buses` path redirects to it client-side and `buses.` is a silent host alias, so nothing
previously shared breaks._

Two new chrome-less, full-window homes for the live ant farm — one for buses, one
for the subway — each on its own route and additive vanity subdomain. They REUSE
the existing `VehicleFlowLayer` renderer (not forked); no new data or claims.
Built, deployed, and verified live end-to-end (headless Chrome; both themes;
1440 / 834 / 390; motion confirmed).

### New `ImmersiveMapPage` (I1)
- `100dvw × 100dvh` map canvas with safe-area insets (`viewport-fit=cover`), **zero
  page scroll**, and no standard header/footer — the immersive routes render
  OUTSIDE the site chrome. Both themes.
- **Floating top strip** (the "links at the top"): identity mark → hub, a Buses/Subway
  mode switch, and links back into the site (Transit Map · Observatory · Ops Wall ·
  Sidewalks · Renter's Map · Data). Collapses to a menu at mobile widths; **auto-fades
  to a thin grab-tab after ~5 s idle** and reappears on any pointer / touch / key.
- **Corner ⓘ overlay** carries the mandated **dual anchors** (heterodata.org +
  nickanderson.us), basemap attribution, the data-vintage / honesty stamp (with a live
  ms/frame readout), and a **theme toggle** — so identity/D9 pass without page chrome.
- **Mode scoping:** `/live/bus` = ant-farm buses only, with a route filter (loads the
  shape + shape-snapped glide) and a borough-vs-route color toggle; `/live/subway` =
  track-worms only, with line filter chips (official MTA bullets), station dots at
  zoom ≥ 13, and estimated positions honestly faded.
- **Shareable URL state** (`?ll=&z=&route=|line=`), per-mode `document.title`, and a
  `canonical` link to the apex path (the subdomains are additive — no duplicate content).

### Wiring (I2.1)
- SPA boot host→path map extended: `bus.` (and silent alias `buses.`) → `/live/bus`,
  `subway.` → `/live/subway`.

### Integration (I3)
- Landing + Maps hub gain Bus/Subway Ant Farm cards; `/bus` links "full-window view →"
  for each mode; ecosystem manifest lists both immersive pages.

_The `bus.` / `subway.` Cloudflare Public Hostnames are a user-side (DNS/tunnel) step;
the apex paths `/live/bus` and `/live/subway` work standalone without them._

## 2026-07-23 — Live Transit Map "ant farm": animated true-scale vehicle canvas

The `/bus` Live Transit Map now renders every bus and subway train as a
TRUE-SCALE, bearing-oriented shape that MOVES CONTINUOUSLY, so at city zoom the
fleet reads as flowing veins and zooming in reveals individual units gliding.
Deployed and verified live (headless-Chrome CDP; light + dark; 1440 + 390).

### New `VehicleFlowLayer` (single animated canvas overlay)
- Replaces the discrete circle/bullet Leaflet markers with **one** rAF-driven
  `<canvas>` overlay pinned to the map (same zoom-animation transform as
  `L.Canvas`). Buses = true-scale rounded slabs (~12 m, 18 m for SBS/express)
  rotated to bearing; subway trains = ~160 m worms lying ALONG the actual
  inter-station GTFS track shape (backend now emits the segment + fraction).
- **Continuous motion (ant farm):** dead-reckoning tween — each report starts a
  ~30 s glide from the currently-displayed position toward the new one, so units
  walk their last displacement smoothly instead of snapping every tick. Bearing
  from the movement vector (payload bearing fallback). New units fade in; units
  missing > 3 ticks fade out. The **selected** bus route snaps + glides its buses
  ALONG the loaded shape polyline (no corner-cutting on the featured route).
- **True scale:** meters→pixels via Web-Mercator m/px at the viewport latitude;
  clamped to a ~3 px minimum (city zoom = moving specks / veins) with full shapes
  at zoom ≥ 12 and cheap moving specks below. Subway interpolated positions keep
  reduced opacity (honesty); official MTA line colors; theme-aware contrast
  outline for light + dark basemaps.
- **Performance:** one redraw/frame, viewport culling, alloc-free inline
  projection + typed-array hit store. Measured (headless, no-GPU worst case):
  **z11 default ~2.6 ms/frame @ ~4,450 units**, z14 ~4 ms, z16 ~1.8 ms, dark
  ~2.5 ms, mobile-390 ~8.5 ms — all under the 12 ms budget (real GPU users
  faster). Pauses on `document.hidden`; graceful **reversible** degrade to 30 fps
  then tick-jump only as a last resort, auto-recovering when the view is cheaper.
  An honest "N ms/frame" readout ships in the map's status line.
- Interaction preserved: click/tap hit-tests the nearest unit (~8 px) → existing
  popup; hover cursor; Buses/Subway toggles and the route filter keep working.
  Legend gains a "vehicle shapes at true scale — positions between reports are
  estimated" honesty line.

### Backend (`/api/rt/subway`)
- Interpolated trains now carry `seg` (rounded, ≤28-vertex inter-station track
  polyline in travel order) + `frac` (0→1 progress), so the client can lay the
  worm along the real shape and animate along it. Adds ~40 KB to the subway
  payload; at-station trains are unchanged (drawn as line bullets).

## 2026-07-23 — Q4.1/Q4.2 structure, flow & performance deep pass

IA/navigation rework + per-spoke code-split. Deployed and verified on the live
public site (headless Chrome, light+dark, 1440 + 390). Regression-guarded: the
Marey diagram, Ops Wall dark, Q1 coverage centerlines, confidence badges, KB
callouts, and reconciliation panels all render unchanged.

### IA / navigation (Q4.1)
- Flat 9-item bar → **spoke-first grouped nav**: `Maps · Observatory · Ops Wall ·
  Data · Methodology · About`. "Maps" and "Observatory" are section landings; the
  chrome nav stays flat (no dropdowns), so grouping is expressed with in-page
  sub-nav strips. "Code" drops off the bar (reachable from Data) to keep six items
  that wrap cleanly on mobile. Grouping-parent highlight: any `/bus /sidewalks
  /renters /maps` path lights **Maps**; any `/observatory*` lights **Observatory**.
- New **Maps hub** (`/maps`): hero + the three map cards.
- New shared `SectionSubnav`; `ObsSubnav` refactored onto it; new `MapsSubnav`
  (Overview / Transit Live / Sidewalks / Renter's Map) shown on the three map pages.
- Landing gains a **"how to read our badges"** taxonomy legend (the three
  ConfidenceBadge tiers, one line each, sourced from the same registry).
- **Breadcrumbs** on route dossiers (Observatory › M15).
- **Cross-links**: dossier → Reliability leagues + "Service changes for {route}"
  (Changes now reads `?route=` from the URL); sidewalk SAI/ADA popups gain an
  "Explore this location in the Renter's Map" link (lat/lon URL); the Renter
  scorecard's transit section links each nearby bus route to its dossier. All
  internal `<Link>`s; shareable URLs preserved.

### Performance (Q4.2)
- **Per-spoke code-split** (`React.lazy` per route). Main `index.js` **733 KB → 207
  KB raw** (244 → 69 KB gzip). Leaflet + protomaps hoisted into ONE shared `basemap`
  chunk (map pages only, cached) — no double-include. Plotly stays a deferred
  dynamic-import chunk (never on first paint).
- **Landing first paint ~263 → ~85 KB gzip (−68%)** — well under the < 1 MB target.
- Live TTFBs 76–115 ms (all < 150 ms target); `/api/wall` warm at 94 ms; assets +
  geo layers immutable/long-cached → warm loads under the 400 ms target.
- Full measured table + method notes + known-heavies: `PERF_BASELINE.md` (internal
  regression reference).

## 2026-07-23 — Q3.3 knowledge exploitation (history meets live)

Ingested-KB knowledge surfaced on the live pages. Verified live (public site +
API; observatory.nycvisualizer.com 200, `/api/downloads` = 47 items with the new
keys resolving).

### Hub-Bound "history meets live" chart (Observatory landing)
- New `analysis/cordon/build_hub_bound_series.py` assembles the **NYMTC Hub Bound**
  cordon series — 24-hour persons entering the Manhattan CBD (south of 60th St) by
  mode — from the 85 verified born-digital cordon CSVs (KB DOC0346–DOC0374). Honest
  coverage: **14 report years** carry the clean by-mode Quick-Reference table
  (2007–09, 2012–20, 2023–24); 2010–11 & pre-2007 await GPU re-extraction, 2021–22
  were not surveyed (COVID). Six major modes (subway/auto/bus/rail/bike/tram)
  reconcile **exactly** with NYMTC's own all-modes summary (e.g. 2014 subway
  2,252,428 = NYMTC's 2,252K); ferry excludes the Staten Island Ferry (omitted
  sector) — documented, not silently patched.
- Observatory landing gains a stacked-bar hero chart (contract-compliant: Download
  CSV top-right, legend below). Gap years render as gaps (no fabricated
  continuity). **No live "today" tie-in**: our feeds count subway/bus systemwide,
  not cordon crossings — not comparable to a Hub-Bound entry count, stated plainly.
- Mode-mapping audit trail: `cordon/MODE_MAPPING.json`.

### Medial-axis sidewalk width — alternative estimate (NOT promoted)
- New `analysis/sidewalk/06_medial_axis_width.py` implements Meli Harvey's true
  **Voronoi medial-axis** width method on our planimetric polygons (50,773 polys).
- Validation is honest: **r = 0.727 vs Harvey's published widths** (n = 17,895) —
  **below** the r > 0.75 promotion bar — so the 2A/P proxy stays the **primary**
  width layer, the map `w` channel is unchanged, and width confidence stays
  **🔵 exploratory**. Shipped as an **alternative** download with the full
  comparison (r = 0.94 vs the 2A/P proxy; our median 8.6 ft vs Harvey's 8.1 ft,
  actually nearer Harvey than the proxy's 9.7 ft). Method + decision written into
  the sidewalk METHODS.

### Congestion-pricing framing (Jan 2025)
- Bus methodology tab + route-dossier speed sections carry a dated congestion-
  pricing context block: **NBER w33584** (CBD road speeds **+11%**; KB DOC0343) and
  **arXiv:2606.17530** (transit gains + spatially-uneven demand; KB DOC0407), both
  quote-verified. Notes that our 2025+ segment-speed panel is the post-CP era.
  Both papers added to the About sources & credit.

### Downloads
- `/api/downloads` gains `hub_bound_series.{csv,parquet}`, `hub_bound_series_wide.csv`,
  and the medial-axis `medial_axis_width_{segments,polys}.parquet` (alternative
  estimate), each with an honest note.

## 2026-07-23 — Q2.3–2.7 editorial calibration (honesty as a feature)

Certainty, commentary, and reconciliation surfaced site-wide. Verified live
(public site + API serving the new fields; distribution mode rendering at the
current 6-day archive depth).

### League gating (Q2.3)
- `/observatory/leagues` no longer names a "most" or "least" reliable route until
  the archive earns it. Below **14 observed days** the page renders the
  **bunching-index distribution** (a contract-compliant histogram over all
  qualifying routes) + an **unranked, client-sortable per-route table**
  (bunching, headway CV, observed-days per route — no rank column, no winner/loser
  framing) + an explainer that says rankings unlock at 14 days and how many days
  we have. The **Slowest-corridors** table stays in both modes (MTA administrative
  segment-speed data, not archive-gated).
- Auto-flip: the backend now reports `rankings_unlocked` (`archive_depth_days ≥ 14`)
  and a full `distribution` array on `/api/obs/leagues`; the leaderboard renders
  automatically at depth — verified against a mocked 14-day depth. The Observatory
  landing's ranked league cards are gated the same way.

### Reconciliation panels (Q2.4)
- New reusable `ReconciliationNote` ("Our figure vs the authority" — two columns,
  a why-they-differ paragraph, a what-would-close-it line, dated, quiet styling).
- **ACE** (dossier ACE section + methodology bus tab): our ≈0 mph unmatched
  citywide segment difference vs the MTA's reported **+5% average speed-up (up to
  +30%)** on its 39 ACE-enforced routes — reconciled as different estimands
  (unmatched citywide average vs targeted corridor before/after). Cites *MTA ACE
  program materials, 2024–25*.
- **Bus speed** (methodology bus tab, corroboration): our Manhattan ≈6.2 mph vs
  **NYC DOT's 7.44 mph citywide average (2017)** — two independent measurements
  agreeing in magnitude and the Manhattan-slow gradient.

### Know / don't-know panels (Q2.5)
- New reusable `KnowDontKnow` ("What we can say" / "What we can't yet — and what
  would change that"), one per flagship: Observatory, Sidewalks, Renter's Map, and
  the methodology Access section. Each open question names the exact data or method
  that would settle it.

### KB context callouts (Q2.6)
- New reusable `ContextCallout` (quiet soft-surface card: a quote/fact + "Doc,
  Year — Jane KB" source line), fed by a curated `content/kb_callouts.json` of
  **10 quote-verified passages** from the Jane Knowledge Base: the Hub-Bound
  1963-onward CBD cordon series (Observatory), the bunching definition and NYC
  DOT's since-2012 bus-speed tracking (Leagues), Vision Zero pedestrian-safety
  context (Sidewalks + SAI), the city's equity framing and the NYC Ferry access
  record (Renter's Map + Access), and Moses / Jacobs / subway network history
  (About). Every quote was checked against its source doc before shipping.

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
