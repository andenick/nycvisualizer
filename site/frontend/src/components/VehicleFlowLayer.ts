// VehicleFlowLayer — the "ant farm" live-vehicle renderer for /bus.
//
// A single animated <canvas> Leaflet overlay that replaces the discrete
// circle/bullet markers. Every bus and subway train is drawn as a TRUE-SCALE,
// bearing-oriented shape (meters → pixels via Web-Mercator m/px at the viewport
// latitude) and MOVES CONTINUOUSLY: an rAF loop linearly glides each unit from
// its previous reported position toward its current one over the real ~30 s tick
// interval. At city zoom units clamp to moving specks (the "veins"); zooming in
// reveals individual units gliding — buses as little rounded slabs, trains as
// ~160 m worms lying ALONG the actual inter-station track shape.
//
// Design notes:
//  * One canvas, one redraw per frame, viewport-culled. Plain-object per-unit
//    state (fleet is ≤ ~3k units; measured < 5 ms/frame — see getStats()).
//  * Honest motion only: linear interpolation in real time between reports, no
//    easing gimmicks. Subway interpolated positions keep reduced opacity.
//  * The canvas rides the Leaflet overlayPane and uses the same zoom-animation
//    transform trick as L.Canvas (1.9.4), so it stays pinned through pan/zoom.
//  * Popups + hit-testing preserved: click picks the nearest unit within ~8 px.
//  * Degrades: pauses on document.hidden; drops to 30 fps then to tick-jump mode
//    if a frame budget of 12 ms is sustained (logged once).

import L from "leaflet";
import type { Vehicle, SubwayTrain } from "../lib/api";
import { subwayColor, subwayLabel } from "../lib/subwayColors";
import { RouteShapeCache, pointAtOffset, type OffsetPoly } from "../lib/shapeCache";
import { trackBusOffline } from "../lib/beacon";

// ---- true-scale constants (meters) ----
const BUS_LEN_M = 12;
const BUS_LEN_SBS_M = 18; // articulated / SBS (optional, when identifiable)
const BUS_W_M = 2.9;
const TRAIN_LEN_M = 160;
const TRAIN_W_M = 3.6;
const MIN_LEN_PX = 3; // city-zoom clamp — a moving speck, never invisible
const MIN_W_PX = 1.6;
const SLAB_ZOOM = 12; // below this: simplified moving specks (veins); 12+ = full shapes
const LABEL_ZOOM = 13; // subway line-bullet drawn at/above this zoom
const APPEAR_MS = 480;
const FADE_MS = 800;
const STALE_TICKS = 3; // keep a missing unit up to N ticks, then fade + remove
const FRAME_BUDGET_MS = 12;
const DEG = Math.PI / 180;
// Nominal report cadence (~30 s ticks). Each new report starts a dead-reckoning
// glide over this duration from the currently-displayed position, so units move
// continuously between ticks instead of snapping. Matches the backend SSE/poll
// interval; a faster real cadence just retargets sooner (still smooth).
const GLIDE_MS = 30000;

// ---- Ant Farm v3 (W1-client) shape-following dead-reckoning ------------------------------
// A bus that carries a backend `shape_id` + `route_offset_ft` (distance travelled ALONG its
// route, in feet) glides along the shape polyline: from its last reported offset it advances
// at `speed_est_fps`, easing into each fresh report's offset (never a straight line through
// blocks, never a teleport). Prediction confidence DECAYS — with no fresh report a bus eases
// to a full stop over DECAY_S, resuming on the next ping. Buses whose offset isn't advancing
// (dwelling at a stop) dock in place with NO fake creep. Buses without shape data keep the
// straight prev→cur glide (above).
const DECAY_S = 45; // ease a stale bus to a stop over ~45 s (the user's core sparse-data rule)
const SNAP_FT = 200; // a fresh report >200 ft off the prediction → fast (≤1 s) snap-correct
const EASE_TAU_MS = 550; // normal ease time-constant toward the predicted offset
const SNAP_TAU_MS = 220; // fast ease during a snap window (~<1 s to close a big gap)
const SNAP_EASE_MS = 900; // how long a snap-correct stays in fast-ease mode
const DWELL_FPS = 2.0; // offset advancing slower than this between reports ⇒ docked/dwelling
const PRED_ERR_CAP = 4000; // ring-buffer size for the between-tick prediction-error samples

/** Distance (ft) travelled since a report of `speedFps`, with speed decaying LINEARLY to 0
 *  over DECAY_S — the honest ease-to-stop when no fresh report arrives. Monotonic, capped. */
function decayDist(speedFps: number, tSec: number): number {
  const tc = tSec < 0 ? 0 : tSec > DECAY_S ? DECAY_S : tSec;
  return speedFps * (tc - (tc * tc) / (2 * DECAY_S));
}

/** Sanitise a backend speed_est_fps to a non-negative, bounded fps (null/NaN → 0). */
function clampFps(v: number | null | undefined): number {
  if (v == null || !isFinite(v)) return 0;
  return v < 0 ? 0 : v > 90 ? 90 : v;
}

// ---- motion trails (F4) — a ~20 s fading tail per moving unit ----
// A small per-unit ring buffer of recently-displayed positions, sampled at a
// throttled cadence so TRAIL_CAP points span ~TRAIL_CAP*TRAIL_SAMPLE_MS ≈ 20 s.
// Rendered as a thin, theme-aware polyline whose alpha ramps to 0 at the tail —
// makes flow direction/speed legible at a glance, especially at city zoom.
// Perf: capped points, single canvas pass, and the FIRST thing the degrade
// ladder drops (see _maybeDegrade).
const TRAIL_CAP = 12;
const TRAIL_SAMPLE_MS = 1650; // 12 * 1.65 s ≈ 20 s tail
const TRAIL_MAX_ALPHA = 0.5; // head of the tail; ramps to 0 at the oldest point

type ColorFor = (routeId: string | null) => string;
/** What the client learns when a unit is clicked: enough to drive the follow
 *  pill ("Following M15 bus 4821") and the focus predicate, with zero renderer
 *  knowledge of route/line taxonomy (the page owns lineKey()). */
export interface FlowSelection {
  id: string;
  kind: "bus" | "train";
  routeId: string | null; // raw route id (bus route or subway route_id)
  label: string; // display label, e.g. "M15" or "L"
  sub: string; // secondary, e.g. "bus 4821" or "train …a1b2c3"
}
/** A focus predicate: returns true for units that should stay bright. */
export type FocusPred = (kind: "bus" | "train", routeId: string | null) => boolean;

export interface FlowPopupHooks {
  busPopup: (v: Vehicle) => string;
  trainPopup: (t: SubwayTrain) => string;
  /** Fired when the popup "Follow" action is tapped (F4 follow mode). */
  onFollow?: (sel: FlowSelection) => void;
  /** Fired when the popup "Focus route/line" action is tapped (F4 focus dim). */
  onFocus?: (sel: FlowSelection) => void;
}

interface Unit {
  id: string;
  kind: "bus" | "train";
  prevLat: number;
  prevLon: number;
  curLat: number;
  curLon: number;
  prevT: number;
  curT: number;
  brg: number | null; // payload bearing (deg, 0=N cw) fallback
  color: string;
  lenM: number;
  widM: number;
  est: boolean; // subway interpolated
  atStation?: boolean; // subway train docked at a station (rendered as a ring)
  segBasis?: string; // "straight" (prev→next line) vs shape-derived polyline
  label: string;
  // subway worm geometry (travel-ordered inter-station segment):
  seg?: [number, number][];
  segCum?: number[];
  segLen?: number;
  segKey?: string;
  prevFrac?: number;
  curFrac?: number;
  // Ant Farm v3 shape-following (bus): dead-reckoning ALONG the route shape in offset space.
  offPoly?: OffsetPoly; // the cached shape geometry (lat/lon + cumulative ft) this bus rides
  soDisp?: number; // currently-DISPLAYED offset (ft) — the animated value we render
  soReport?: number; // last reported route_offset_ft (ft) — the dead-reckoning anchor
  soReportT?: number; // performance.now() (ms) of that report
  soSpeed?: number; // advance rate (fps) used since the report (0 when docked/dwelling)
  soSnapUntil?: number; // fast-ease window end (ms) after a >200 ft snap-correct
  docked?: boolean; // offset not advancing between reports ⇒ dwell in place (subtle pulse)
  // motion trail (F4) — lazily allocated circular buffer of recent lat/lon:
  tLat?: Float64Array;
  tLon?: Float64Array;
  tN?: number; // points stored (≤ TRAIL_CAP)
  tHead?: number; // next write index (circular)
  tLastT?: number; // last sample time
  // lifecycle:
  appearT: number;
  missing: number;
  goneT?: number;
  data: Vehicle | SubwayTrain;
}

// --------------------------------------------------------------------- geo math
function metersBetween(a: [number, number], b: [number, number]): number {
  const R = 6378137;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const latm = (((a[0] + b[0]) / 2) * Math.PI) / 180;
  const dLon = (((b[1] - a[1]) * Math.PI) / 180) * Math.cos(latm);
  return R * Math.sqrt(dLat * dLat + dLon * dLon);
}

function metersPerPixel(lat: number, zoom: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom + 8);
}

function pointAtDist(pts: [number, number][], cum: number[], d: number): [number, number] {
  const total = cum[cum.length - 1];
  if (d <= 0) return pts[0];
  if (d >= total) return pts[pts.length - 1];
  let lo = 0,
    hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / seg;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
}

// ------------------------------------------------------------------- the layer
export class VehicleFlowLayer extends L.Layer {
  private _lmap!: L.Map;
  private _canvas!: HTMLCanvasElement;
  private _ctx!: CanvasRenderingContext2D;
  private _min = L.point(0, 0);
  private _center: L.LatLng = L.latLng(0, 0);
  private _zoom = 0;
  private _padding = 0.12;
  private _zooming = false;
  private _dpr = 1;
  private _raf = 0;
  private _units = new Map<string, Unit>();
  // hit-test store as parallel arrays (no per-frame object allocation / GC churn)
  private _hx = new Float32Array(0);
  private _hy = new Float32Array(0);
  private _hr = new Float32Array(0);
  private _hkind = new Uint8Array(0); // 0=bus 1=train
  private _hdata: (Vehicle | SubwayTrain)[] = [];
  private _hn = 0;
  // per-frame Web-Mercator projection constants (inline, alloc-free)
  private _cA = 0;
  private _ccx = 0; // layerX = _cA*lon + _ccx
  private _cmy = 0;
  private _ccy = 0; // layerY = _ccy - _cmy*merc(lat)
  private _plx = 0;
  private _ply = 0;
  private _showBuses = true;
  private _showSubway = true;
  private _hooks: FlowPopupHooks;
  private _dark = false;
  // Ant Farm v3: lazy per-route shape geometry (LRU) so ANY visible bus can glide along its
  // route. Injected by the page (setShapeSource); null → all buses use the straight glide.
  private _shapes: RouteShapeCache | null = null;
  // between-tick prediction-error samples (ft), a ring buffer; median/p90 via getStats().
  private _perr = new Float32Array(PRED_ERR_CAP);
  private _perrN = 0; // total recorded (for the modulo write head)
  private _lastFrameT = 0; // performance.now() of the previous drawn frame (for ease dt)
  // perf:
  private _emaMs = 0;
  private _fpsDivisor = 1; // 1 = full rAF, 2 = ~30 fps
  private _tickJump = false;
  private _degradedLogged = false;
  private _frameParity = 0;
  private _dirty = true; // in tick-jump mode, only redraw when data/view changed
  // F4 enhancements:
  private _trails = false; // motion trails enabled (page sets default per surface)
  private _trailsDropped = false; // degrade ladder shed trails (recovers when cheap)
  private _focus: FocusPred | null = null; // focus-dim predicate (null = no focus)

  constructor(hooks: FlowPopupHooks) {
    super();
    this._hooks = hooks;
    this._dark =
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  // ---- Leaflet lifecycle ----
  onAdd(map: L.Map): this {
    this._lmap = map;
    const canvas = (this._canvas = L.DomUtil.create(
      "canvas",
      "leaflet-layer nycv-flow",
    ) as HTMLCanvasElement);
    const anim = (map as any)._zoomAnimated;
    if (anim) L.DomUtil.addClass(canvas, "leaflet-zoom-animated");
    canvas.style.pointerEvents = "none";
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unsupported");
    this._ctx = ctx;
    // Dedicated pane ABOVE the station SVG so moving units (worms) and at-station
    // rings paint OVER the station discs instead of hiding beneath them (the 58%
    // at-station occlusion fix). Stations/route-shapes ride the default overlayPane
    // (z 400); this pane sits just above at 450, below markers/popups (600/700).
    const paneName = "nycvFlowPane";
    let pane = map.getPane(paneName);
    if (!pane) {
      pane = map.createPane(paneName);
      pane.style.zIndex = "450";
      pane.style.pointerEvents = "none";
    }
    pane.appendChild(canvas);
    this._reset();
    this._loop = this._loop.bind(this);
    this._onVis = this._onVis.bind(this);
    document.addEventListener("visibilitychange", this._onVis);
    if (!document.hidden) this._raf = requestAnimationFrame(this._loop);
    return this;
  }

  onRemove(map: L.Map): this {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    document.removeEventListener("visibilitychange", this._onVis);
    L.DomUtil.remove(this._canvas);
    void map;
    return this;
  }

  getEvents(): Record<string, L.LeafletEventHandlerFn> {
    const ev: Record<string, L.LeafletEventHandlerFn> = {
      viewreset: this._reset,
      moveend: this._reset,
      resize: this._reset,
      zoom: this._onZoomThrottle,
      zoomstart: this._onZoomStart,
      zoomend: this._onZoomEnd,
      click: this._onClick as L.LeafletEventHandlerFn,
      mousemove: this._onMouseMove as L.LeafletEventHandlerFn,
    };
    if ((this._lmap as any)?._zoomAnimated) ev.zoomanim = this._onAnimZoom as L.LeafletEventHandlerFn;
    return ev;
  }

  // ---- public data API ----
  setVisibility(showBuses: boolean, showSubway: boolean) {
    this._showBuses = showBuses;
    this._showSubway = showSubway;
  }

  /** Inject the lazy route-shape cache so buses glide ALONG their route (Ant Farm v3). */
  setShapeSource(cache: RouteShapeCache) {
    this._shapes = cache;
  }

  private _recordPredErr(ft: number) {
    if (!isFinite(ft) || ft < 0) return;
    this._perr[this._perrN % PRED_ERR_CAP] = ft;
    this._perrN++;
  }

  // ---- F4: motion trails / follow / focus ----
  /** Enable/disable the ~20 s fading motion tail per moving unit. */
  setTrails(on: boolean) {
    if (this._trails === on) return;
    this._trails = on;
    if (!on) for (const u of this._units.values()) u.tN = 0; // clear buffers
    this._dirty = true;
  }
  /** Dim every unit the predicate rejects to 25 % and drop its trail; the kept
   *  units pop. Pass null to clear focus. */
  setFocus(pred: FocusPred | null) {
    this._focus = pred;
    this._dirty = true;
  }
  /** Currently-displayed lat/lon of a unit (worm → its head), or null if gone.
   *  Standalone (not a draw side-effect) so follow works even when culled. */
  getDisplayLatLng(id: string): [number, number] | null {
    const u = this._units.get(id);
    if (!u || u.goneT !== undefined) return null;
    return this._dispAnchor(u, performance.now());
  }

  /** Ingest a bus snapshot. Buses carrying a backend `shape_id` + `route_offset_ft` glide
   *  ALONG their route shape (dead-reckoning at `speed_est_fps`, easing into each report,
   *  decaying to a stop when reports stop, docking when the offset stops advancing); buses
   *  without shape data — or whose shape geometry hasn't loaded yet — keep the straight glide.
   *  Shape geometry is resolved lazily per visible route via the injected shape cache. */
  setBuses(vehicles: Vehicle[], selected: string, colorFor: ColorFor) {
    const now = performance.now();
    const seen = new Set<string>();
    for (const v of vehicles) {
      if (selected && v.route_id !== selected) continue;
      const id = "b:" + v.vehicle_id;
      seen.add(id);
      const color = colorFor(v.route_id);
      const sbs = isSbs(v.route_id);

      // Resolve this bus's shape geometry lazily (visible routes only; deduped + LRU).
      const sid = v.shape_id ?? null;
      const hasOffset = sid != null && typeof v.route_offset_ft === "number";
      let poly: OffsetPoly | undefined;
      if (this._shapes && hasOffset) {
        this._shapes.ensure(v.route_id);
        poly = this._shapes.get(sid);
      }

      let u = this._units.get(id);
      if (!u) {
        u = {
          id,
          kind: "bus",
          prevLat: v.lat,
          prevLon: v.lon,
          curLat: v.lat,
          curLon: v.lon,
          prevT: now,
          curT: now,
          brg: v.bearing,
          color,
          lenM: sbs ? BUS_LEN_SBS_M : BUS_LEN_M,
          widM: BUS_W_M,
          est: false,
          label: v.route_id ?? "",
          appearT: now,
          missing: 0,
          data: v,
        };
        this._units.set(id, u);
      } else {
        u.brg = v.bearing;
        u.color = color;
        u.lenM = sbs ? BUS_LEN_SBS_M : BUS_LEN_M;
        u.missing = 0;
        u.goneT = undefined;
        u.data = v;
      }

      if (poly && hasOffset) {
        // ---- shape-offset dead-reckoning (Ant Farm v3) ----
        const oNew = v.route_offset_ft as number;
        const vRep = clampFps(v.speed_est_fps);
        if (u.offPoly && u.soReport !== undefined && u.soReportT !== undefined) {
          // established anchor: measure the between-tick prediction error, detect dwell, snap
          const tSec = (now - u.soReportT) / 1000;
          const predBefore = u.soReport + decayDist(u.soSpeed ?? 0, tSec);
          const errFt = Math.abs(predBefore - oNew);
          this._recordPredErr(errFt);
          if (errFt > SNAP_FT) u.soSnapUntil = now + SNAP_EASE_MS; // fast-ease, never teleport
          // dwelling = offset barely advanced over this real interval → dock, no fake creep
          const advFps = tSec > 1 ? (oNew - u.soReport) / tSec : vRep;
          u.docked = advFps < DWELL_FPS;
          u.soSpeed = u.docked ? 0 : vRep;
        } else {
          // first sighting on a shape → place exactly at the reported offset (no jump)
          if (u.soDisp === undefined) u.soDisp = oNew;
          u.soSpeed = vRep;
          u.docked = vRep < DWELL_FPS;
        }
        u.offPoly = poly;
        u.soReport = oNew;
        u.soReportT = now;
      } else {
        // ---- no shape geometry (or not loaded yet): straight prev→cur glide ----
        if (u.offPoly) {
          // was riding a shape → continue the straight glide from where it's shown now
          const d = this._dispAnchor(u, now);
          u.prevLat = d[0];
          u.prevLon = d[1];
          u.curLat = v.lat;
          u.curLon = v.lon;
          u.prevT = now;
          u.curT = now + GLIDE_MS;
          u.offPoly = undefined;
        } else {
          const moved = metersBetween([u.curLat, u.curLon], [v.lat, v.lon]);
          if (moved > 2 || u.curT <= u.prevT) {
            const d = this._dispLL(u, now);
            u.prevLat = d[0];
            u.prevLon = d[1];
            u.curLat = v.lat;
            u.curLon = v.lon;
            u.prevT = now;
            u.curT = now + GLIDE_MS;
          }
        }
        u.docked = false;
      }
    }
    this._sweep(seen, "bus", now);
    this._dirty = true;
  }

  setTrains(trains: SubwayTrain[]) {
    const now = performance.now();
    const seen = new Set<string>();
    for (const t of trains) {
      const id = "t:" + t.feed + "|" + t.trip_id;
      seen.add(id);
      const color = subwayColor(t.route_id);
      const est = t.positional_basis === "interpolated";
      const atStation = t.status === "at_station";
      // Consume the backend's new seg_basis when present ("straight" = a prev→next
      // glide line, "shape" = real track polyline). Non-breaking if absent.
      const segBasis = (t as { seg_basis?: string }).seg_basis;
      const hasSeg = !!(t.seg && t.seg.length >= 2);
      const segKey = hasSeg ? t.seg![0].join(",") + "~" + t.seg![t.seg!.length - 1].join(",") : "";
      let u = this._units.get(id);
      if (!u) {
        u = {
          id,
          kind: "train",
          prevLat: t.lat,
          prevLon: t.lon,
          curLat: t.lat,
          curLon: t.lon,
          prevT: now,
          curT: now,
          brg: null,
          color,
          lenM: TRAIN_LEN_M,
          widM: TRAIN_W_M,
          est,
          atStation,
          segBasis,
          label: subwayLabel(t.route_id),
          appearT: now,
          missing: 0,
          data: t,
        };
        this._units.set(id, u);
      } else {
        u.color = color;
        u.est = est;
        u.atStation = atStation;
        u.segBasis = segBasis;
        u.missing = 0;
        u.goneT = undefined;
        u.data = t;
        // seg trains own prevT/curT via the fraction glide (below); only non-seg
        // (station / point-estimate) trains retarget by lat/lon here.
        if (!hasSeg) {
          const moved = metersBetween([u.curLat, u.curLon], [t.lat, t.lon]);
          if (moved > 2 || u.curT <= u.prevT) {
            const d = this._dispLL(u, now);
            u.prevLat = d[0];
            u.prevLon = d[1];
            u.curLat = t.lat;
            u.curLon = t.lon;
            u.prevT = now;
            u.curT = now + GLIDE_MS;
          }
        }
      }
      // inter-station worm geometry — glide the fraction along the SAME segment
      // over the nominal tick; snap (no interpolation) when the segment changes.
      if (hasSeg) {
        const stable = u.segKey === segKey && !!u.seg;
        // displayed fraction BEFORE we overwrite the timing (avoids a backward jump)
        const wf = u.curT > u.prevT ? Math.min(1, Math.max(0, (now - u.prevT) / (u.curT - u.prevT))) : 1;
        const dispFrac = (u.prevFrac ?? 0) + ((u.curFrac ?? 0) - (u.prevFrac ?? 0)) * wf;
        const cum = [0];
        let len = 0;
        for (let i = 1; i < t.seg!.length; i++) {
          len += metersBetween(t.seg![i - 1], t.seg![i]);
          cum.push(len);
        }
        u.seg = t.seg!;
        u.segCum = cum;
        u.segLen = len;
        const nf = typeof t.frac === "number" ? t.frac : 0.5;
        u.prevFrac = stable ? dispFrac : nf; // continue from displayed, or snap
        u.curFrac = nf;
        u.prevT = now;
        u.curT = now + GLIDE_MS;
        u.segKey = segKey;
      } else {
        u.seg = undefined;
        u.segLen = undefined;
        u.segKey = "";
      }
    }
    this._sweep(seen, "train", now);
    this._dirty = true;
  }

  getStats() {
    return {
      units: this._units.size,
      emaFrameMs: Math.round(this._emaMs * 100) / 100,
      fps: Math.round(60 / this._fpsDivisor),
      tickJump: this._tickJump,
      predErr: this._predErrStats(), // between-tick prediction error (ft): {n, medianFt, p90Ft}
    };
  }

  /** Median + p90 of the accumulated between-tick prediction errors (ft), from the ring
   *  buffer. Sorts a copy on demand (getStats runs ~1×/s — cheap). */
  private _predErrStats(): { n: number; medianFt: number | null; p90Ft: number | null } {
    const n = Math.min(this._perrN, PRED_ERR_CAP);
    if (n === 0) return { n: 0, medianFt: null, p90Ft: null };
    const a = Array.from(this._perr.subarray(0, n)).sort((x, y) => x - y);
    const q = (p: number) => a[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
    return { n, medianFt: Math.round(q(0.5) * 10) / 10, p90Ft: Math.round(q(0.9) * 10) / 10 };
  }

  // ---- internals ----
  private _sweep(seen: Set<string>, kind: "bus" | "train", now: number) {
    for (const [id, u] of this._units) {
      if (u.kind !== kind) continue;
      if (seen.has(id)) continue;
      u.missing++;
      if (u.missing >= STALE_TICKS && u.goneT === undefined) {
        u.goneT = now; // start the fade-out
        // Ant Farm v3: a bus that vanished for >3 ticks → coalesced "went offline" beacon.
        if (kind === "bus") trackBusOffline(1);
      }
      if (u.goneT !== undefined && now - u.goneT > FADE_MS) this._units.delete(id);
    }
  }

  private _onVis() {
    if (document.hidden) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    } else if (!this._raf) {
      this._raf = requestAnimationFrame(this._loop);
    }
  }

  private _onZoomStart = () => {
    this._zooming = true;
  };
  private _onZoomEnd = () => {
    this._zooming = false;
    this._reset();
  };
  private _onZoomThrottle = () => {
    if (!this._zooming) this._reset();
  };
  private _onAnimZoom = (e: any) => {
    this._updateTransform(e.center, e.zoom);
  };

  private _reset = () => {
    this._update();
    this._updateTransform(this._center, this._zoom);
    this._dirty = true;
  };

  private _update() {
    const map = this._lmap;
    const p = this._padding;
    const size = map.getSize();
    const min = map.containerPointToLayerPoint(size.multiplyBy(-p)).round();
    const worldSize = size.multiplyBy(1 + p * 2).round();
    this._min = min;
    this._center = map.getCenter();
    this._zoom = map.getZoom();
    const dpr = (this._dpr = window.devicePixelRatio || 1);
    const c = this._canvas;
    c.width = Math.round(worldSize.x * dpr);
    c.height = Math.round(worldSize.y * dpr);
    c.style.width = worldSize.x + "px";
    c.style.height = worldSize.y + "px";
    L.DomUtil.setPosition(c, min);
  }

  // mirror of L.Renderer._updateTransform (Leaflet 1.9.4) so the canvas scales
  // smoothly through the zoom animation and re-pins on zoomend.
  private _updateTransform(center: L.LatLng, zoom: number) {
    const map = this._lmap as any;
    const scale = map.getZoomScale(zoom, this._zoom);
    const viewHalf = map.getSize().multiplyBy(0.5 + this._padding);
    const currentCenterPoint = map.project(this._center, zoom);
    const topLeftOffset = viewHalf
      .multiplyBy(-scale)
      .add(currentCenterPoint)
      .subtract(map._getNewPixelOrigin(center, zoom));
    L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
  }

  private _loop(ts: number) {
    this._raf = requestAnimationFrame(this._loop);
    if (this._zooming) return; // CSS transform carries the canvas during zoom
    // frame pacing for the 30 fps degrade step
    this._frameParity = (this._frameParity + 1) % this._fpsDivisor;
    if (this._fpsDivisor > 1 && this._frameParity !== 0) return;
    // tick-jump (last resort): the glide is off, so redraw only on data/view change
    if (this._tickJump && !this._dirty) return;
    const t0 = performance.now();
    this._draw(ts);
    this._dirty = false;
    const dt = performance.now() - t0;
    this._emaMs = this._emaMs === 0 ? dt : this._emaMs * 0.9 + dt * 0.1;
    this._maybeDegrade();
  }

  // Graceful, REVERSIBLE degrade. 30 fps first; tick-jump only as a genuine last
  // resort (draw itself absurdly slow). Recovers when the view gets cheap again
  // (e.g. zooming in) so a transient spike never permanently freezes the glide.
  private _maybeDegrade() {
    const b = FRAME_BUDGET_MS;
    // level: 0 full · 1 trails-dropped · 2 30fps · 3 tick-jump (trails are the
    // FIRST thing shed under load, per the F4 perf pact).
    const lvl = () =>
      this._tickJump ? 3 : this._fpsDivisor === 2 ? 2 : this._trails && this._trailsDropped ? 1 : 0;
    const before = lvl();
    const trailsLive = this._trails && !this._trailsDropped;
    if (this._emaMs > b * 2.4) {
      this._tickJump = true;
    } else if (this._emaMs > b) {
      if (trailsLive)
        this._trailsDropped = true; // shed trails BEFORE dropping frame rate
      else if (this._fpsDivisor === 1) this._fpsDivisor = 2; // 60 -> 30 fps
    } else if (this._emaMs < b * 0.5) {
      // hysteresis recovery: climb back one step at a time (reverse order)
      if (this._tickJump) this._tickJump = false;
      else if (this._fpsDivisor !== 1) this._fpsDivisor = 1;
      else if (this._trailsDropped) this._trailsDropped = false;
    }
    const after = lvl();
    if (after !== before && !this._degradedLogged && after > before) {
      // log the first real degrade only (not per-frame; not on recovery)
      this._degradedLogged = true;
      const what = after === 3 ? "tick-jump" : after === 2 ? "30 fps" : "trails-off";
      // eslint-disable-next-line no-console
      console.warn(
        `[VehicleFlowLayer] ${this._emaMs.toFixed(1)}ms/frame, ${this._units.size} units → ` +
          `${what} (auto-recovers when the view is cheaper).`,
      );
    }
  }

  // frame-scoped state (set once per _draw, read by the helpers — no arg plumbing)
  private _fminx = 0;
  private _fminy = 0;
  private _fpanex = 0;
  private _fpaney = 0;
  private _fwpx = 0;
  private _fhpx = 0;
  private _fmpp = 1;
  private _fzoom = 0;
  private _foutline = "";
  private _fnow = 0; // performance.now() for this frame (dock pulse + ease)
  private _fdt = 16; // ms since the previous drawn frame (ease step)

  // Inline Web-Mercator projection (EPSG:3857) — writes layer-space px into
  // _plx/_ply with zero allocation. Equivalent to map.latLngToLayerPoint but
  // ~far cheaper in the ~4k-unit hot loop (no Point objects, no GC).
  private _project(lat: number, lon: number) {
    let s = Math.sin(lat * DEG);
    if (s > 0.99999) s = 0.99999;
    else if (s < -0.99999) s = -0.99999;
    const merc = 0.5 * Math.log((1 + s) / (1 - s));
    this._plx = this._cA * lon + this._ccx;
    this._ply = this._ccy - this._cmy * merc;
  }

  // Advance a shape-following bus's DISPLAYED offset (soDisp) one frame toward the decay-
  // predicted target. The target is last-reported-offset + distance travelled at the reported
  // speed with a linear decay to a full stop over DECAY_S (the sparse-data humility rule); a
  // docked bus has speed 0 so the target is its reported offset — it holds, no fake creep.
  // soDisp EASES toward the target (fast during a snap window) so a >200 ft correction closes
  // in ≤1 s without a visible teleport.
  private _advanceBusOffset(u: Unit, now: number) {
    const poly = u.offPoly;
    if (!poly || u.soReport === undefined || u.soReportT === undefined) return;
    const tSec = (now - u.soReportT) / 1000;
    let target = u.soReport + decayDist(u.soSpeed ?? 0, tSec);
    if (target > poly.lenFt) target = poly.lenFt;
    else if (target < 0) target = 0;
    if (u.soDisp === undefined) {
      u.soDisp = target;
      return;
    }
    if (this._tickJump) {
      u.soDisp = target; // glide is off — jump to the model position
      return;
    }
    const tau = now < (u.soSnapUntil ?? 0) ? SNAP_TAU_MS : EASE_TAU_MS;
    const k = 1 - Math.exp(-this._fdt / tau);
    u.soDisp += (target - u.soDisp) * k;
  }

  // currently-displayed (interpolated) lat/lon of a unit at time `now`
  private _dispLL(u: Unit, now: number): [number, number] {
    let f = 1;
    if (u.curT > u.prevT) {
      f = (now - u.prevT) / (u.curT - u.prevT);
      f = f < 0 ? 0 : f > 1 ? 1 : f;
    }
    return [u.prevLat + (u.curLat - u.prevLat) * f, u.prevLon + (u.curLon - u.prevLon) * f];
  }

  // Displayed ANCHOR of a unit (the point follow tracks + the point the trail
  // samples): a worm's HEAD (leading toward the target station), a bus's snapped
  // position on its follow-shape when present, else the plain prev→cur glide.
  private _dispAnchor(u: Unit, now: number): [number, number] {
    let f = 1;
    if (u.curT > u.prevT) {
      f = (now - u.prevT) / (u.curT - u.prevT);
      f = f < 0 ? 0 : f > 1 ? 1 : f;
    }
    if (u.kind === "train" && u.seg && u.segCum && u.segLen && u.segLen > 0) {
      const frac = (u.prevFrac ?? 0) + ((u.curFrac ?? 0) - (u.prevFrac ?? 0)) * f;
      const head = Math.min(u.segLen, frac * u.segLen + TRAIN_LEN_M / 2);
      return pointAtDist(u.seg, u.segCum, head);
    }
    if (u.kind === "bus" && u.offPoly && u.soDisp !== undefined) {
      return pointAtOffset(u.offPoly, u.soDisp);
    }
    return [u.prevLat + (u.curLat - u.prevLat) * f, u.prevLon + (u.curLon - u.prevLon) * f];
  }

  // Append the current anchor to a unit's trail ring buffer, throttled so
  // TRAIL_CAP points cover ~20 s. Lazily allocates the buffer on first sample.
  private _sampleTrail(u: Unit, now: number, lat: number, lon: number) {
    if (u.tLastT !== undefined && now - u.tLastT < TRAIL_SAMPLE_MS) return;
    if (!u.tLat) {
      u.tLat = new Float64Array(TRAIL_CAP);
      u.tLon = new Float64Array(TRAIL_CAP);
      u.tN = 0;
      u.tHead = 0;
    }
    const h = u.tHead ?? 0;
    u.tLat[h] = lat;
    u.tLon![h] = lon;
    u.tHead = (h + 1) % TRAIL_CAP;
    u.tN = Math.min(TRAIL_CAP, (u.tN ?? 0) + 1);
    u.tLastT = now;
  }

  // Reusable scratch for projected trail vertices (no per-unit allocation).
  private _tx = new Float32Array(TRAIL_CAP);
  private _ty = new Float32Array(TRAIL_CAP);

  // Draw a unit's fading tail (oldest → newest, alpha ramps 0 → TRAIL_MAX_ALPHA).
  // BANDED: the ramp is drawn in ≤3 contiguous strokes (not one per segment), so
  // 3,000 tails cost ~3k strokes, not ~33k — the difference that keeps trails
  // inside the frame budget at the 3,000-unit worst case.
  private _drawTrail(u: Unit, alpha: number) {
    const n = u.tN ?? 0;
    if (n < 2 || !u.tLat || !u.tLon) return;
    const ctx = this._ctx;
    const cap = TRAIL_CAP;
    const start = n < cap ? 0 : u.tHead ?? 0;
    const minx = this._fminx,
      miny = this._fminy;
    const tx = this._tx,
      ty = this._ty;
    for (let k = 0; k < n; k++) {
      const idx = (start + k) % cap;
      this._project(u.tLat[idx], u.tLon[idx]);
      tx[k] = this._plx - minx;
      ty[k] = this._ply - miny;
    }
    ctx.strokeStyle = u.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.1;
    const bands = Math.min(3, n - 1);
    for (let b = 0; b < bands; b++) {
      const a = TRAIL_MAX_ALPHA * ((b + 1) / bands) * alpha; // faint tail → strong head
      if (a <= 0.02) continue;
      const lo = Math.floor((b * (n - 1)) / bands);
      const hi = Math.floor(((b + 1) * (n - 1)) / bands);
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(tx[lo], ty[lo]);
      for (let k = lo + 1; k <= hi; k++) ctx.lineTo(tx[k], ty[k]);
      ctx.stroke();
    }
  }

  private _ensureHit(n: number) {
    if (this._hx.length < n) {
      const cap = Math.max(n, this._hx.length * 2, 256);
      this._hx = new Float32Array(cap);
      this._hy = new Float32Array(cap);
      this._hr = new Float32Array(cap);
      this._hkind = new Uint8Array(cap);
    }
    this._hn = 0;
  }

  private _pushHit(cx: number, cy: number, r: number, kind: number, data: Vehicle | SubwayTrain) {
    const i = this._hn++;
    this._hx[i] = cx;
    this._hy[i] = cy;
    this._hr[i] = r;
    this._hkind[i] = kind;
    this._hdata[i] = data;
  }

  private _draw(now: number) {
    const map = this._lmap;
    const ctx = this._ctx;
    const dpr = this._dpr;
    const c = this._canvas;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width / dpr, c.height / dpr);
    this._ensureHit(this._units.size);

    const zoom = (this._fzoom = map.getZoom());
    const size = map.getSize();
    this._fwpx = size.x;
    this._fhpx = size.y;
    const panePos = (map as any)._getMapPanePos();
    this._fpanex = panePos.x;
    this._fpaney = panePos.y;
    this._fminx = this._min.x;
    this._fminy = this._min.y;
    const midLat = map.getCenter().lat;
    this._fmpp = metersPerPixel(midLat, zoom);
    this._foutline = this._dark ? "rgba(10,12,16,0.85)" : "rgba(30,36,45,0.55)";
    this._fnow = now;
    const rawDt = this._lastFrameT ? now - this._lastFrameT : 16;
    this._fdt = rawDt < 0 ? 0 : rawDt > 100 ? 100 : rawDt; // clamp (tab-switch / long frame)
    this._lastFrameT = now;

    // projection constants for this zoom (see _project)
    const scale = 256 * Math.pow(2, zoom);
    const origin = map.getPixelOrigin();
    const half = scale * 0.5;
    this._cA = (scale * 0.5 * DEG) / Math.PI;
    this._ccx = half - origin.x;
    this._cmy = (scale * 0.5) / Math.PI;
    this._ccy = half - origin.y;

    const slab = zoom < SLAB_ZOOM;
    const minx = this._fminx,
      miny = this._fminy,
      px = this._fpanex,
      py = this._fpaney,
      wpx = this._fwpx,
      hpx = this._fhpx;
    const speck = Math.max(1.6, MIN_LEN_PX * 0.8);
    const tick = this._tickJump;
    let lastColor = "";

    for (const u of this._units.values()) {
      if (u.kind === "bus" ? !this._showBuses : !this._showSubway) continue;

      // Ant Farm v3: advance a shape-following bus along its route (dead-reckoning + decay +
      // ease). Docked buses hold; snap windows ease fast. Off-shape buses fall through to f.
      if (u.kind === "bus" && u.offPoly && u.soReportT !== undefined) this._advanceBusOffset(u, now);

      // real-time glide fraction
      let f = 1;
      if (!tick && u.curT > u.prevT) {
        f = (now - u.prevT) / (u.curT - u.prevT);
        f = f < 0 ? 0 : f > 1 ? 1 : f;
      }
      // opacity: appear fade-in · stale fade-out · subway-estimated dim
      let alpha = 1;
      if (now - u.appearT < APPEAR_MS) alpha = (now - u.appearT) / APPEAR_MS;
      if (u.goneT !== undefined) alpha *= Math.max(0, 1 - (now - u.goneT) / FADE_MS);
      if (u.est) alpha *= 0.62;
      // F4 focus dim: units the focus predicate rejects drop to 25 % and lose
      // their trail; the kept flow pops. (No focus → everything bright.)
      const bright = !this._focus || this._focus(u.kind, u.data.route_id ?? null);
      if (!bright) alpha *= 0.25;
      if (alpha <= 0.02) continue;

      // F4 motion trail: sample + draw the ~20 s fading tail (bright units only;
      // dropped first by the degrade ladder). Drawn under the unit's own shape.
      if (this._trails && !this._trailsDropped && bright && u.goneT === undefined) {
        const anchor = this._dispAnchor(u, now);
        this._sampleTrail(u, now, anchor[0], anchor[1]);
        this._drawTrail(u, alpha);
      }

      if (slab) {
        // veins mode: a moving speck (fillRect is much cheaper than arc)
        let lat: number, lon: number;
        if (u.kind === "bus" && u.offPoly && u.soDisp !== undefined) {
          const p = pointAtOffset(u.offPoly, u.soDisp); // shape-following even as a speck
          lat = p[0];
          lon = p[1];
        } else {
          lat = u.prevLat + (u.curLat - u.prevLat) * f;
          lon = u.prevLon + (u.curLon - u.prevLon) * f;
        }
        this._project(lat, lon);
        const x = this._plx - minx,
          y = this._ply - miny;
        const cx = this._plx + px,
          cy = this._ply + py;
        if (cx < -8 || cy < -8 || cx > wpx + 8 || cy > hpx + 8) continue;
        ctx.globalAlpha = alpha;
        if (u.color !== lastColor) {
          ctx.fillStyle = u.color;
          lastColor = u.color;
        }
        ctx.fillRect(x - speck * 0.5, y - speck * 0.5, speck, speck);
        this._pushHit(cx, cy, 6, u.kind === "bus" ? 0 : 1, u.data);
        continue;
      }

      if (u.kind === "train" && u.seg && u.segLen && u.segLen > 0) {
        this._drawTrainWorm(u, f, alpha);
      } else if (u.kind === "train") {
        this._drawStationTrain(u, alpha);
      } else {
        this._drawBus(u, f, alpha);
      }
    }
    ctx.globalAlpha = 1;
  }

  // a true-scale, bearing-oriented rounded slab (buses)
  private _drawBus(u: Unit, f: number, alpha: number) {
    let lat: number, lon: number, blat: number, blon: number;
    if (u.offPoly && u.soDisp !== undefined) {
      // shape-following: position AT the displayed offset; bearing from ~20 ft ahead along
      // the shape (so the slab points down the road, never corner-cuts).
      const s = u.soDisp;
      const p = pointAtOffset(u.offPoly, s);
      const ahead = pointAtOffset(u.offPoly, Math.min(s + 20, u.offPoly.lenFt));
      lat = p[0];
      lon = p[1];
      blat = ahead[0];
      blon = ahead[1];
    } else {
      lat = u.prevLat + (u.curLat - u.prevLat) * f;
      lon = u.prevLon + (u.curLon - u.prevLon) * f;
      const moved = metersBetween([u.prevLat, u.prevLon], [u.curLat, u.curLon]);
      if (moved > 4) {
        blat = u.curLat;
        blon = u.curLon;
      } else if (u.brg != null) {
        const b = u.brg * DEG;
        blat = lat + Math.cos(b) * 0.0005;
        blon = lon + (Math.sin(b) * 0.0005) / Math.cos(lat * DEG);
      } else {
        blat = lat + 0.0005;
        blon = lon;
      }
    }
    this._project(lat, lon);
    const lx = this._plx,
      ly = this._ply;
    const x = lx - this._fminx,
      y = ly - this._fminy;
    const cx = lx + this._fpanex,
      cy = ly + this._fpaney;
    if (cx < -30 || cy < -30 || cx > this._fwpx + 30 || cy > this._fhpx + 30) return;
    this._project(blat, blon);
    const ang = Math.atan2(this._ply - ly, this._plx - lx);

    const ctx = this._ctx;
    const mpp = this._fmpp;
    const lenPx = Math.max(MIN_LEN_PX, u.lenM / mpp);
    const wPx = Math.max(MIN_W_PX, u.widM / mpp);
    ctx.globalAlpha = alpha;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    roundRect(ctx, -lenPx / 2, -wPx / 2, lenPx, wPx, Math.min(wPx / 2, lenPx / 2));
    ctx.fillStyle = u.color;
    ctx.fill();
    if (lenPx > 5) {
      ctx.lineWidth = Math.max(0.6, wPx * 0.18);
      ctx.strokeStyle = this._foutline;
      ctx.stroke();
      if (this._fzoom >= 15) {
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.beginPath();
        ctx.arc(lenPx / 2 - wPx * 0.5, 0, Math.max(0.8, wPx * 0.22), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    // Docked/dwelling bus: a subtle breathing pulse IN PLACE (an expanding, fading ring) — the
    // honest "stopped at a stop" signal, with no fake forward creep.
    if (u.docked) {
      const ph = (this._fnow % 1600) / 1600; // 0..1 over ~1.6 s
      const rr = Math.max(lenPx, wPx) * 0.5 + 2 + ph * 6;
      ctx.globalAlpha = alpha * (1 - ph) * 0.45;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = u.color;
      ctx.stroke();
      ctx.globalAlpha = alpha;
    }
    this._pushHit(cx, cy, Math.max(8, lenPx / 2), 0, u.data);
  }

  // Subway train with no inter-station segment. Two honest states:
  //   * DOCKED (status at_station): a line-colored RING around the station disc.
  //     The ring rides this canvas (pane z-450) ABOVE the station SVG, so a docked
  //     train is legible on top of the white disc instead of hidden beneath it —
  //     the at-station occlusion fix. Radius is a small constant (px), a touch
  //     larger than the 2.5 px station disc, so it reads as "wrapped around" it.
  //   * OTHERWISE (approaching / point estimate, no seg): the small bullet dot,
  //     already dimmed via the `est` alpha.
  private _drawStationTrain(u: Unit, alpha: number) {
    this._project(u.curLat, u.curLon);
    const x = this._plx - this._fminx,
      y = this._ply - this._fminy;
    const cx = this._plx + this._fpanex,
      cy = this._ply + this._fpaney;
    if (cx < -20 || cy < -20 || cx > this._fwpx + 20 || cy > this._fhpx + 20) return;
    const ctx = this._ctx;
    ctx.globalAlpha = alpha;

    if (u.atStation) {
      // ring: radius slightly larger than the station disc (r≈2.5); constant px
      const rr = 4.5;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      // faint contrast underlay so the ring survives on light OR dark basemaps
      ctx.lineWidth = 3;
      ctx.strokeStyle = this._foutline;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = u.color;
      ctx.stroke();
      this._pushHit(cx, cy, Math.max(9, rr + 3), 1, u.data);
      return;
    }

    const wPx = Math.max(MIN_W_PX + 0.6, TRAIN_W_M / this._fmpp);
    const r = Math.max(4, wPx * 1.15);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = u.color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = this._foutline;
    ctx.stroke();
    if (this._fzoom >= LABEL_ZOOM) {
      ctx.fillStyle = u.color.toUpperCase() === "#FCCC0A" ? "#111" : "#fff";
      ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(u.label, x, y + 0.5);
    }
    this._pushHit(cx, cy, Math.max(8, r), 1, u.data);
  }

  // subway trains with a segment: a ~160 m worm lying ALONG the track.
  private _drawTrainWorm(u: Unit, f: number, alpha: number) {
    const seg = u.seg!,
      cum = u.segCum!,
      segLen = u.segLen!;
    const frac = (u.prevFrac ?? 0) + ((u.curFrac ?? 0) - (u.prevFrac ?? 0)) * f;
    const center = frac * segLen;
    const mpp = this._fmpp;
    const lenPx = Math.max(MIN_LEN_PX, TRAIN_LEN_M / mpp);
    const halfM = (lenPx * mpp) / 2; // meters window matching the clamped px length
    const d0 = Math.max(0, center - halfM);
    const d1 = Math.min(segLen, center + halfM);
    const minx = this._fminx,
      miny = this._fminy;

    // cull on the worm centroid
    const cll = pointAtDist(seg, cum, center);
    this._project(cll[0], cll[1]);
    const ccx = this._plx + this._fpanex,
      ccy = this._ply + this._fpaney;
    if (ccx < -80 || ccy < -80 || ccx > this._fwpx + 80 || ccy > this._fhpx + 80) return;

    const ctx = this._ctx;
    ctx.globalAlpha = alpha;

    // worm vertices in [d0,d1]: endpoints + interior shape points
    ctx.beginPath();
    const h0 = pointAtDist(seg, cum, d0);
    this._project(h0[0], h0[1]);
    ctx.moveTo(this._plx - minx, this._ply - miny);
    for (let i = 0; i < seg.length; i++) {
      if (cum[i] > d0 && cum[i] < d1) {
        this._project(seg[i][0], seg[i][1]);
        ctx.lineTo(this._plx - minx, this._ply - miny);
      }
    }
    const h1 = pointAtDist(seg, cum, d1);
    this._project(h1[0], h1[1]);
    const hx = this._plx - minx,
      hy = this._ply - miny;
    ctx.lineTo(hx, hy);

    const wPx = Math.max(MIN_W_PX + 0.6, TRAIN_W_M / mpp);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = this._foutline; // contrast underlay
    // straight-basis segments are a simple prev→next glide line (no real track
    // curvature) — draw a marginally thinner underlay so they read a touch simpler.
    ctx.lineWidth = wPx + (u.segBasis === "straight" ? 0.8 : 1.4);
    ctx.stroke();
    ctx.strokeStyle = u.color;
    ctx.lineWidth = wPx;
    ctx.stroke();

    // line bullet at the head (leading toward the target station)
    if (this._fzoom >= LABEL_ZOOM) {
      const br = Math.max(5.5, wPx * 1.15);
      ctx.beginPath();
      ctx.arc(hx, hy, br, 0, Math.PI * 2);
      ctx.fillStyle = u.color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = this._foutline;
      ctx.stroke();
      ctx.fillStyle = u.color.toUpperCase() === "#FCCC0A" ? "#111" : "#fff";
      ctx.font = `700 ${Math.round(br * 1.2)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(u.label, hx, hy + 0.5);
    }
    this._pushHit(ccx, ccy, Math.max(8, wPx), 1, u.data);
  }

  // ---- interaction ----
  private _pickIdx(cp: L.Point): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this._hn; i++) {
      const dx = this._hx[i] - cp.x,
        dy = this._hy[i] - cp.y;
      const d = dx * dx + dy * dy;
      const rr = Math.max(8, this._hr[i]);
      if (d < rr * rr && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private _selOf(data: Vehicle | SubwayTrain, kind: number): FlowSelection {
    if (kind === 0) {
      const v = data as Vehicle;
      return {
        id: "b:" + v.vehicle_id,
        kind: "bus",
        routeId: v.route_id,
        label: v.route_id ?? "?",
        sub: "bus " + v.vehicle_id,
      };
    }
    const t = data as SubwayTrain;
    return {
      id: "t:" + t.feed + "|" + t.trip_id,
      kind: "train",
      routeId: t.route_id,
      label: subwayLabel(t.route_id),
      sub: "train " + t.trip_id.slice(-6),
    };
  }

  private _onClick = (e: L.LeafletMouseEvent) => {
    const i = this._pickIdx(e.containerPoint);
    if (i < 0) return;
    const data = this._hdata[i];
    const kind = this._hkind[i];
    const sel = this._selOf(data, kind);
    let html = kind === 0 ? this._hooks.busPopup(data as Vehicle) : this._hooks.trainPopup(data as SubwayTrain);
    // F4 action row — one tap to follow this unit or focus its route/line.
    const canAct = !!(this._hooks.onFollow || this._hooks.onFocus);
    if (canAct) {
      const focusLabel = kind === 0 ? "Focus route" : "Focus line";
      html +=
        `<div class="flow-pop-actions">` +
        (this._hooks.onFollow ? `<button type="button" class="flow-pop-btn" data-flow="follow">▸ Follow</button>` : "") +
        (this._hooks.onFocus ? `<button type="button" class="flow-pop-btn" data-flow="focus">◎ ${focusLabel}</button>` : "") +
        `</div>`;
    }
    const popup = L.popup({ offset: [0, -2] }).setLatLng(e.latlng).setContent(html).openOn(this._lmap);
    if (canAct) {
      const el = popup.getElement();
      el?.querySelectorAll<HTMLButtonElement>(".flow-pop-btn").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const act = btn.getAttribute("data-flow");
          this._lmap.closePopup(popup);
          if (act === "follow") this._hooks.onFollow?.(sel);
          else if (act === "focus") this._hooks.onFocus?.(sel);
        });
      });
    }
  };

  private _onMouseMove = (e: L.LeafletMouseEvent) => {
    const over = this._pickIdx(e.containerPoint) >= 0;
    this._lmap.getContainer().style.cursor = over ? "pointer" : "";
  };
}

// SBS/express identification from the route id (optional 18 m articulated size).
function isSbs(routeId: string | null): boolean {
  if (!routeId) return false;
  const up = routeId.toUpperCase();
  return up.includes("+") || up.startsWith("SIM") || up.startsWith("BM") || up.startsWith("QM") || up.startsWith("BXM");
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
