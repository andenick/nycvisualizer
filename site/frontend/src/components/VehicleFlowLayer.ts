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

type ColorFor = (routeId: string | null) => string;
export interface FlowPopupHooks {
  busPopup: (v: Vehicle) => string;
  trainPopup: (t: SubwayTrain) => string;
}

interface Poly {
  pts: [number, number][];
  cum: number[];
  len: number;
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
  label: string;
  // subway worm geometry (travel-ordered inter-station segment):
  seg?: [number, number][];
  segCum?: number[];
  segLen?: number;
  segKey?: string;
  prevFrac?: number;
  curFrac?: number;
  // selected-bus shape following:
  followPoly?: Poly;
  prevS?: number;
  curS?: number;
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

function buildPoly(pts: [number, number][]): Poly {
  const cum = [0];
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += metersBetween(pts[i - 1], pts[i]);
    cum.push(len);
  }
  return { pts, cum, len };
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

/** Nearest point on a polyline (planar approx). Returns arc-length s + distance (m). */
function projectToPoly(poly: Poly, ll: [number, number]): { s: number; dist: number } {
  const kx = Math.cos((ll[0] * Math.PI) / 180);
  let best = Infinity,
    bestS = 0;
  for (let i = 1; i < poly.pts.length; i++) {
    const a = poly.pts[i - 1],
      b = poly.pts[i];
    const ax = a[1] * kx,
      ay = a[0],
      bx = b[1] * kx,
      by = b[0];
    const px = ll[1] * kx,
      py = ll[0];
    const dx = bx - ax,
      dy = by - ay;
    const l2 = dx * dx + dy * dy || 1e-12;
    let t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t,
      cy = ay + dy * t;
    const dd = (px - cx) * (px - cx) + (py - cy) * (py - cy);
    if (dd < best) {
      best = dd;
      // arc-length (m) of the projected point along the polyline
      bestS = poly.cum[i - 1] + t * (poly.cum[i] - poly.cum[i - 1]);
    }
  }
  // `best` is a squared distance in degrees; convert to meters (~111320 m/deg)
  return { s: bestS, dist: Math.sqrt(best) * 111320 };
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
  // shape-follow cache for the selected route:
  private _routePolys: Poly[] | null = null;
  private _routeKey = "";
  // perf:
  private _emaMs = 0;
  private _fpsDivisor = 1; // 1 = full rAF, 2 = ~30 fps
  private _tickJump = false;
  private _degradedLogged = false;
  private _frameParity = 0;
  private _dirty = true; // in tick-jump mode, only redraw when data/view changed

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
    map.getPanes().overlayPane.appendChild(canvas);
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

  /** Ingest a bus snapshot. `shape` (selected route's polylines) enables
   *  shape-following for that route's buses; pass null when no route selected. */
  setBuses(
    vehicles: Vehicle[],
    selected: string,
    colorFor: ColorFor,
    shape: [number, number][][] | null,
  ) {
    const now = performance.now();
    // build/cache the follow polylines for the selected route
    if (selected && shape && shape.length) {
      const key = selected + ":" + shape.length;
      if (this._routeKey !== key) {
        this._routePolys = shape.map(buildPoly).filter((p) => p.len > 0);
        this._routeKey = key;
      }
    } else {
      this._routePolys = null;
      this._routeKey = "";
    }

    const seen = new Set<string>();
    for (const v of vehicles) {
      if (selected && v.route_id !== selected) continue;
      const id = "b:" + v.vehicle_id;
      seen.add(id);
      const color = colorFor(v.route_id);
      const sbs = isSbs(v.route_id);
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
        // Dead-reckoning retarget: glide from the CURRENTLY-DISPLAYED position
        // toward the new report over the nominal ~30 s tick (GLIDE_MS), so the
        // unit walks the last displacement smoothly instead of snapping and
        // freezing. Duplicate/near-identical reports don't restart the glide.
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
        u.brg = v.bearing;
        u.color = color;
        u.lenM = sbs ? BUS_LEN_SBS_M : BUS_LEN_M;
        u.missing = 0;
        u.goneT = undefined;
        u.data = v;
      }
      // shape following: project prev & cur onto the selected route
      u.followPoly = undefined;
      if (this._routePolys) {
        const cur = projectToPoly1(this._routePolys, [u.curLat, u.curLon]);
        const prv = projectToPoly1(this._routePolys, [u.prevLat, u.prevLon]);
        if (cur && prv && cur.poly === prv.poly && cur.dist < 55 && prv.dist < 55) {
          u.followPoly = cur.poly;
          u.prevS = prv.s;
          u.curS = cur.s;
        }
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
          label: subwayLabel(t.route_id),
          appearT: now,
          missing: 0,
          data: t,
        };
        this._units.set(id, u);
      } else {
        u.color = color;
        u.est = est;
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
    };
  }

  // ---- internals ----
  private _sweep(seen: Set<string>, kind: "bus" | "train", now: number) {
    for (const [id, u] of this._units) {
      if (u.kind !== kind) continue;
      if (seen.has(id)) continue;
      u.missing++;
      if (u.missing >= STALE_TICKS && u.goneT === undefined) u.goneT = now;
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
    const before = this._tickJump ? 2 : this._fpsDivisor === 2 ? 1 : 0;
    if (this._emaMs > b * 2.4) {
      this._tickJump = true;
    } else if (this._emaMs > b) {
      if (this._fpsDivisor === 1) this._fpsDivisor = 2; // 60 -> 30 fps
    } else if (this._emaMs < b * 0.5) {
      // hysteresis recovery: climb back one step at a time
      if (this._tickJump) this._tickJump = false;
      else if (this._fpsDivisor !== 1) this._fpsDivisor = 1;
    }
    const after = this._tickJump ? 2 : this._fpsDivisor === 2 ? 1 : 0;
    if (after !== before && !this._degradedLogged && after > 0) {
      // log the first real degrade only (not per-frame; not on recovery)
      this._degradedLogged = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[VehicleFlowLayer] ${this._emaMs.toFixed(1)}ms/frame, ${this._units.size} units → ` +
          `${after === 2 ? "tick-jump" : "30 fps"} (auto-recovers when the view is cheaper).`,
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

  // currently-displayed (interpolated) lat/lon of a unit at time `now`
  private _dispLL(u: Unit, now: number): [number, number] {
    let f = 1;
    if (u.curT > u.prevT) {
      f = (now - u.prevT) / (u.curT - u.prevT);
      f = f < 0 ? 0 : f > 1 ? 1 : f;
    }
    return [u.prevLat + (u.curLat - u.prevLat) * f, u.prevLon + (u.curLon - u.prevLon) * f];
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
      if (alpha <= 0.02) continue;

      if (slab) {
        // veins mode: a moving speck (fillRect is much cheaper than arc)
        const lat = u.prevLat + (u.curLat - u.prevLat) * f;
        const lon = u.prevLon + (u.curLon - u.prevLon) * f;
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
    if (u.followPoly && u.prevS !== undefined && u.curS !== undefined) {
      const s = u.prevS + (u.curS - u.prevS) * f;
      const p = pointAtDist(u.followPoly.pts, u.followPoly.cum, s);
      const ahead = pointAtDist(u.followPoly.pts, u.followPoly.cum, Math.min(s + 6, u.followPoly.len));
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
    this._pushHit(cx, cy, Math.max(8, lenPx / 2), 0, u.data);
  }

  // subway train stopped at a station (observed point, no segment): a bullet dot
  private _drawStationTrain(u: Unit, alpha: number) {
    this._project(u.curLat, u.curLon);
    const x = this._plx - this._fminx,
      y = this._ply - this._fminy;
    const cx = this._plx + this._fpanex,
      cy = this._ply + this._fpaney;
    if (cx < -20 || cy < -20 || cx > this._fwpx + 20 || cy > this._fhpx + 20) return;
    const ctx = this._ctx;
    const wPx = Math.max(MIN_W_PX + 0.6, TRAIN_W_M / this._fmpp);
    const r = Math.max(4, wPx * 1.15);
    ctx.globalAlpha = alpha;
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
    ctx.lineWidth = wPx + 1.4;
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

  private _onClick = (e: L.LeafletMouseEvent) => {
    const i = this._pickIdx(e.containerPoint);
    if (i < 0) return;
    const data = this._hdata[i];
    const html =
      this._hkind[i] === 0
        ? this._hooks.busPopup(data as Vehicle)
        : this._hooks.trainPopup(data as SubwayTrain);
    L.popup({ offset: [0, -2] }).setLatLng(e.latlng).setContent(html).openOn(this._lmap);
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

// project a latlng onto the nearest of several polylines
function projectToPoly1(
  polys: Poly[],
  ll: [number, number],
): { poly: Poly; s: number; dist: number } | null {
  let best: { poly: Poly; s: number; dist: number } | null = null;
  for (const poly of polys) {
    const r = projectToPoly(poly, ll);
    if (!best || r.dist < best.dist) best = { poly, s: r.s, dist: r.dist };
  }
  return best;
}
