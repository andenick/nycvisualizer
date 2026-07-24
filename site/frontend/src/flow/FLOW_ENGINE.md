# nycviz-flow — the ant-farm engine

`nycviz-flow` (`src/flow/`) is the host-agnostic canvas engine that renders NYC's live
buses and subway trains as **true-scale, telemetry-honest, degrade-laddered** moving units
— the "ant farm" on `/bus`, `/live/*` and the planner workstation. It was extracted VERBATIM
from `src/components/VehicleFlowLayer.ts` (E0, campaign nycviz-flow ENGINE_DECISION Phase
0–1): every constant, easing curve, threshold and honesty rule moved unchanged; the only
diffs are mechanical (inline `_project` → `Projector`, `this._lmap.*` → `FlowHost`, the
`_draw` branches → `draw.ts`). **Zero user-visible change** was the hard constraint.

The differentiator is the animation layer, not the tile renderer (ENGINE_DECISION §1c). This
module is that layer, now documented, tested and portable so a future MapLibre swap is a new
`FlowHost`, not a renderer rewrite.

---

## Architecture (text diagram)

```
        consumers (React pages)                       host boundary
  ┌───────────────────────────────┐        ┌──────────────────────────────┐
  │ BusMap · ImmersiveMapPage ·    │        │  leaflet (the ONLY L.* users):│
  │ WorkstationPage               │        │  components/VehicleFlowLayer   │
  │   new VehicleFlowLayer(hooks) │───────▶│    (thin L.Layer wrapper)      │
  │   .addTo(map) .setBuses(...)  │        │  flow/hosts/leaflet.ts         │
  └───────────────────────────────┘        │    LeafletFlowHost             │
                                            └──────────────┬───────────────┘
                                                           │ implements FlowHost
                                                           ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │                       nycviz-flow engine (NO leaflet)                   │
  │                                                                         │
  │   core.ts  FlowEngine ── rAF loop · unit store (Map<id,Unit>) ·        │
  │      │        setBuses/setTrains ingest · tween/decay/snap state       │
  │      │        machine · draw orchestration · getStats/getDisplayLatLng │
  │      ├── project.ts   Projector (Web-Mercator, alloc-free) · metersPP  │
  │      ├── shapes.ts    pointAtDist / pointAtOffset / buildSegCum        │
  │      ├── draw.ts      drawSpeck · drawBus · drawStationTrain ·         │
  │      │                drawTrainWorm · drawTrail · roundRect            │
  │      ├── hittest.ts   HitStore (parallel arrays) · selOf               │
  │      ├── ladder.ts    DegradeLadder (trails→30fps→tick-jump)           │
  │      ├── constants.ts every tunable (meters, zooms, easings, budgets)  │
  │      └── types.ts     Unit · FlowSelection · FocusPred · FlowHost ·    │
  │                       DrawFrame                                        │
  └───────────────────────────────────────────────────────────────────────┘
```

**Per-frame data flow:** `FlowEngine._loop(ts)` → pacing/pause gates → `_draw(now)`: clear
canvas → `Projector.configure(zoom, pixelOrigin)` → for each `Unit`: advance shape-offset
(decay+ease), compute glide fraction `f`, compute alpha (appear/stale/estimated/focus), then
dispatch to the right `draw.*` by zoom + kind. Each drawn unit pushes a pick circle into the
`HitStore`. After the frame, `DegradeLadder.maybeDegrade(emaMs, …)` sheds/recovers quality.

---

## The FlowHost contract (`types.ts`)

`FlowHost` is the **entire** host coupling — the seam a MapLibre (or any) host reimplements.
The engine never imports `leaflet`; it asks the host for viewport facts and DOM/popup actions.

| Method | Purpose (what the old code called) |
|---|---|
| `getContainer()` | map container element |
| `mountCanvas()` | create the overlay `<canvas>` in a dedicated pane above stations, return it (`L.DomUtil.create` + `createPane` z-450) |
| `unmountCanvas()` | remove the canvas (`L.DomUtil.remove`) |
| `isZoomAnimated()` | does the host animate zoom? (`map._zoomAnimated`) |
| `getZoom() / getCenter() / getSize()` | per-frame viewport |
| `getPixelOrigin()` | pixel origin → projection constants |
| `getMapPanePos()` | pane offset for container-space culling/hit circles (`map._getMapPanePos`) |
| `containerPointToLayerPoint(x,y)` | rounded layer point for canvas sizing (`map.containerPointToLayerPoint().round()`) |
| `setCanvasPosition(x,y)` | position the canvas (`L.DomUtil.setPosition`) |
| `updateTransform(tgtC, tgtZ, curC, curZ, pad)` | the zoom-animation transform mirror (`L.Renderer._updateTransform`) |
| `setCursor(c)` | hover cursor |
| `openPopup(lat,lng,html)` / `closePopup(h)` | popup lifecycle (`L.popup(...).openOn`) |

Events flow the other way: the **wrapper** (`VehicleFlowLayer.getEvents()`) translates the
host's native events into plain-data engine calls — `onViewReset`, `onZoom*`, `onAnimZoom`,
`onClick(cx,cy,lat,lng)`, `onMouseMove(cx,cy)`. No Leaflet type crosses into the engine.

---

## Module map + old → new mapping

Source of truth for the extraction (line numbers = original `VehicleFlowLayer.ts`).

| New file | Contents | Old lines |
|---|---|---|
| `constants.ts` | all true-scale / zoom / easing / decay / trail constants + `DEG` | L30–48, L58–64, L86–88 |
| `project.ts` | `metersBetween`, `metersPerPixel`, `Projector` (configure + inline project) | L159–169, L207–211, L709–716, L881–887 |
| `shapes.ts` | `pointAtDist`, `buildSegCum`; re-exports `pointAtOffset`/`OffsetPoly` | L171–185, L520–528 |
| `ladder.ts` | `DegradeLadder` (pacing + shed/recover state machine) | L641–646, L657–691 |
| `hittest.ts` | `HitStore` (ensure/push/pick, parallel arrays), `selOf` | L200–205, L834–852, L1178–1213 |
| `draw.ts` | `drawSpeck`, `drawBus`, `drawStationTrain`, `drawTrainWorm`, `drawTrail`, `roundRect` | L800–832, L932–957, L971–1047, L1057–1102, L1105–1175, L1260–1276 |
| `core.ts` | `FlowEngine` (loop, unit store, ingest, motion state machine, per-vehicle report-time anchoring, draw orchestration, stats), `decayDist`, `advanceDist`, `clampFps`, `isSbs` | L68–77, L188–578, L603–968, L1254–1258 |
| `types.ts` | `Unit`, `FlowSelection`, `FocusPred`, `FlowPopupHooks`, `ColorFor`, `FlowHost`, `DrawFrame` | L90–156 |
| `hosts/leaflet.ts` | `LeafletFlowHost` — the only `leaflet` importer | L247–301, L603–639, L1232 |
| `components/VehicleFlowLayer.ts` | thin `L.Layer` back-compat wrapper (engine + leaflet host) | L188–301 (lifecycle) |

Public API (unchanged, forwarded 1:1): `setBuses`, `setTrains`, `setVisibility`, `setTrails`,
`setFocus`, `setShapeSource`, `getStats`, `getDisplayLatLng`, plus the `L.Layer` `.addTo` /
`.remove`. Consumers import `{ VehicleFlowLayer, type FlowSelection }` from the same path.

---

## Perf budgets (from `PERF_BASELINE.md`, 2026-07-24 map exam)

- **Frame budget: 8 ms** (`FRAME_BUDGET_MS` in code is 12 ms — the degrade *trigger*; the
  live target the baseline gates against is 8 ms). Trails ON default on `/live/bus`, OFF on
  `/bus`, OFF on the workstation.
- Measured peak **z12 (city "veins", ~825–1105 units): 6.31 ms** with trails on — under
  budget with headroom. Frame time falls sharply zooming in (viewport culls units): z15
  1.93 ms, z17 0.43 ms. **No degrade step ever triggered** in the sweep (60 fps throughout).
- Bundle: the engine ships as a shared `VehicleFlowLayer-*.js` chunk (~23 KB raw / ~8.7 KB
  gzip) loaded by the three map pages; the `basemap` chunk stays **76 KB gzip** (Leaflet +
  protomaps), unchanged by the extraction.
- Realistic 2-D ceiling ~6–10k units before fill/stroke count dominates (ENGINE_DECISION
  §1c). Beyond that a WebGL backend behind the same API is the Phase-2 option (out of scope).

Perf hook: append `?perf` to a map URL → `window.__nycvFlow.getStats()` returns
`{units, emaFrameMs, fps, tickJump, predErr:{n,medianFt,p90Ft}, anchorFallbacks}`;
`getDisplayLatLng(id)` gives a tracked unit's live position (used by the motion trace).
`predErr.medianFt` is the live proof of the hold-last-speed fix (target ~44 ft, down from
~92 ft); `anchorFallbacks` counts reports that could not use per-vehicle timestamp anchoring.

---

## Honesty rules (the motion contract — do NOT "smooth away")

1. **Hold-last-speed, then decay-to-STOP, no fabrication.** With no fresh report a shape-
   following bus **holds its last speed (`speed_est_fps`, the backend's segment-median prior)
   for up to `STALE_S` = 40 s** of unbiased dead-reckoning, and only THEN eases to a full stop
   over `DECAY_S` = 45 s (`advanceDist` = hold + `decayDist`), holding forever after
   `STALE_S + DECAY_S` — never inventing motion past the data. The old code decayed from t = 0,
   easing every moving bus toward a stop that usually doesn't happen: a systematic downward
   bias (measured **−101 ft/tick** on smoothed archive trajectories, where holding halved the
   median between-tick correction 92 → 44 ft with bias → 0). On the LIVE raw `route_offset_ft`
   feed the accuracy gain is smaller (raw GPS/map-match jitter dominates: all models sit
   ~160-200 ft) but the systematic bias is still removed (−66 → +30 ft, fair live 4-model
   comparison 2026-07-24) — the point that survives is honest, unbiased, continuous forward
   motion instead of a synchronized decay-and-jump. NB: dead-reckoning uses the segment prior,
   NOT the observed last-leg speed — on raw offsets observed speed amplifies noise and measured
   WORSE (median 199 ft / p90 598 vs 188 / 420); the study's "observed beats segment" held only
   on its smoothed derived trajectories. (`core._advanceBusOffset`)
2. **Dwell in place, no fake creep.** A bus whose offset isn't advancing between reports docks
   and shows a subtle breathing pulse — it does **not** creep forward. (`DWELL_FPS`, `drawBus`)
3. **Snap-correct, never teleport.** A fresh report **> `SNAP_FT` = 200 ft** off the prediction
   opens a fast-ease window (`SNAP_TAU_MS` 220 vs `EASE_TAU_MS` 550) that closes the gap in
   ≤ ~1 s — a smooth correction, not a jump. (`core.setBuses` + `_advanceBusOffset`)
4. **Estimated = dimmer.** Interpolated subway positions render at reduced opacity
   (`alpha *= 0.62`); "straight"-basis worms draw a marginally simpler underlay.
5. **Along the real geometry.** Buses glide along their route shape (offset space) and trains
   lie ALONG the inter-station track polyline — never straight through blocks.
6. **Graceful, reversible degrade.** Under load the ladder sheds **trails first**, then 30 fps,
   then tick-jump — and recovers with hysteresis when the view is cheap again. Never a
   permanent freeze. (`DegradeLadder`)
7. **Per-vehicle report-time anchoring, de-synchronized corrections.** Each unit carries its
   own report `timestamp`; reports are naturally staggered across ~23 s of every poll window
   (σ ≈ 9.6 s, 8.4 M rows). The engine anchors each shape bus / train's motion clock to ITS OWN
   report time (`setBuses`/`setTrains` slew one epoch→perf offset per feed off the batch's
   newest report, then place every unit by its own epoch), so corrections absorb at each unit's
   natural staggered moment instead of all firing on the shared poll instant. Measured effect
   (wide-canvas frame-delta trace, 2026-07-24): the citywide single-instant pulse became a
   diffuse ripple SMEARED across ~8 s of each poll window — poll-lag autocorrelation dropped
   0.15 → 0.05. (Batched 30 s snapshot delivery means reports still ARRIVE together, so a
   residual staggered ripple remains; only streamed per-vehicle delivery would remove it fully.)
   A timestamp that is absent, > 5 min stale, or > 60 s in the future falls back to the poll-
   time anchor (counted in `getStats().anchorFallbacks`); a stale re-serve (epoch not advanced)
   is skipped so it neither resets the dead-reckoning clock nor pollutes the metric, and the
   between-tick predErr is recorded only for study-comparable single-report intervals (20-50 s).
   (`core._anchorReport` / `_slewOffset` / `_newestEpochMs`)

These are locked by the tests (`flow.math.test.ts` decay/`advanceDist` hold-then-decay/snap
math; `flow.engine.test.ts` hold-last-speed-to-stop + snap-correct + per-vehicle-anchoring
stagger/stale-boundary/clock-guard behavioral proofs).

---

## How a future MapLibre host would implement FlowHost

Per ENGINE_DECISION's migration table, adding MapLibre is **"write the basemap adapter +
`MapLibreFlowHost`, restyle" — not "rewrite the renderer."** A `flow/hosts/maplibre.ts`
would implement the same `FlowHost` surface:

- **mountCanvas / unmountCanvas** — either a MapLibre **custom layer** (arbitrary draw in the
  map's render loop) or a synced overlay `<canvas>` positioned over the GL canvas (the
  deck.gl `MapboxOverlay` pattern). Return that canvas.
- **getZoom / getCenter / getSize** — `map.getZoom()`, `map.getCenter()`, `map.getCanvas()`
  size. Straightforward.
- **getPixelOrigin / getMapPanePos / containerPointToLayerPoint** — MapLibre has no Leaflet
  "pixel origin / pane" model. Simplest faithful path: implement the engine's projection
  against MapLibre's `map.project(lngLat) → {x,y}` (container pixels) by having the host return
  a pixel origin/pane pos of 0 and feeding container-space points directly; OR keep the inline
  `Projector` and derive origin from `map.transform`. Either keeps `draw.*` untouched.
- **setCanvasPosition / updateTransform** — for a custom layer these are no-ops (MapLibre owns
  the transform); for a synced overlay, mirror `map.transform` each `render` event.
- **setCursor / openPopup / closePopup** — `map.getCanvas().style.cursor`, `maplibregl.Popup`.
- Events: the MapLibre wrapper wires `move`/`zoom`/`render`/`click`/`mousemove` → the same
  engine `onViewReset` / `onZoom*` / `onClick(cx,cy,lat,lng)` / `onMouseMove` calls.

pmtiles are already first-class in MapLibre (`addProtocol('pmtiles', …)`), so the existing
`.pmtiles` basemap loads unchanged. The renderer + motion model do not change.

---

## Running the tests

```bash
cd site/frontend
npm test            # vitest run  → 46 assertions across 2 suites
npm run build       # tsc --noEmit && vite build  (typecheck + bundle)
```

- `src/flow/__tests__/flow.math.test.ts` — pure math: projection fixtures, offset/shape walks
  (incl. offset-beyond-end + 2-point + single-point shapes), `decayDist`/`clampFps`, the
  degrade-ladder transitions, and hit-test nearest-within-8px + `selOf`.
- `src/flow/__tests__/flow.engine.test.ts` — deterministic "golden replay": drives the real
  `FlowEngine` through a fake `FlowHost` + a recording canvas on a simulated clock, locking the
  draw-branch selection (speck/slab/ring/worm) and the glide / 45 s decay-to-stop / >200 ft
  snap-correct honesty rules — no browser, no live data.

Tests run in the default node environment (no jsdom); the engine integration test stubs the
few globals it touches (`performance`, `requestAnimationFrame`, `document`, `window`).
