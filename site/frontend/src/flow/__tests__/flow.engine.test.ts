// nycviz-flow — deterministic engine integration ("golden replay") test.
//
// Drives the REAL FlowEngine through a fake FlowHost + a recording canvas context on a
// simulated clock — the same "stubbed/replayed feed in, frames must match" trick the decay
// proof uses. It locks: (a) the draw-branch selection (speck vs slab vs ring vs worm), and
// (b) the motion honesty rules — glide easing, 45 s decay-to-STOP, and the >200 ft snap-
// correct — with zero browser and zero live data. No DOM: the handful of globals the engine
// touches (performance / rAF / document / window) are stubbed here.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Vehicle, SubwayTrain } from "../../lib/api";
import type { FlowHost, LatLng, PopupHandle, ScreenPoint } from "../types";
import { Projector } from "../project";
import { FlowEngine } from "../core";
import { RouteShapeCache } from "../../lib/shapeCache";

// -------------------------------------------------------------- simulated environment
let clock = 1000;
let pendingRaf: ((ts: number) => void) | null = null;

function installGlobals() {
  clock = 1000;
  pendingRaf = null;
  (globalThis as any).performance = { now: () => clock };
  (globalThis as any).requestAnimationFrame = (cb: (ts: number) => void) => {
    pendingRaf = cb;
    return 1;
  };
  (globalThis as any).cancelAnimationFrame = () => {
    pendingRaf = null;
  };
  (globalThis as any).document = {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as any).window = { devicePixelRatio: 1, matchMedia: undefined };
}

/** Run one animation frame at time `ts`. */
function frame(ts: number) {
  clock = ts;
  const cb = pendingRaf;
  if (cb) cb(ts);
}

// -------------------------------------------------------------- recording canvas ctx
class RecCtx {
  ops: string[] = [];
  // settable props the draw code assigns (ignored, but must exist)
  globalAlpha = 1;
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 0;
  lineCap = "";
  lineJoin = "";
  font = "";
  textAlign = "";
  textBaseline = "";
  private m(name: string) {
    this.ops.push(name);
  }
  setTransform() { this.m("setTransform"); }
  clearRect() { this.m("clearRect"); }
  save() { this.m("save"); }
  restore() { this.m("restore"); }
  translate() { this.m("translate"); }
  rotate() { this.m("rotate"); }
  beginPath() { this.m("beginPath"); }
  moveTo() { this.m("moveTo"); }
  lineTo() { this.m("lineTo"); }
  arc() { this.m("arc"); }
  arcTo() { this.m("arcTo"); }
  closePath() { this.m("closePath"); }
  fill() { this.m("fill"); }
  stroke() { this.m("stroke"); }
  fillRect() { this.m("fillRect"); }
  fillText() { this.m("fillText"); }
  count(op: string) {
    return this.ops.filter((o) => o === op).length;
  }
  clear() {
    this.ops = [];
  }
}

// -------------------------------------------------------------- fake host
const CENTER = { lat: 40.75, lng: -73.98 };
const SIZE = { x: 800, y: 600 };

class FakeHost implements FlowHost {
  zoom = 14;
  recCtx = new RecCtx();
  private canvas: any = { width: 0, height: 0, style: {}, getContext: () => this.recCtx };
  getContainer(): HTMLElement {
    return { style: {} } as unknown as HTMLElement;
  }
  mountCanvas(): HTMLCanvasElement {
    return this.canvas as HTMLCanvasElement;
  }
  unmountCanvas(): void {}
  isZoomAnimated(): boolean {
    return false;
  }
  getZoom(): number {
    return this.zoom;
  }
  getCenter(): LatLng {
    return { ...CENTER };
  }
  getSize(): ScreenPoint {
    return { ...SIZE };
  }
  // pixel origin chosen so the map center projects to the screen center (400,300)
  getPixelOrigin(): ScreenPoint {
    const pr = new Projector();
    pr.configure(this.zoom, 0, 0);
    pr.project(CENTER.lat, CENTER.lng);
    return { x: pr.plx - SIZE.x / 2, y: pr.ply - SIZE.y / 2 };
  }
  getMapPanePos(): ScreenPoint {
    return { x: 0, y: 0 };
  }
  containerPointToLayerPoint(x: number, y: number): ScreenPoint {
    return { x: Math.round(x), y: Math.round(y) };
  }
  setCanvasPosition(): void {}
  updateTransform(): void {}
  setCursor(): void {}
  openPopup(): PopupHandle {
    return { getElement: () => null };
  }
  closePopup(): void {}
}

const hooks = { busPopup: () => "<b>bus</b>", trainPopup: () => "<b>train</b>" };
const color = () => "#2b7cff";

function mkBus(id: string, lat: number, lon: number, extra: Partial<Vehicle> = {}): Vehicle {
  return {
    vehicle_id: id,
    route_id: "M15",
    trip_id: "t" + id,
    lat,
    lon,
    bearing: 90,
    timestamp: 0,
    stop_id: null,
    direction_id: 0,
    ...extra,
  } as Vehicle;
}

// straight east-west shape at the map latitude: 0.01° lon ≈ 2768 ft. offset↔lon is linear.
const SHAPE_LEN_FT = 2768;
function shapeCacheWith(shapeId: string, routeId: string): RouteShapeCache {
  const cache = new RouteShapeCache();
  const poly = {
    pts: [
      [40.75, -74.0] as [number, number],
      [40.75, -73.99] as [number, number],
    ],
    cumFt: [0, SHAPE_LEN_FT],
    lenFt: SHAPE_LEN_FT,
  };
  (cache as any)._put(shapeId, poly);
  (cache as any)._routeState.set(routeId, [shapeId]); // short-circuit ensure() → no fetch
  return cache;
}
/** displayed offset (ft) of a shape-following bus, recovered from its displayed lon. */
function offsetOf(engine: FlowEngine, id: string): number {
  const ll = engine.getDisplayLatLng(id)!;
  return ((ll[1] - -74.0) / 0.01) * SHAPE_LEN_FT;
}

let host: FakeHost;
let engine: FlowEngine;

beforeEach(() => {
  installGlobals();
  host = new FakeHost();
  engine = new FlowEngine(host, hooks);
  engine.mount(); // registers the first rAF (captured in pendingRaf)
});
afterEach(() => {
  engine.unmount();
});

describe("draw-branch selection (same feed, different zoom → different shapes)", () => {
  it("city zoom (<12) renders each bus as ONE fillRect speck, no slab", () => {
    host.zoom = 10;
    engine.setBuses([mkBus("1", 40.75, -73.98), mkBus("2", 40.751, -73.981), mkBus("3", 40.749, -73.979)], "", color);
    host.recCtx.clear();
    frame(1200); // alpha>0.02 (past appear ramp start)
    expect(host.recCtx.count("fillRect")).toBe(3);
    expect(host.recCtx.count("save")).toBe(0); // slabs (save/rotate) never used in veins mode
  });

  it("street zoom (14) renders each bus as a rounded slab (save+rotate+roundRect), no speck", () => {
    host.zoom = 14;
    engine.setBuses([mkBus("1", 40.75, -73.98), mkBus("2", 40.751, -73.981), mkBus("3", 40.749, -73.979)], "", color);
    host.recCtx.clear();
    frame(1200);
    expect(host.recCtx.count("save")).toBe(3);
    expect(host.recCtx.count("rotate")).toBe(3);
    expect(host.recCtx.count("arcTo")).toBe(12); // roundRect = 4 arcTo × 3 buses
    expect(host.recCtx.count("fillRect")).toBe(0);
  });

  it("an at-station train renders as a double-stroked ring (2 arcs)", () => {
    host.zoom = 14;
    const t = {
      trip_id: "L1", route_id: "L", feed: "1", lat: 40.75, lon: -73.98, status: "at_station",
      positional_basis: "station", stop_id: "s", stop_name: "S", prev_stop_name: null, timestamp: 0,
    } as unknown as SubwayTrain;
    engine.setTrains([t]);
    host.recCtx.clear();
    frame(1200);
    expect(host.recCtx.count("arc")).toBe(2);
    expect(host.recCtx.count("stroke")).toBe(2);
  });

  it("an interpolated train with a segment renders as a worm ALONG the track (+ bullet)", () => {
    host.zoom = 14;
    const t = {
      trip_id: "L2", route_id: "L", feed: "1", lat: 40.75, lon: -73.98, status: "in_transit",
      positional_basis: "interpolated", stop_id: "s", stop_name: "S", prev_stop_name: "P", timestamp: 0,
      seg: [[40.75, -73.985], [40.75, -73.975]], frac: 0.5, seg_basis: "shape",
    } as unknown as SubwayTrain;
    engine.setTrains([t]);
    host.recCtx.clear();
    frame(1200);
    expect(host.recCtx.count("moveTo")).toBe(1);
    expect(host.recCtx.count("lineTo")).toBe(1); // 2-point seg → endpoints only
    expect(host.recCtx.count("stroke")).toBe(3); // underlay + color worm + bullet
    expect(host.recCtx.count("arc")).toBe(1); // the head line-bullet
    expect(host.recCtx.count("fillText")).toBe(1); // the "L" label
  });
});

describe("motion honesty — glide easing", () => {
  it("glides linearly to the midpoint at half the tick interval", () => {
    engine.setBuses([mkBus("g", 40.75, -73.98)], "", color); // first sighting @ -73.98
    clock = 2000;
    engine.setBuses([mkBus("g", 40.75, -73.96)], "", color); // retarget toward -73.96 over 30 s
    clock = 2000 + 15000; // half of GLIDE_MS
    const ll = engine.getDisplayLatLng("b:g")!;
    expect(ll[1]).toBeCloseTo(-73.97, 4); // midpoint of -73.98 → -73.96
  });
});

describe("motion honesty — 45 s decay-to-STOP (no fabrication past DECAY_S)", () => {
  it("eases a stale shape-following bus to a full stop and holds it", () => {
    engine.setShapeSource(shapeCacheWith("S1", "R1"));
    engine.setBuses([mkBus("d", 40.75, -74.0, { shape_id: "S1", route_offset_ft: 0, speed_est_fps: 10 })], "", color);
    // no further reports: advance frames every 1 s out past DECAY_S (45 s)
    for (let t = 2000; t <= 91000; t += 1000) frame(t);
    const at60 = offsetOf(engine, "b:d");
    for (let t = 91000; t <= 121000; t += 1000) frame(t); // 30 s more
    const at90 = offsetOf(engine, "b:d");
    // decayDist(10, 45) = 0.5·10·45 = 225 ft is the honest terminal distance
    expect(at60).toBeGreaterThan(215);
    expect(at60).toBeLessThan(235);
    expect(at90).toBeCloseTo(at60, 1); // fully STOPPED — no creep past the decay window
  });
});

describe("motion honesty — >200 ft snap-correct closes fast (≤~1 s, never teleports)", () => {
  it("fast-eases a large fresh-report gap during the snap window", () => {
    engine.setShapeSource(shapeCacheWith("S2", "R2"));
    const t0 = 1000;
    engine.setBuses([mkBus("s", 40.75, -74.0, { shape_id: "S2", route_offset_ft: 0, speed_est_fps: 10 })], "", color);
    for (let t = 2000; t <= 31000; t += 1000) frame(t); // establish → soDisp eases toward ~200 ft
    const before = offsetOf(engine, "b:s");
    // in the decay regime, climbing toward the decayDist(10,·) terminal (~225 ft); the
    // discrete large-dt ease lags the moving target, so it sits below 200 at t=30 s.
    expect(before).toBeGreaterThan(150);
    expect(before).toBeLessThan(205);

    // fresh report 500 ft down-shape: |pred 200 − 500| = 300 > SNAP_FT(200) → snap window
    clock = t0 + 30000;
    engine.setBuses([mkBus("s", 40.75, -74.0, { shape_id: "S2", route_offset_ft: 500, speed_est_fps: 10 })], "", color);
    for (let t = 31200; t <= 32000; t += 200) frame(t); // ≤1 s of fast-ease frames
    const after = offsetOf(engine, "b:s");
    expect(after).toBeGreaterThan(450); // closed >250 ft of the 300 ft gap within ~1 s
    expect(after).toBeLessThanOrEqual(505); // eased in, never overshoots the report
  });
});
