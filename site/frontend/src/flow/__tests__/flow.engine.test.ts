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

// A stable simulated wall clock (epoch ms) that advances 1:1 with the perf `clock`, so the
// per-vehicle report-time anchoring guard (Date.now() vs report epoch) is deterministic.
// Report `timestamp`s are epoch SECONDS: WALL_BASE/1000 + (clock−1000)/1000 − ageSec.
const WALL_BASE = 1_700_000_000_000; // ms
function wallNow() {
  return WALL_BASE + (clock - 1000);
}
/** epoch-seconds timestamp for a report made `ageSec` before the current sim wall clock. */
function tsSec(ageSec: number) {
  return (wallNow() - ageSec * 1000) / 1000;
}

function installGlobals() {
  clock = 1000;
  pendingRaf = null;
  (globalThis as any).performance = { now: () => clock };
  (globalThis as any).Date = { now: () => wallNow() };
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

describe("motion honesty — hold-last-speed then decay-to-STOP (no fabrication past STALE_S+DECAY_S)", () => {
  // UPDATED for the 2026-07-24 study fix: a stale bus now HOLDS its last speed (unbiased) for
  // STALE_S=40 s, THEN decays to a stop over DECAY_S=45 s. Terminal offset = 10·40 + 0.5·10·45
  // = 625 ft, reached at t≈85 s (was the old "decay from t=0" terminal of 225 ft). timestamp:0
  // (1970) trips the 5-min staleness guard → poll-time anchor, so soReportT = the report frame.
  it("holds speed to STALE_S, eases to a full stop by STALE_S+DECAY_S, and holds it", () => {
    engine.setShapeSource(shapeCacheWith("S1", "R1"));
    engine.setBuses([mkBus("d", 40.75, -74.0, { shape_id: "S1", route_offset_ft: 0, speed_est_fps: 10 })], "", color);
    // no further reports: advance frames well past STALE_S+DECAY_S (85 s) so the discrete ease
    // has fully settled onto the honest terminal
    for (let t = 2000; t <= 150000; t += 1000) frame(t);
    const atStop = offsetOf(engine, "b:d");
    for (let t = 151000; t <= 181000; t += 1000) frame(t); // 30 s more
    const after = offsetOf(engine, "b:d");
    expect(atStop).toBeGreaterThan(615); // ≈625 ft honest terminal (10·40 + 225)
    expect(atStop).toBeLessThan(635);
    expect(after).toBeCloseTo(atStop, 1); // fully STOPPED — no creep past STALE_S+DECAY_S
  });

  it("advances UNBIASED (no early decay) through a normal ~31 s tick", () => {
    engine.setShapeSource(shapeCacheWith("S1b", "R1b"));
    engine.setBuses([mkBus("h", 40.75, -74.0, { shape_id: "S1b", route_offset_ft: 0, speed_est_fps: 10 })], "", color);
    for (let t = 2000; t <= 32000; t += 1000) frame(t); // out to ~31 s since the report
    const at31 = offsetOf(engine, "b:h");
    // model target is 310 ft (10·31, hold-last-speed); the discrete 1-frame/s test ease sits a
    // fixed ~50 ft behind a ramping target → ~260 ft here. The OLD decay-from-0 model's target
    // was only 203 ft (eased ~160) — so ~260 proves we're firmly on the unbiased side.
    expect(at31).toBeGreaterThan(245);
    expect(at31).toBeLessThan(275);
  });
});

describe("motion honesty — >200 ft snap-correct closes fast (≤~1 s, never teleports)", () => {
  it("fast-eases a large fresh-report gap during the snap window", () => {
    engine.setShapeSource(shapeCacheWith("S2", "R2"));
    const t0 = 1000;
    engine.setBuses([mkBus("s", 40.75, -74.0, { shape_id: "S2", route_offset_ft: 0, speed_est_fps: 10 })], "", color);
    for (let t = 2000; t <= 31000; t += 1000) frame(t); // establish → soDisp holds toward ~300 ft
    const before = offsetOf(engine, "b:s");
    // UPDATED for hold-last-speed: the model target within the ~30 s tick is 10·30 = 300 ft (no
    // early decay); the discrete 1-frame/s test ease trails a ramp by a fixed ~50 ft → ~250 ft
    // (the OLD decay model's target here was only ~200 ft, eased lower still).
    expect(before).toBeGreaterThan(235);
    expect(before).toBeLessThan(270);

    // fresh report 600 ft down-shape: pred = advanceDist(10,30) = 300; |300 − 600| = 300 >
    // SNAP_FT(200) → snap window. (Offset bumped 500→600 so the gap still clears SNAP_FT under
    // the now-larger, unbiased prediction.)
    clock = t0 + 30000;
    engine.setBuses([mkBus("s", 40.75, -74.0, { shape_id: "S2", route_offset_ft: 600, speed_est_fps: 10 })], "", color);
    for (let t = 31200; t <= 32000; t += 200) frame(t); // ≤1 s of fast-ease frames
    const after = offsetOf(engine, "b:s");
    expect(after).toBeGreaterThan(550); // closed >250 ft of the 300 ft gap within ~1 s
    expect(after).toBeLessThanOrEqual(605); // eased in, never overshoots the report
  });
});

describe("per-vehicle report-time anchoring (kills the synchronized poll pulse)", () => {
  /** two identical buses reported in the SAME batch but 10 s apart on their OWN timestamps:
   *  the older report must dead-reckon 10 s further (≈100 ft at 10 fps) — proving each unit
   *  is anchored to its own report time, so their corrections absorb at different sim-times
   *  instead of all jumping on the shared poll instant. */
  it("staggers two same-batch buses by their own timestamps (older report → further along)", () => {
    engine.setShapeSource(shapeCacheWith("SG", "RG"));
    const mk = (id: string, ageSec: number) =>
      mkBus(id, 40.75, -74.0, {
        route_id: "RG",
        shape_id: "SG",
        route_offset_ft: 0,
        speed_est_fps: 10,
        timestamp: tsSec(ageSec),
      });
    // batch newest = the fresh bus (age 0); the other's report is 10 s older
    engine.setBuses([mk("fresh", 0), mk("old10", 10)], "", color);
    for (let t = 2000; t <= 20000; t += 1000) frame(t); // both still in the hold regime (<40 s)
    const fresh = offsetOf(engine, "b:fresh");
    const old10 = offsetOf(engine, "b:old10");
    expect(old10).toBeGreaterThan(fresh); // older report is dead-reckoned further
    expect(old10 - fresh).toBeGreaterThan(80); // ≈ 10 s · 10 fps = 100 ft of stagger
    expect(old10 - fresh).toBeLessThan(120);
  });

  /** explicit stale-decay boundary at the engine level: displayed advance is ~constant through
   *  STALE_S, then bends toward the stop — the last-second delta before the boundary is a full
   *  hold step, the one well after it is smaller. */
  it("advances ~constant up to STALE_S=40 s, then decays afterwards", () => {
    engine.setShapeSource(shapeCacheWith("SB", "RB"));
    engine.setBuses(
      [mkBus("b40", 40.75, -74.0, { route_id: "RB", shape_id: "SB", route_offset_ft: 0, speed_est_fps: 10 })],
      "",
      color,
    );
    for (let t = 2000; t <= 39000; t += 1000) frame(t);
    const at38 = offsetOf(engine, "b:b40");
    frame(40000); // cross into t≈39 s → still holding
    const at39 = offsetOf(engine, "b:b40");
    const holdStep = at39 - at38; // ~10 ft (a full 1 s hold step)
    for (let t = 41000; t <= 70000; t += 1000) frame(t); // out past STALE_S into the decay band
    const at69 = offsetOf(engine, "b:b40");
    frame(71000);
    const at70 = offsetOf(engine, "b:b40");
    const decayStep = at70 - at69; // shrinking as it eases to a stop
    expect(holdStep).toBeGreaterThan(8); // full-speed hold near the boundary (~10 ft/s)
    expect(decayStep).toBeLessThan(holdStep); // motion is slowing after STALE_S
    // model target at 39 s is 390 ft (held, unbiased); discrete-ease display ~340 ft — well
    // above the OLD decay model's ~203 ft target, confirming no early decay before STALE_S.
    expect(at39).toBeGreaterThan(320);
    expect(at39).toBeLessThan(360);
  });

  /** a bad report timestamp (far future / null / >5 min stale) must NOT corrupt the clock and
   *  must fall back to the poll-time anchor — counted in getStats().anchorFallbacks. */
  it("falls back to poll-time for future / null / stale timestamps (and counts them)", () => {
    engine.setShapeSource(shapeCacheWith("SX", "RX"));
    const mk = (id: string, ts: number | null) =>
      mkBus(id, 40.75, -74.0, { route_id: "RX", shape_id: "SX", route_offset_ft: 0, speed_est_fps: 10, timestamp: ts });
    engine.setBuses(
      [
        mk("good", tsSec(5)), // valid → anchored, no fallback
        mk("future", tsSec(-3600)), // 1 h in the future → guard → fallback
        mk("null", null), // absent → fallback
        mk("stale", tsSec(600)), // 10 min old → guard → fallback
      ],
      "",
      color,
    );
    expect(engine.getStats().anchorFallbacks).toBe(3); // future + null + stale, NOT good
  });

  /** the engine DEAD-RECKONS on the backend's segment-median speed_est_fps prior, NOT the raw
   *  observed last-leg advance: on the live RAW route_offset_ft feed the observed speed
   *  amplifies GPS/map-match jitter and measured WORSE (median 199 ft, p90 598) than the smooth
   *  segment prior (median 188 ft, p90 420) — the study's "observed beats segment" held only on
   *  its SMOOTHED derived trajectories (fair live 4-model comparison, 2026-07-24). Here a NOISY
   *  observed jump (20 fps) must NOT change the dead-reckoning speed away from the 12 fps prior. */
  it("dead-reckons on the segment speed_est_fps prior, not a noisy observed last-leg jump", () => {
    engine.setShapeSource(shapeCacheWith("SO", "RO"));
    const mk = (off: number) =>
      mkBus("obs", 40.75, -74.0, { route_id: "RO", shape_id: "SO", route_offset_ft: off, speed_est_fps: 12 });
    clock = 1000;
    engine.setBuses([mk(0)], "", color); // first sighting: soSpeed ← prior 12 fps
    clock = 31000;
    engine.setBuses([mk(600)], "", color); // noisy +600 ft (observed 20 fps) — must NOT become soSpeed
    for (let t = 32000; t <= 61000; t += 1000) frame(t); // 30 s of pure dead-reckoning
    const off = offsetOf(engine, "b:obs");
    // segment prior (12 fps): target 600 + advanceDist(12,30) = 960 (ease-lagged ~910).
    // observed (20 fps) would be 600 + 600 = 1200 — excluded by the upper bound.
    expect(off).toBeGreaterThan(830);
    expect(off).toBeLessThan(1010);
  });
});
