import { useEffect, useRef } from "react";

// Tiny canvas sparkline for the Ops Wall: draws the trailing-3h parquet series as a
// line + soft area, breaking the line across null gaps. If `liveValue` is given it is
// drawn beyond a dashed "splice" marker as a distinct pulsing-color dot — the honest
// boundary between the hourly parquet rollup and the live NOW computation. The two are
// never connected by a solid line (they are computed differently).
export default function OpsSparkline({
  values,
  color,
  liveValue = null,
  height = 40,
  invert = false,
}: {
  values: (number | null)[];
  color: string;
  liveValue?: number | null;
  height?: number;
  invert?: boolean; // when true, lower is better (headway dev / bunching) — no effect on draw, kept for intent
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 160;
    const h = height;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
    const all = liveValue != null ? [...nums, liveValue] : nums;
    if (all.length === 0) return;
    let min = Math.min(...all);
    let max = Math.max(...all);
    if (max - min < 1e-9) {
      max += 1;
      min -= 1;
    }
    const pad = 3;
    const n = values.length;
    const spliceX = w * 0.82; // parquet occupies ~left 82%, live tail the rest
    const plotW = liveValue != null ? spliceX : w;
    const x = (i: number) => pad + (plotW - 2 * pad) * (n <= 1 ? 0.5 : i / (n - 1));
    const y = (v: number) => h - pad - (h - 2 * pad) * ((v - min) / (max - min));

    // area + line, breaking on nulls
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = color;
    let started = false;
    let firstX = 0;
    let lastX = 0;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) {
        started = false;
        continue;
      }
      const px = x(i);
      const py = y(v);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
        if (firstX === 0) firstX = px;
      } else {
        ctx.lineTo(px, py);
      }
      lastX = px;
    }
    ctx.stroke();

    // soft area under the last continuous run
    ctx.lineTo(lastX, h - pad);
    ctx.lineTo(firstX, h - pad);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (liveValue != null && Number.isFinite(liveValue)) {
      // dashed splice divider
      ctx.save();
      ctx.strokeStyle = "rgba(148,163,184,0.5)";
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(spliceX, pad);
      ctx.lineTo(spliceX, h - pad);
      ctx.stroke();
      ctx.restore();
      // live dot
      const lx = w - pad - 2;
      const ly = y(liveValue);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [values, color, liveValue, height, invert]);

  return <canvas className="ops-spark" ref={ref} style={{ width: "100%", height }} aria-hidden />;
}
