// nycviz-flow — public types + the FlowHost interface (the ONLY host coupling seam).
//
// FlowHost is the ~1-file boundary between the host-agnostic engine (core/draw/project/
// shapes/hittest/ladder) and whatever map library mounts it. Every Leaflet call the old
// VehicleFlowLayer made is now expressed as a FlowHost method; a MapLibre host implements
// the same surface (see FLOW_ENGINE.md "future MapLibre host"). The engine never imports
// leaflet — only this interface.

import type { Vehicle, SubwayTrain } from "../lib/api";
import type { OffsetPoly } from "../lib/shapeCache";
import type { Projector } from "./project";
import type { HitStore } from "./hittest";

// ------------------------------------------------------------------ public API types
export type ColorFor = (routeId: string | null) => string;

/** What the client learns when a unit is clicked: enough to drive the follow pill and the
 *  focus predicate, with zero renderer knowledge of route/line taxonomy.
 *  [VehicleFlowLayer.ts L94-100] */
export interface FlowSelection {
  id: string;
  kind: "bus" | "train";
  routeId: string | null; // raw route id (bus route or subway route_id)
  label: string; // display label, e.g. "M15" or "L"
  sub: string; // secondary, e.g. "bus 4821" or "train …a1b2c3"
}

/** A focus predicate: returns true for units that should stay bright.
 *  [VehicleFlowLayer.ts L102] */
export type FocusPred = (kind: "bus" | "train", routeId: string | null) => boolean;

/** Popup + action hooks the host page supplies. [VehicleFlowLayer.ts L104-111] */
export interface FlowPopupHooks {
  busPopup: (v: Vehicle) => string;
  trainPopup: (t: SubwayTrain) => string;
  /** Fired when the popup "Follow" action is tapped (F4 follow mode). */
  onFollow?: (sel: FlowSelection) => void;
  /** Fired when the popup "Focus route/line" action is tapped (F4 focus dim). */
  onFocus?: (sel: FlowSelection) => void;
}

// ------------------------------------------------------------------ per-unit state
/** Per-unit animation state (plain object; fleet ≤ ~3k). [VehicleFlowLayer.ts L113-156] */
export interface Unit {
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
  offPoly?: OffsetPoly;
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

// ------------------------------------------------------------------ host seam
export interface ScreenPoint {
  x: number;
  y: number;
}
export interface LatLng {
  lat: number;
  lng: number;
}
/** Opaque handle to an open popup (so the engine can wire action buttons + close it). */
export interface PopupHandle {
  getElement(): HTMLElement | null | undefined;
}

/**
 * The host adapter contract — every map-library coupling the engine needs. Designed from
 * exactly what VehicleFlowLayer.ts used (L246-301, L603-639, L1215-1249). A host provides:
 *  - a canvas mounted in a dedicated pane above the station layer,
 *  - cheap per-frame viewport queries (zoom/center/size/pixelOrigin/panePos),
 *  - canvas placement + the zoom-animation transform,
 *  - pointer/popup/cursor plumbing, and event registration.
 */
export interface FlowHost {
  // --- DOM / mounting ---
  getContainer(): HTMLElement;
  /** Create the overlay <canvas> (host styling classes), mount it in the dedicated
   *  pane just above the station layer, and return it. */
  mountCanvas(): HTMLCanvasElement;
  unmountCanvas(): void;
  /** True if the host animates zoom (engine mirrors the transform through the animation). */
  isZoomAnimated(): boolean;

  // --- per-frame viewport queries (cheap, alloc-light) ---
  getZoom(): number;
  getCenter(): LatLng;
  getSize(): ScreenPoint;
  getPixelOrigin(): ScreenPoint;
  getMapPanePos(): ScreenPoint;
  /** Container point (x, y) → rounded layer point (for canvas sizing/positioning). */
  containerPointToLayerPoint(x: number, y: number): ScreenPoint;

  // --- canvas placement ---
  setCanvasPosition(x: number, y: number): void;
  /** Apply the zoom-animation transform (mirror of L.Renderer._updateTransform). */
  updateTransform(
    targetCenter: LatLng,
    targetZoom: number,
    curCenter: LatLng,
    curZoom: number,
    padding: number,
  ): void;

  // --- interaction ---
  setCursor(cursor: string): void;
  openPopup(lat: number, lng: number, html: string): PopupHandle;
  closePopup(h: PopupHandle): void;
}

// ------------------------------------------------------------------ draw frame context
/** Frame-scoped rendering context (the old `_f*` instance fields, grouped). One reusable
 *  instance is mutated per frame — no per-frame allocation. */
export interface DrawFrame {
  ctx: CanvasRenderingContext2D;
  pr: Projector;
  hit: HitStore;
  minx: number;
  miny: number;
  panex: number;
  paney: number;
  wpx: number;
  hpx: number;
  mpp: number;
  zoom: number;
  outline: string;
  now: number;
  dt: number;
  tickJump: boolean;
  // per-frame fillStyle-set dedupe for the speck loop (reset to "" each frame) [L898]
  lastColor: string;
  // reusable scratch for projected trail vertices (no per-unit allocation)
  tx: Float32Array;
  ty: Float32Array;
}
