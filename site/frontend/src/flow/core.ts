// nycviz-flow — the engine core: unit store, rAF loop, motion state machine, draw
// orchestration. Host-agnostic: every viewport/DOM/popup call goes through a FlowHost
// (never `leaflet`). Extracted VERBATIM from VehicleFlowLayer.ts; the only changes are
// mechanical (this._project → projector, this._lmap.* → host.*, draw branches → draw.ts).

import type { Vehicle, SubwayTrain } from "../lib/api";
import { subwayColor, subwayLabel } from "../lib/subwayColors";
import { RouteShapeCache, pointAtOffset, type OffsetPoly } from "../lib/shapeCache";
import { trackBusOffline } from "../lib/beacon";

import {
  APPEAR_MS,
  DECAY_S,
  DWELL_FPS,
  EASE_TAU_MS,
  FADE_MS,
  GLIDE_MS,
  MIN_LEN_PX,
  PRED_ERR_CAP,
  SLAB_ZOOM,
  SNAP_EASE_MS,
  SNAP_FT,
  SNAP_TAU_MS,
  STALE_TICKS,
  TRAIL_CAP,
  TRAIL_SAMPLE_MS,
  TRAIN_LEN_M,
  BUS_LEN_M,
  BUS_LEN_SBS_M,
  BUS_W_M,
  TRAIN_W_M,
} from "./constants";
import { Projector, metersBetween, metersPerPixel } from "./project";
import { buildSegCum, pointAtDist } from "./shapes";
import { DegradeLadder } from "./ladder";
import { HitStore, selOf } from "./hittest";
import { drawBus, drawSpeck, drawStationTrain, drawTrail, drawTrainWorm } from "./draw";
import type { ColorFor, DrawFrame, FlowHost, FlowPopupHooks, FlowSelection, FocusPred, LatLng, Unit } from "./types";

// ---- motion-model helpers (tween/decay-to-stop) — exported for tests ------------------

/** Distance (ft) travelled since a report of `speedFps`, with speed decaying LINEARLY to 0
 *  over DECAY_S — the honest ease-to-stop when no fresh report arrives. Monotonic, capped.
 *  [VehicleFlowLayer.ts L68-71] */
export function decayDist(speedFps: number, tSec: number): number {
  const tc = tSec < 0 ? 0 : tSec > DECAY_S ? DECAY_S : tSec;
  return speedFps * (tc - (tc * tc) / (2 * DECAY_S));
}

/** Sanitise a backend speed_est_fps to a non-negative, bounded fps (null/NaN → 0).
 *  [VehicleFlowLayer.ts L74-77] */
export function clampFps(v: number | null | undefined): number {
  if (v == null || !isFinite(v)) return 0;
  return v < 0 ? 0 : v > 90 ? 90 : v;
}

/** SBS/express identification from the route id (optional 18 m articulated size).
 *  [VehicleFlowLayer.ts L1254-1258] */
export function isSbs(routeId: string | null): boolean {
  if (!routeId) return false;
  const up = routeId.toUpperCase();
  return up.includes("+") || up.startsWith("SIM") || up.startsWith("BM") || up.startsWith("QM") || up.startsWith("BXM");
}

// --------------------------------------------------------------------------- the engine
export class FlowEngine {
  private _host: FlowHost;
  private _hooks: FlowPopupHooks;
  private _canvas!: HTMLCanvasElement;
  private _ctx!: CanvasRenderingContext2D;

  private _min: { x: number; y: number } = { x: 0, y: 0 };
  private _center: LatLng = { lat: 0, lng: 0 };
  private _zoom = 0;
  private _padding = 0.12;
  private _zooming = false;
  private _dpr = 1;
  private _raf = 0;
  private _units = new Map<string, Unit>();

  private _pr = new Projector();
  private _hit = new HitStore();
  private _ladder = new DegradeLadder();
  private _fr: DrawFrame;

  private _showBuses = true;
  private _showSubway = true;
  private _dark = false;
  // Ant Farm v3: lazy per-route shape geometry (LRU). Injected by the page (setShapeSource).
  private _shapes: RouteShapeCache | null = null;
  // between-tick prediction-error samples (ft), a ring buffer; median/p90 via getStats().
  private _perr = new Float32Array(PRED_ERR_CAP);
  private _perrN = 0;
  private _lastFrameT = 0; // performance.now() of the previous drawn frame (for ease dt)
  private _emaMs = 0;
  private _dirty = true; // in tick-jump mode, only redraw when data/view changed
  private _trails = false; // motion trails enabled (page sets default per surface)
  private _focus: FocusPred | null = null; // focus-dim predicate (null = no focus)

  constructor(host: FlowHost, hooks: FlowPopupHooks) {
    this._host = host;
    this._hooks = hooks;
    this._dark =
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    this._fr = {
      ctx: null as unknown as CanvasRenderingContext2D,
      pr: this._pr,
      hit: this._hit,
      minx: 0,
      miny: 0,
      panex: 0,
      paney: 0,
      wpx: 0,
      hpx: 0,
      mpp: 1,
      zoom: 0,
      outline: "",
      now: 0,
      dt: 16,
      tickJump: false,
      lastColor: "",
      tx: new Float32Array(TRAIL_CAP),
      ty: new Float32Array(TRAIL_CAP),
    };
  }

  // ---- lifecycle (called by the host wrapper) ----  [VehicleFlowLayer.ts L247-286]
  mount(): void {
    this._canvas = this._host.mountCanvas();
    const ctx = this._canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unsupported");
    this._ctx = ctx;
    this._reset();
    document.addEventListener("visibilitychange", this._onVis);
    if (!document.hidden) this._raf = requestAnimationFrame(this._loop);
  }

  unmount(): void {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    document.removeEventListener("visibilitychange", this._onVis);
    this._host.unmountCanvas();
  }

  // ---- host event entry points (called by the wrapper's getEvents) ----
  onViewReset = () => this._reset();
  onZoomStart = () => {
    this._zooming = true;
  };
  onZoomEnd = () => {
    this._zooming = false;
    this._reset();
  };
  onZoomThrottle = () => {
    if (!this._zooming) this._reset();
  };
  onAnimZoom = (center: LatLng, zoom: number) => {
    this._host.updateTransform(center, zoom, this._center, this._zoom, this._padding);
  };

  // ---- public data API ----  [VehicleFlowLayer.ts L303-333]
  setVisibility(showBuses: boolean, showSubway: boolean): void {
    this._showBuses = showBuses;
    this._showSubway = showSubway;
  }

  /** Inject the lazy route-shape cache so buses glide ALONG their route (Ant Farm v3). */
  setShapeSource(cache: RouteShapeCache): void {
    this._shapes = cache;
  }

  /** Enable/disable the ~20 s fading motion tail per moving unit. */
  setTrails(on: boolean): void {
    if (this._trails === on) return;
    this._trails = on;
    if (!on) for (const u of this._units.values()) u.tN = 0; // clear buffers
    this._dirty = true;
  }

  /** Dim every unit the predicate rejects to 25 % and drop its trail; the kept units pop.
   *  Pass null to clear focus. */
  setFocus(pred: FocusPred | null): void {
    this._focus = pred;
    this._dirty = true;
  }

  /** Currently-displayed lat/lon of a unit (worm → its head), or null if gone. */
  getDisplayLatLng(id: string): [number, number] | null {
    const u = this._units.get(id);
    if (!u || u.goneT !== undefined) return null;
    return this._dispAnchor(u, performance.now());
  }

  private _recordPredErr(ft: number): void {
    if (!isFinite(ft) || ft < 0) return;
    this._perr[this._perrN % PRED_ERR_CAP] = ft;
    this._perrN++;
  }

  /** Ingest a bus snapshot. [VehicleFlowLayer.ts L347-450] */
  setBuses(vehicles: Vehicle[], selected: string, colorFor: ColorFor): void {
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

  /** Ingest a subway snapshot. [VehicleFlowLayer.ts L452-543] */
  setTrains(trains: SubwayTrain[]): void {
    const now = performance.now();
    const seen = new Set<string>();
    for (const t of trains) {
      const id = "t:" + t.feed + "|" + t.trip_id;
      seen.add(id);
      const color = subwayColor(t.route_id);
      const est = t.positional_basis === "interpolated";
      const atStation = t.status === "at_station";
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
      // inter-station worm geometry — glide the fraction along the SAME segment over the
      // nominal tick; snap (no interpolation) when the segment changes.
      if (hasSeg) {
        const stable = u.segKey === segKey && !!u.seg;
        // displayed fraction BEFORE we overwrite the timing (avoids a backward jump)
        const wf = u.curT > u.prevT ? Math.min(1, Math.max(0, (now - u.prevT) / (u.curT - u.prevT))) : 1;
        const dispFrac = (u.prevFrac ?? 0) + ((u.curFrac ?? 0) - (u.prevFrac ?? 0)) * wf;
        const { cum, len } = buildSegCum(t.seg!);
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
      fps: Math.round(60 / this._ladder.fpsDivisor),
      tickJump: this._ladder.tickJump,
      predErr: this._predErrStats(),
    };
  }

  /** Median + p90 of the accumulated between-tick prediction errors (ft), from the ring
   *  buffer. [VehicleFlowLayer.ts L557-563] */
  private _predErrStats(): { n: number; medianFt: number | null; p90Ft: number | null } {
    const n = Math.min(this._perrN, PRED_ERR_CAP);
    if (n === 0) return { n: 0, medianFt: null, p90Ft: null };
    const a = Array.from(this._perr.subarray(0, n)).sort((x, y) => x - y);
    const q = (p: number) => a[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
    return { n, medianFt: Math.round(q(0.5) * 10) / 10, p90Ft: Math.round(q(0.9) * 10) / 10 };
  }

  // ---- internals ----  [VehicleFlowLayer.ts L566-578]
  private _sweep(seen: Set<string>, kind: "bus" | "train", now: number): void {
    for (const [id, u] of this._units) {
      if (u.kind !== kind) continue;
      if (seen.has(id)) continue;
      u.missing++;
      if (u.missing >= STALE_TICKS && u.goneT === undefined) {
        u.goneT = now; // start the fade-out
        if (kind === "bus") trackBusOffline(1);
      }
      if (u.goneT !== undefined && now - u.goneT > FADE_MS) this._units.delete(id);
    }
  }

  private _onVis = () => {
    if (document.hidden) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    } else if (!this._raf) {
      this._raf = requestAnimationFrame(this._loop);
    }
  };

  private _reset = () => {
    this._update();
    this._host.updateTransform(this._center, this._zoom, this._center, this._zoom, this._padding);
    this._dirty = true;
  };

  private _update(): void {
    const p = this._padding;
    const size = this._host.getSize();
    const min = this._host.containerPointToLayerPoint(size.x * -p, size.y * -p);
    const wsx = Math.round(size.x * (1 + p * 2));
    const wsy = Math.round(size.y * (1 + p * 2));
    this._min = min;
    this._center = this._host.getCenter();
    this._zoom = this._host.getZoom();
    const dpr = (this._dpr = window.devicePixelRatio || 1);
    const c = this._canvas;
    c.width = Math.round(wsx * dpr);
    c.height = Math.round(wsy * dpr);
    c.style.width = wsx + "px";
    c.style.height = wsy + "px";
    this._host.setCanvasPosition(min.x, min.y);
  }

  private _loop = (ts: number) => {
    this._raf = requestAnimationFrame(this._loop);
    if (this._zooming) return; // CSS transform carries the canvas during zoom
    if (this._ladder.shouldSkipForPacing()) return;
    // tick-jump (last resort): the glide is off, so redraw only on data/view change
    if (this._ladder.tickJump && !this._dirty) return;
    const t0 = performance.now();
    this._draw(ts);
    this._dirty = false;
    const dt = performance.now() - t0;
    this._emaMs = this._emaMs === 0 ? dt : this._emaMs * 0.9 + dt * 0.1;
    this._ladder.maybeDegrade(this._emaMs, this._units.size, this._trails);
  };

  // Advance a shape-following bus's DISPLAYED offset (soDisp) one frame toward the decay-
  // predicted target. [VehicleFlowLayer.ts L724-742]
  private _advanceBusOffset(u: Unit, now: number): void {
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
    if (this._ladder.tickJump) {
      u.soDisp = target; // glide is off — jump to the model position
      return;
    }
    const tau = now < (u.soSnapUntil ?? 0) ? SNAP_TAU_MS : EASE_TAU_MS;
    const k = 1 - Math.exp(-this._fr.dt / tau);
    u.soDisp += (target - u.soDisp) * k;
  }

  // currently-displayed (interpolated) lat/lon of a unit at time `now` [L745-752]
  private _dispLL(u: Unit, now: number): [number, number] {
    let f = 1;
    if (u.curT > u.prevT) {
      f = (now - u.prevT) / (u.curT - u.prevT);
      f = f < 0 ? 0 : f > 1 ? 1 : f;
    }
    return [u.prevLat + (u.curLat - u.prevLat) * f, u.prevLon + (u.curLon - u.prevLon) * f];
  }

  // Displayed ANCHOR of a unit (worm head / bus offset / plain glide). [L757-772]
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

  // Append the current anchor to a unit's trail ring buffer, throttled. [L776-790]
  private _sampleTrail(u: Unit, now: number, lat: number, lon: number): void {
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

  // ---- the frame ----  [VehicleFlowLayer.ts L854-968]
  private _draw(now: number): void {
    const ctx = this._ctx;
    const dpr = this._dpr;
    const c = this._canvas;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width / dpr, c.height / dpr);
    this._hit.ensure(this._units.size);

    const zoom = this._host.getZoom();
    const size = this._host.getSize();
    const panePos = this._host.getMapPanePos();
    const midLat = this._host.getCenter().lat;
    const origin = this._host.getPixelOrigin();

    const fr = this._fr;
    fr.ctx = ctx;
    fr.zoom = zoom;
    fr.wpx = size.x;
    fr.hpx = size.y;
    fr.panex = panePos.x;
    fr.paney = panePos.y;
    fr.minx = this._min.x;
    fr.miny = this._min.y;
    fr.mpp = metersPerPixel(midLat, zoom);
    fr.outline = this._dark ? "rgba(10,12,16,0.85)" : "rgba(30,36,45,0.55)";
    fr.now = now;
    const rawDt = this._lastFrameT ? now - this._lastFrameT : 16;
    fr.dt = rawDt < 0 ? 0 : rawDt > 100 ? 100 : rawDt; // clamp (tab-switch / long frame)
    this._lastFrameT = now;
    fr.tickJump = this._ladder.tickJump;
    fr.lastColor = "";

    // projection constants for this zoom (see Projector.configure / project)
    this._pr.configure(zoom, origin.x, origin.y);

    const slab = zoom < SLAB_ZOOM;
    const speck = Math.max(1.6, MIN_LEN_PX * 0.8);
    const tick = this._ladder.tickJump;

    for (const u of this._units.values()) {
      if (u.kind === "bus" ? !this._showBuses : !this._showSubway) continue;

      // Ant Farm v3: advance a shape-following bus along its route.
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
      // F4 focus dim
      const bright = !this._focus || this._focus(u.kind, u.data.route_id ?? null);
      if (!bright) alpha *= 0.25;
      if (alpha <= 0.02) continue;

      // F4 motion trail: sample + draw the ~20 s fading tail (bright units only).
      if (this._trails && !this._ladder.trailsDropped && bright && u.goneT === undefined) {
        const anchor = this._dispAnchor(u, now);
        this._sampleTrail(u, now, anchor[0], anchor[1]);
        drawTrail(fr, u, alpha);
      }

      if (slab) {
        drawSpeck(fr, u, f, alpha, speck);
        continue;
      }

      if (u.kind === "train" && u.seg && u.segLen && u.segLen > 0) {
        drawTrainWorm(fr, u, f, alpha);
      } else if (u.kind === "train") {
        drawStationTrain(fr, u, alpha);
      } else {
        drawBus(fr, u, f, alpha);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- interaction ----  [VehicleFlowLayer.ts L1215-1250]
  onClick = (cx: number, cy: number, lat: number, lng: number): void => {
    const i = this._hit.pick(cx, cy);
    if (i < 0) return;
    const data = this._hit.dataAt(i);
    const kind = this._hit.kindAt(i);
    const sel: FlowSelection = selOf(data, kind);
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
    const popup = this._host.openPopup(lat, lng, html);
    if (canAct) {
      const el = popup.getElement();
      el?.querySelectorAll<HTMLButtonElement>(".flow-pop-btn").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const act = btn.getAttribute("data-flow");
          this._host.closePopup(popup);
          if (act === "follow") this._hooks.onFollow?.(sel);
          else if (act === "focus") this._hooks.onFocus?.(sel);
        });
      });
    }
  };

  onMouseMove = (cx: number, cy: number): void => {
    const over = this._hit.pick(cx, cy) >= 0;
    this._host.setCursor(over ? "pointer" : "");
  };
}
