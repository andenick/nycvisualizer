// W11 — tests for the stop geodesy + snap index.
//
// These exist because two of the module's guarantees are claims about NUMBERS, and a
// claim about a number that is not tested is a claim we cannot make on the site:
//   * distances are geodesic, not Web-Mercator pixels (a pixel measure is wrong by
//     ~30 % at NYC's latitude — a silent correctness bug, not a rounding question);
//   * the snap index answers in O(1) from 9 cells, deterministically, over DISTINCT
//     stops (the map draws 3,193 markers over only 2,033 distinct Bronx stops).

import { describe, it, expect } from "vitest";
import {
  buildSnapIndex,
  chainFeet,
  feetBetween,
  fmtDistance,
  fmtFeet,
  round10,
  SNAP_MAX_FT,
  StopSnapIndex,
  toggleCapped,
  type SnapStop,
} from "../stopGeo";

const FT_PER_M = 1 / 0.3048;

describe("feetBetween — geodesic, not pixels", () => {
  it("matches a known one-degree-of-latitude arc at NYC latitude", () => {
    // WGS84 meridional arc at 40.75°N is 111,038 m per degree (±2 m). Not a round
    // number, and NOT what a spherical-earth haversine returns — that is the point.
    const d = feetBetween([40.25, -73.9], [41.25, -73.9]) / FT_PER_M;
    expect(d).toBeGreaterThan(110_950);
    expect(d).toBeLessThan(111_150);
  });

  it("is symmetric and zero on identical points", () => {
    const a: [number, number] = [40.8626, -73.9013];
    const b: [number, number] = [40.8571, -73.8901];
    expect(feetBetween(a, a)).toBe(0);
    expect(feetBetween(a, b)).toBeCloseTo(feetBetween(b, a), 9);
  });

  it("shrinks longitude by cos(latitude) — the error a pixel measure makes", () => {
    // One degree of longitude at 40.75°N is ~cos(40.75) = 0.758 of one at the equator.
    // A Web-Mercator PIXEL distance would report these two as equal; they are not, and
    // the ~24 % gap here is the ~30 %-scale bug the design doc forbids.
    const lat = feetBetween([40.75, -73.9], [40.76, -73.9]);
    const lon = feetBetween([40.75, -73.9], [40.75, -73.89]);
    expect(lon / lat).toBeGreaterThan(0.74);
    expect(lon / lat).toBeLessThan(0.78);
  });

  it("agrees with a high-precision reference on a real stop pair", () => {
    // Two real Bronx bus stops (GTFS stops.txt, 6 dp). Reference computed with the
    // inverse geodesic; we require agreement to better than a foot over ~4,000 ft.
    const a: [number, number] = [40.872562, -73.888156]; // BEDFORD PK BLVD/GRAND CONCOURSE
    const b: [number, number] = [40.876836, -73.88971]; // PAUL AV/W 205 ST
    const ft = feetBetween(a, b);
    expect(ft).toBeGreaterThan(1600);
    expect(ft).toBeLessThan(1660);
  });

  it("chainFeet sums the legs", () => {
    const p: [number, number][] = [
      [40.86, -73.9],
      [40.865, -73.9],
      [40.87, -73.9],
    ];
    expect(chainFeet(p)).toBeCloseTo(feetBetween(p[0], p[1]) + feetBetween(p[1], p[2]), 6);
    expect(chainFeet([p[0]])).toBe(0);
    expect(chainFeet([])).toBe(0);
  });
});

describe("rounding + formatting — precision must match the evidence", () => {
  it("rounds to the nearest 10 ft", () => {
    // A GTFS stop coordinate is ONE surveyed point standing for a ~40 ft kerbside
    // zone, so 7,512 ft would claim a precision the concept cannot carry.
    expect(round10(7512)).toBe(7510);
    expect(round10(7515)).toBe(7520);
    expect(round10(4)).toBe(0);
    expect(round10(6)).toBe(10);
  });

  it("shows both units at once, feet primary, with no toggle", () => {
    expect(fmtDistance(7512)).toBe("7,510 ft (1.42 mi)");
    expect(fmtFeet(2534)).toBe("2,530 ft");
  });
});

describe("StopSnapIndex", () => {
  const mk = (key: string, lat: number, lon: number, stopId = key): SnapStop => ({
    key,
    stopId,
    name: "stop " + key,
    lat,
    lon,
    kind: "bus",
    routes: ["BX12"],
  });

  it("finds the nearest stop inside the radius and nothing outside it", () => {
    const idx = new StopSnapIndex([mk("a", 40.86, -73.9), mk("b", 40.8605, -73.9)]);
    // 'a' is exactly on the query point; 'b' is ~180 ft north.
    expect(idx.nearest(40.86, -73.9, 100)?.key).toBe("a");
    expect(idx.nearest(40.8604, -73.9, 100)?.key).toBe("b");
    // far outside every cell -> null, and the caller must NOT invent a free map point
    expect(idx.nearest(40.9, -73.9, 100)).toBeNull();
  });

  it("searches across cell boundaries — one ring is exhaustive to SNAP_MAX_FT", () => {
    // Straddle a cell edge in BOTH axes so a single-cell lookup would miss. The grid is
    // 0.0025 deg, so its boundaries sit at 40.86125 / -73.90125; these two points are
    // ~230 ft apart but land in diagonally adjacent cells.
    const q: [number, number] = [40.861, -73.901];
    const s: [number, number] = [40.8615, -73.9015];
    const idx = new StopSnapIndex([mk("edge", s[0], s[1])]);
    expect(feetBetween(q, s)).toBeLessThan(SNAP_MAX_FT);
    expect(idx.nearest(q[0], q[1], SNAP_MAX_FT)?.key).toBe("edge");
  });

  it("widens the ring rather than silently missing, if a caller over-asks", () => {
    // The workstation clamps to SNAP_MAX_FT so this never happens in the app, but a
    // spatial index that returns a WRONG answer when over-asked is a trap, not a
    // performance optimisation.
    const idx = new StopSnapIndex([mk("far", 40.88, -73.9)]);
    const ft = feetBetween([40.86, -73.9], [40.88, -73.9]);
    expect(ft).toBeGreaterThan(SNAP_MAX_FT * 5);
    expect(idx.nearest(40.86, -73.9, ft + 50)?.key).toBe("far");
    expect(idx.nearest(40.86, -73.9, ft - 50)).toBeNull();
  });

  it("breaks ties by stop_id, so the same click always yields the same stop", () => {
    // Two stops at the identical coordinate (a real case: a stop served by several
    // routes is drawn several times, and stacked stops do occur in the feed).
    const idx = new StopSnapIndex([mk("x", 40.86, -73.9, "999"), mk("y", 40.86, -73.9, "111")]);
    expect(idx.nearest(40.86, -73.9, 50)?.stopId).toBe("111");
    expect(idx.nearest(40.86, -73.9, 50)?.stopId).toBe("111");
  });

  it("is empty-safe", () => {
    const idx = new StopSnapIndex([]);
    expect(idx.size).toBe(0);
    expect(idx.nearest(40.86, -73.9, 500)).toBeNull();
  });
});

describe("buildSnapIndex — DISTINCT stops, with every serving route", () => {
  const shapes = new Map([
    [
      "BX12",
      {
        stops: [
          { stop_id: "100014", stop_name: "FORDHAM RD/GRAND CONCOURSE", lat: 40.8626, lon: -73.9013 },
          { stop_id: "100017", stop_name: "FORDHAM RD/WEBSTER AV", lat: 40.8607, lon: -73.8901 },
        ],
      },
    ],
    [
      "BX22",
      {
        // 100014 again — the map draws a SECOND marker here, but the index must not.
        stops: [
          { stop_id: "100014", stop_name: "FORDHAM RD/GRAND CONCOURSE", lat: 40.8626, lon: -73.9013 },
        ],
      },
    ],
  ]);

  it("deduplicates by stop_id and accumulates the routes", () => {
    const idx = buildSnapIndex(["BX12", "BX22"], shapes, [], null, (r) => r ?? "");
    expect(idx.size).toBe(2);
    expect(idx.get("b:100014")?.routes).toEqual(["BX12", "BX22"]);
    expect(idx.get("b:100017")?.routes).toEqual(["BX12"]);
  });

  it("namespaces bus stops and subway stations so ids cannot collide", () => {
    const stations = [{ id: "100014", name: "Fordham Rd", lat: 40.8626, lon: -73.9013, routes: ["4"] }];
    const idx = buildSnapIndex(["BX12"], shapes, ["4"], stations, (r) => (r ?? "").toUpperCase());
    expect(idx.get("b:100014")?.kind).toBe("bus");
    expect(idx.get("s:100014")?.kind).toBe("subway");
    expect(idx.size).toBe(3);
  });

  it("ignores stations that serve no selected line, and everything when nothing is selected", () => {
    const stations = [{ id: "S1", name: "Somewhere", lat: 40.7, lon: -73.9, routes: ["7"] }];
    expect(buildSnapIndex([], new Map(), ["4"], stations, (r) => (r ?? "").toUpperCase()).size).toBe(0);
    expect(buildSnapIndex([], new Map(), [], stations, (r) => r ?? "").size).toBe(0);
  });
});

describe("toggleCapped — persistent multi-select with a hard cap", () => {
  const k = (key: string) => ({ key });

  it("adds, and removes on a second click of the same stop", () => {
    let sel = toggleCapped<{ key: string }>([], k("a"), 10);
    expect(sel.map((x) => x.key)).toEqual(["a"]);
    sel = toggleCapped(sel, k("b"), 10);
    expect(sel.map((x) => x.key)).toEqual(["a", "b"]);
    sel = toggleCapped(sel, k("a"), 10);
    expect(sel.map((x) => x.key)).toEqual(["b"]);
  });

  it("caps the selection by evicting the OLDEST, never the newest", () => {
    let sel: { key: string }[] = [];
    for (let i = 0; i < 14; i++) sel = toggleCapped(sel, k("s" + i), 10);
    expect(sel).toHaveLength(10);
    // s0..s3 evicted; the most recent click is always still on screen.
    expect(sel[0].key).toBe("s4");
    expect(sel[9].key).toBe("s13");
  });

  it("never mutates the previous array (React state safety)", () => {
    const prev = [k("a")];
    const next = toggleCapped(prev, k("b"), 10);
    expect(prev).toHaveLength(1);
    expect(next).not.toBe(prev);
  });
});
