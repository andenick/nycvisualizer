// nycviz-flow — pointer hit-testing (VERBATIM, zero-GC parallel arrays).
//
// Each drawn unit pushes a circle {cx, cy, r, kind, data} into parallel typed arrays
// (no per-frame object allocation). A click/hover picks the NEAREST unit whose circle
// contains the pointer, with an 8 px minimum pick radius. Extracted verbatim from
// VehicleFlowLayer.ts L200-205 / L834-852 / L1178-1213.

import type { Vehicle, SubwayTrain } from "../lib/api";
import { subwayLabel } from "../lib/subwayColors";
import type { FlowSelection } from "./types";

export class HitStore {
  private hx = new Float32Array(0);
  private hy = new Float32Array(0);
  private hr = new Float32Array(0);
  private hkind = new Uint8Array(0); // 0=bus 1=train
  private hdata: (Vehicle | SubwayTrain)[] = [];
  private hn = 0;

  /** Grow the parallel arrays to hold `n` hits and reset the write head.
   *  [VehicleFlowLayer.ts L834-843] */
  ensure(n: number): void {
    if (this.hx.length < n) {
      const cap = Math.max(n, this.hx.length * 2, 256);
      this.hx = new Float32Array(cap);
      this.hy = new Float32Array(cap);
      this.hr = new Float32Array(cap);
      this.hkind = new Uint8Array(cap);
    }
    this.hn = 0;
  }

  /** Register a pickable circle (container-space). [VehicleFlowLayer.ts L845-852] */
  push(cx: number, cy: number, r: number, kind: number, data: Vehicle | SubwayTrain): void {
    const i = this.hn++;
    this.hx[i] = cx;
    this.hy[i] = cy;
    this.hr[i] = r;
    this.hkind[i] = kind;
    this.hdata[i] = data;
  }

  /** Index of the nearest unit whose circle (≥8 px) contains (x, y), or -1.
   *  [VehicleFlowLayer.ts L1178-1192] */
  pick(x: number, y: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.hn; i++) {
      const dx = this.hx[i] - x,
        dy = this.hy[i] - y;
      const d = dx * dx + dy * dy;
      const rr = Math.max(8, this.hr[i]);
      if (d < rr * rr && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  kindAt(i: number): number {
    return this.hkind[i];
  }
  dataAt(i: number): Vehicle | SubwayTrain {
    return this.hdata[i];
  }
}

/** Build the FlowSelection for a picked unit. [VehicleFlowLayer.ts L1194-1213] */
export function selOf(data: Vehicle | SubwayTrain, kind: number): FlowSelection {
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
