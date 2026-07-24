// nycviz-flow — pure-math regression tests.
//
// These lock the geometry + motion math that would SILENTLY corrupt the ant farm if it
// regressed: Web-Mercator projection, offset/shape walks (incl. edge cases), the decay-to-
// stop tween, the degrade ladder, and pointer hit-testing. All pure — no DOM, no browser.

import { describe, it, expect } from "vitest";
import type { Vehicle, SubwayTrain } from "../../lib/api";
import { Projector, metersBetween, metersPerPixel } from "../project";
import { pointAtDist, pointAtOffset, buildSegCum } from "../shapes";
import { decayDist, clampFps, isSbs } from "../core";
import { DegradeLadder } from "../ladder";
import { HitStore, selOf } from "../hittest";
import { DECAY_S, FRAME_BUDGET_MS } from "../constants";

describe("project — Web-Mercator meters-per-pixel", () => {
  it("matches the canonical z0 equator resolution", () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03392, 2);
  });
  it("halves for each zoom step", () => {
    const a = metersPerPixel(40.7128, 12);
    const b = metersPerPixel(40.7128, 13);
    expect(a / b).toBeCloseTo(2, 10);
  });
  it("shrinks with latitude (cos factor)", () => {
    expect(metersPerPixel(60, 12)).toBeLessThan(metersPerPixel(0, 12));
  });
});

describe("project — Projector.project (lat/lng ↔ pixel fixtures)", () => {
  it("puts (0,0) at the center of the z0 world (128,128)", () => {
    const pr = new Projector();
    pr.configure(0, 0, 0);
    pr.project(0, 0);
    expect(pr.plx).toBeCloseTo(128, 6);
    expect(pr.ply).toBeCloseTo(128, 6);
  });
  it("maps the antimeridian to the world edges at z0", () => {
    const pr = new Projector();
    pr.configure(0, 0, 0);
    pr.project(0, 180);
    expect(pr.plx).toBeCloseTo(256, 6);
    pr.project(0, -180);
    expect(pr.plx).toBeCloseTo(0, 6);
  });
  it("places +45° north above the equator (smaller y)", () => {
    const pr = new Projector();
    pr.configure(0, 0, 0);
    pr.project(45, 0);
    expect(pr.ply).toBeCloseTo(92.0896, 3);
    expect(pr.ply).toBeLessThan(128);
  });
  it("doubles the world scale at z1 and subtracts the pixel origin", () => {
    const pr = new Projector();
    pr.configure(1, 0, 0);
    pr.project(0, 0);
    expect(pr.plx).toBeCloseTo(256, 6); // center of the 512px z1 world
    const pr2 = new Projector();
    pr2.configure(1, 100, 40);
    pr2.project(0, 0);
    expect(pr2.plx).toBeCloseTo(156, 6); // 256 - originX
    expect(pr2.ply).toBeCloseTo(216, 6); // 256 - originY
  });
});

describe("project — metersBetween", () => {
  it("is ~111 m for 0.001° of latitude", () => {
    expect(metersBetween([40.7, -74.0], [40.701, -74.0])).toBeCloseTo(111.19, 0);
  });
  it("is zero for identical points", () => {
    expect(metersBetween([40, -74], [40, -74])).toBe(0);
  });
});

describe("shapes — pointAtDist (subway worm walk by meters)", () => {
  const pts: [number, number][] = [
    [0, 0],
    [0, 10],
    [0, 30],
  ];
  const cum = [0, 10, 30];
  it("interpolates within the first segment", () => {
    expect(pointAtDist(pts, cum, 5)).toEqual([0, 5]);
  });
  it("interpolates within a later segment", () => {
    expect(pointAtDist(pts, cum, 20)).toEqual([0, 20]);
  });
  it("clamps to the start below 0", () => {
    expect(pointAtDist(pts, cum, -3)).toEqual([0, 0]);
  });
  it("clamps to the end beyond total length", () => {
    expect(pointAtDist(pts, cum, 999)).toEqual([0, 30]);
  });
});

describe("shapes — pointAtOffset (bus route walk by feet) + edge cases", () => {
  const poly = { pts: [[40, -73] as [number, number], [40.001, -73] as [number, number]], cumFt: [0, 364], lenFt: 364 };
  it("interpolates the midpoint offset", () => {
    const p = pointAtOffset(poly, 182);
    expect(p[0]).toBeCloseTo(40.0005, 6);
  });
  it("clamps an offset beyond the shape end to the last vertex", () => {
    expect(pointAtOffset(poly, 100000)).toEqual([40.001, -73]);
  });
  it("clamps a negative offset to the first vertex", () => {
    expect(pointAtOffset(poly, -50)).toEqual([40, -73]);
  });
  it("handles a degenerate single-point shape", () => {
    const one = { pts: [[1, 2] as [number, number]], cumFt: [0], lenFt: 0 };
    expect(pointAtOffset(one, 5)).toEqual([1, 2]);
  });
});

describe("shapes — buildSegCum", () => {
  it("builds a monotonic cumulative array parallel to the segment", () => {
    const seg: [number, number][] = [
      [40.0, -74.0],
      [40.001, -74.0],
      [40.002, -74.0],
    ];
    const { cum, len } = buildSegCum(seg);
    expect(cum.length).toBe(seg.length);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeLessThan(cum[2]);
    expect(len).toBeCloseTo(cum[cum.length - 1], 6);
  });
  it("returns zero length for a degenerate segment", () => {
    const { cum, len } = buildSegCum([[40, -74], [40, -74]]);
    expect(len).toBe(0);
    expect(cum).toEqual([0, 0]);
  });
});

describe("motion — decayDist (honest ease-to-stop over DECAY_S)", () => {
  it("is zero at t=0", () => {
    expect(decayDist(10, 0)).toBe(0);
  });
  it("equals the triangular area (0.5·v·DECAY_S) at full decay", () => {
    expect(decayDist(10, DECAY_S)).toBeCloseTo(225, 6); // 0.5*10*45
  });
  it("caps monotonically once fully decayed (no motion past DECAY_S)", () => {
    expect(decayDist(10, 100)).toBe(decayDist(10, DECAY_S));
  });
  it("is zero for negative time", () => {
    expect(decayDist(10, -5)).toBe(0);
  });
  it("matches the closed form at the half point", () => {
    expect(decayDist(10, 22.5)).toBeCloseTo(168.75, 6);
  });
});

describe("motion — clampFps", () => {
  it("maps null/undefined/NaN/Infinity to 0", () => {
    expect(clampFps(null)).toBe(0);
    expect(clampFps(undefined)).toBe(0);
    expect(clampFps(NaN)).toBe(0);
    expect(clampFps(Infinity)).toBe(0);
  });
  it("floors negatives at 0 and caps at 90", () => {
    expect(clampFps(-5)).toBe(0);
    expect(clampFps(200)).toBe(90);
    expect(clampFps(30)).toBe(30);
  });
});

describe("motion — isSbs route sizing", () => {
  it("flags articulated/SBS/express route ids", () => {
    expect(isSbs("M15+")).toBe(true);
    expect(isSbs("SIM4")).toBe(true);
    expect(isSbs("BM1")).toBe(true);
    expect(isSbs("M15")).toBe(false);
    expect(isSbs(null)).toBe(false);
  });
});

describe("ladder — degrade state machine transitions", () => {
  it("starts at full quality (level 0)", () => {
    const l = new DegradeLadder();
    expect(l.level(true)).toBe(0);
    expect(l.tickJump).toBe(false);
  });
  it("sheds trails FIRST, then drops to 30 fps under sustained pressure", () => {
    const l = new DegradeLadder();
    const over = FRAME_BUDGET_MS + 1; // >budget, <2.4×budget
    l.maybeDegrade(over, 1000, true);
    expect(l.trailsDropped).toBe(true);
    expect(l.fpsDivisor).toBe(1);
    expect(l.level(true)).toBe(1);
    l.maybeDegrade(over, 1000, true);
    expect(l.fpsDivisor).toBe(2);
    expect(l.level(true)).toBe(2);
  });
  it("jumps straight to tick-jump on a severe frame (>2.4×budget)", () => {
    const l = new DegradeLadder();
    l.maybeDegrade(FRAME_BUDGET_MS * 2.4 + 1, 3000, true);
    expect(l.tickJump).toBe(true);
    expect(l.level(true)).toBe(3);
  });
  it("recovers one step at a time when the view is cheap again", () => {
    const l = new DegradeLadder();
    l.maybeDegrade(100, 3000, true); // → tick-jump
    expect(l.tickJump).toBe(true);
    l.maybeDegrade(FRAME_BUDGET_MS * 0.5 - 1, 100, true); // cheap → climb back
    expect(l.tickJump).toBe(false);
  });
  it("paces 30 fps by skipping alternate frames", () => {
    const l = new DegradeLadder();
    expect(l.shouldSkipForPacing()).toBe(false); // fpsDivisor 1 → never skip
    l.fpsDivisor = 2;
    expect(l.shouldSkipForPacing()).toBe(true);
    expect(l.shouldSkipForPacing()).toBe(false);
    expect(l.shouldSkipForPacing()).toBe(true);
  });
});

describe("hittest — nearest pick within radius", () => {
  const dA = { vehicle_id: "A" } as unknown as Vehicle;
  const dB = { vehicle_id: "B" } as unknown as Vehicle;
  it("picks the unit whose circle contains the pointer", () => {
    const h = new HitStore();
    h.ensure(2);
    h.push(100, 100, 10, 0, dA);
    h.push(140, 100, 10, 0, dB);
    expect(h.pick(103, 100)).toBe(0);
    expect(h.pick(138, 100)).toBe(1);
  });
  it("returns -1 when nothing is within the pick radius", () => {
    const h = new HitStore();
    h.ensure(1);
    h.push(100, 100, 10, 0, dA);
    expect(h.pick(500, 500)).toBe(-1);
  });
  it("enforces an 8px minimum pick radius", () => {
    const h = new HitStore();
    h.ensure(1);
    h.push(50, 50, 2, 0, dA); // r<8 → effective 8
    expect(h.pick(55, 50)).toBe(0); // dist 5 < 8
    expect(h.pick(60, 50)).toBe(-1); // dist 10 > 8
  });
  it("breaks ties toward the closer unit", () => {
    const h = new HitStore();
    h.ensure(2);
    h.push(100, 100, 20, 0, dA);
    h.push(110, 100, 20, 0, dB);
    expect(h.pick(109, 100)).toBe(1); // closest wins even though both contain it
  });
  it("resets the write head on ensure()", () => {
    const h = new HitStore();
    h.ensure(1);
    h.push(100, 100, 10, 0, dA);
    h.ensure(1); // clears
    expect(h.pick(100, 100)).toBe(-1);
  });
});

describe("hittest — selOf builds the FlowSelection", () => {
  it("describes a bus", () => {
    const v = { vehicle_id: "4821", route_id: "M15" } as unknown as Vehicle;
    expect(selOf(v, 0)).toEqual({ id: "b:4821", kind: "bus", routeId: "M15", label: "M15", sub: "bus 4821" });
  });
  it("describes a train (last-6 of the trip id, MTA label)", () => {
    const t = { feed: "1", trip_id: "abcdef123456", route_id: "L" } as unknown as SubwayTrain;
    expect(selOf(t, 1)).toEqual({ id: "t:1|abcdef123456", kind: "train", routeId: "L", label: "L", sub: "train 123456" });
  });
});
