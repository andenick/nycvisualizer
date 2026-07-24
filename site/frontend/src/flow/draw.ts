// nycviz-flow — canvas rendering (VERBATIM from VehicleFlowLayer.ts, re-homed).
//
// Pure drawing: given a per-frame DrawFrame (projector + ctx + hit store + frame-scoped
// viewport constants) and a Unit, paint its shape. Four shapes + the fading tail:
//   * drawSpeck        — city-zoom "veins": a moving fillRect speck   [L932-957]
//   * drawBus          — true-scale bearing-oriented rounded slab (+ dock pulse) [L971-1047]
//   * drawStationTrain — at-station ring / point-estimate bullet      [L1057-1102]
//   * drawTrainWorm    — ~160 m worm lying ALONG the track            [L1105-1175]
//   * drawTrail        — banded ~20 s fading motion tail              [L800-832]
// Every constant, cull margin, stroke width and theme rule is unchanged.

import type { DrawFrame, Unit } from "./types";
import { LABEL_ZOOM, MIN_LEN_PX, MIN_W_PX, TRAIN_LEN_M, TRAIN_W_M, TRAIL_CAP, TRAIL_MAX_ALPHA } from "./constants";
import { metersBetween } from "./project";
import { pointAtDist, pointAtOffset } from "./shapes";
import { DEG } from "./constants";

// Draw a unit's fading tail (oldest → newest, alpha ramps 0 → TRAIL_MAX_ALPHA). BANDED:
// the ramp is ≤3 contiguous strokes (not one per segment). [VehicleFlowLayer.ts L800-832]
export function drawTrail(fr: DrawFrame, u: Unit, alpha: number): void {
  const n = u.tN ?? 0;
  if (n < 2 || !u.tLat || !u.tLon) return;
  const ctx = fr.ctx;
  const cap = TRAIL_CAP;
  const start = n < cap ? 0 : u.tHead ?? 0;
  const minx = fr.minx,
    miny = fr.miny;
  const tx = fr.tx,
    ty = fr.ty;
  for (let k = 0; k < n; k++) {
    const idx = (start + k) % cap;
    fr.pr.project(u.tLat[idx], u.tLon[idx]);
    tx[k] = fr.pr.plx - minx;
    ty[k] = fr.pr.ply - miny;
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

// veins mode: a moving speck (fillRect is much cheaper than arc). Returns false when the
// unit is culled (so the caller `continue`s). [VehicleFlowLayer.ts L932-956]
export function drawSpeck(fr: DrawFrame, u: Unit, f: number, alpha: number, speck: number): void {
  const ctx = fr.ctx;
  const minx = fr.minx,
    miny = fr.miny,
    px = fr.panex,
    py = fr.paney,
    wpx = fr.wpx,
    hpx = fr.hpx;
  let lat: number, lon: number;
  if (u.kind === "bus" && u.offPoly && u.soDisp !== undefined) {
    const p = pointAtOffset(u.offPoly, u.soDisp); // shape-following even as a speck
    lat = p[0];
    lon = p[1];
  } else {
    lat = u.prevLat + (u.curLat - u.prevLat) * f;
    lon = u.prevLon + (u.curLon - u.prevLon) * f;
  }
  fr.pr.project(lat, lon);
  const x = fr.pr.plx - minx,
    y = fr.pr.ply - miny;
  const cx = fr.pr.plx + px,
    cy = fr.pr.ply + py;
  if (cx < -8 || cy < -8 || cx > wpx + 8 || cy > hpx + 8) return;
  ctx.globalAlpha = alpha;
  if (u.color !== fr.lastColor) {
    ctx.fillStyle = u.color;
    fr.lastColor = u.color;
  }
  ctx.fillRect(x - speck * 0.5, y - speck * 0.5, speck, speck);
  fr.hit.push(cx, cy, 6, u.kind === "bus" ? 0 : 1, u.data);
}

// a true-scale, bearing-oriented rounded slab (buses). [VehicleFlowLayer.ts L971-1047]
export function drawBus(fr: DrawFrame, u: Unit, f: number, alpha: number): void {
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
  fr.pr.project(lat, lon);
  const lx = fr.pr.plx,
    ly = fr.pr.ply;
  const x = lx - fr.minx,
    y = ly - fr.miny;
  const cx = lx + fr.panex,
    cy = ly + fr.paney;
  if (cx < -30 || cy < -30 || cx > fr.wpx + 30 || cy > fr.hpx + 30) return;
  fr.pr.project(blat, blon);
  const ang = Math.atan2(fr.pr.ply - ly, fr.pr.plx - lx);

  const ctx = fr.ctx;
  const mpp = fr.mpp;
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
    ctx.strokeStyle = fr.outline;
    ctx.stroke();
    if (fr.zoom >= 15) {
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
    const ph = (fr.now % 1600) / 1600; // 0..1 over ~1.6 s
    const rr = Math.max(lenPx, wPx) * 0.5 + 2 + ph * 6;
    ctx.globalAlpha = alpha * (1 - ph) * 0.45;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = u.color;
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }
  fr.hit.push(cx, cy, Math.max(8, lenPx / 2), 0, u.data);
}

// Subway train with no inter-station segment: at-station RING or point-estimate bullet.
// [VehicleFlowLayer.ts L1057-1102]
export function drawStationTrain(fr: DrawFrame, u: Unit, alpha: number): void {
  fr.pr.project(u.curLat, u.curLon);
  const x = fr.pr.plx - fr.minx,
    y = fr.pr.ply - fr.miny;
  const cx = fr.pr.plx + fr.panex,
    cy = fr.pr.ply + fr.paney;
  if (cx < -20 || cy < -20 || cx > fr.wpx + 20 || cy > fr.hpx + 20) return;
  const ctx = fr.ctx;
  ctx.globalAlpha = alpha;

  if (u.atStation) {
    // ring: radius slightly larger than the station disc (r≈2.5); constant px
    const rr = 4.5;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    // faint contrast underlay so the ring survives on light OR dark basemaps
    ctx.lineWidth = 3;
    ctx.strokeStyle = fr.outline;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = u.color;
    ctx.stroke();
    fr.hit.push(cx, cy, Math.max(9, rr + 3), 1, u.data);
    return;
  }

  const wPx = Math.max(MIN_W_PX + 0.6, TRAIN_W_M / fr.mpp);
  const r = Math.max(4, wPx * 1.15);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = u.color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = fr.outline;
  ctx.stroke();
  if (fr.zoom >= LABEL_ZOOM) {
    ctx.fillStyle = u.color.toUpperCase() === "#FCCC0A" ? "#111" : "#fff";
    ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(u.label, x, y + 0.5);
  }
  fr.hit.push(cx, cy, Math.max(8, r), 1, u.data);
}

// subway trains with a segment: a ~160 m worm lying ALONG the track.
// [VehicleFlowLayer.ts L1105-1175]
export function drawTrainWorm(fr: DrawFrame, u: Unit, f: number, alpha: number): void {
  const seg = u.seg!,
    cum = u.segCum!,
    segLen = u.segLen!;
  const frac = (u.prevFrac ?? 0) + ((u.curFrac ?? 0) - (u.prevFrac ?? 0)) * f;
  const center = frac * segLen;
  const mpp = fr.mpp;
  const lenPx = Math.max(MIN_LEN_PX, TRAIN_LEN_M / mpp);
  const halfM = (lenPx * mpp) / 2; // meters window matching the clamped px length
  const d0 = Math.max(0, center - halfM);
  const d1 = Math.min(segLen, center + halfM);
  const minx = fr.minx,
    miny = fr.miny;

  // cull on the worm centroid
  const cll = pointAtDist(seg, cum, center);
  fr.pr.project(cll[0], cll[1]);
  const ccx = fr.pr.plx + fr.panex,
    ccy = fr.pr.ply + fr.paney;
  if (ccx < -80 || ccy < -80 || ccx > fr.wpx + 80 || ccy > fr.hpx + 80) return;

  const ctx = fr.ctx;
  ctx.globalAlpha = alpha;

  // worm vertices in [d0,d1]: endpoints + interior shape points
  ctx.beginPath();
  const h0 = pointAtDist(seg, cum, d0);
  fr.pr.project(h0[0], h0[1]);
  ctx.moveTo(fr.pr.plx - minx, fr.pr.ply - miny);
  for (let i = 0; i < seg.length; i++) {
    if (cum[i] > d0 && cum[i] < d1) {
      fr.pr.project(seg[i][0], seg[i][1]);
      ctx.lineTo(fr.pr.plx - minx, fr.pr.ply - miny);
    }
  }
  const h1 = pointAtDist(seg, cum, d1);
  fr.pr.project(h1[0], h1[1]);
  const hx = fr.pr.plx - minx,
    hy = fr.pr.ply - miny;
  ctx.lineTo(hx, hy);

  const wPx = Math.max(MIN_W_PX + 0.6, TRAIN_W_M / mpp);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = fr.outline; // contrast underlay
  // straight-basis segments are a simple prev→next glide line (no real track
  // curvature) — draw a marginally thinner underlay so they read a touch simpler.
  ctx.lineWidth = wPx + (u.segBasis === "straight" ? 0.8 : 1.4);
  ctx.stroke();
  ctx.strokeStyle = u.color;
  ctx.lineWidth = wPx;
  ctx.stroke();

  // line bullet at the head (leading toward the target station)
  if (fr.zoom >= LABEL_ZOOM) {
    const br = Math.max(5.5, wPx * 1.15);
    ctx.beginPath();
    ctx.arc(hx, hy, br, 0, Math.PI * 2);
    ctx.fillStyle = u.color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = fr.outline;
    ctx.stroke();
    ctx.fillStyle = u.color.toUpperCase() === "#FCCC0A" ? "#111" : "#fff";
    ctx.font = `700 ${Math.round(br * 1.2)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(u.label, hx, hy + 0.5);
  }
  fr.hit.push(ccx, ccy, Math.max(8, wPx), 1, u.data);
}

// [VehicleFlowLayer.ts L1260-1276]
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
