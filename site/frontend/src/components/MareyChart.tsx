// MareyChart (S5) — THE signature Observatory view.
// A custom-canvas train graph (Étienne-Jules Marey / Ibry diagram): x = time,
// y = distance-along-route. Observed vehicle trajectories are drawn solid; the
// GTFS-scheduled trips sit faint behind them as "ghosts". Bunching (two buses
// converging) is visually obvious where trajectories touch. A live tail ticks
// forward from the SSE stream (with a 30s poll fallback). Everything is stamped
// honestly with an "as of" clock and the real observed/scheduled/live counts.
//
// Rendering strategy (per plan): a static offscreen buffer holds the grid, stop
// gridlines/labels, time axis, and scheduled ghosts (redrawn only on data/size/
// zoom change); each animation frame blits that buffer and redraws only the
// observed trajectories + live pulse + hover overlay via requestAnimationFrame.
// This keeps a busy route (40+ trips, 4k+ points) well under one frame budget.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getMarey,
  streamMarey,
  type MareyResponse,
  type MareyTrip,
} from "../lib/api";
import ArchiveBadge from "./ArchiveBadge";

interface Props {
  route: string; // route_id (may contain "+"); pass raw, api layer encodes it
  displayName: string; // e.g. "M15" or "M15-SBS"
  accent?: string;
}

const NYC_TZ = "America/New_York";
const fmtClock = (epoch: number | null | undefined) =>
  epoch
    ? new Date(epoch * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: NYC_TZ,
      })
    : "—";
const fmtHM = (epoch: number) =>
  new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: NYC_TZ,
  });

const WINDOWS: { key: string; label: string }[] = [
  { key: "3h", label: "Last 3h" },
  { key: "6h", label: "Last 6h" },
  { key: "today", label: "Today" },
];

const MARGIN = { top: 18, right: 14, bottom: 30, left: 60 };

interface Theme {
  fg: string;
  grid: string;
  stopLine: string;
  ghost: string;
  observed: string;
  live: string;
  axis: string;
  bg: string;
}
function themeFor(dark: boolean): Theme {
  return dark
    ? {
        fg: "#d5dae2",
        grid: "rgba(160,170,185,0.10)",
        stopLine: "rgba(160,170,185,0.16)",
        ghost: "rgba(148,163,184,0.42)",
        observed: "#60a5fa",
        live: "#f8fafc",
        axis: "rgba(160,170,185,0.35)",
        bg: "transparent",
      }
    : {
        fg: "#22272e",
        grid: "rgba(60,70,85,0.08)",
        stopLine: "rgba(60,70,85,0.14)",
        ghost: "rgba(100,116,139,0.40)",
        observed: "#2563eb",
        live: "#0b1f4d",
        axis: "rgba(60,70,85,0.30)",
        bg: "transparent",
      };
}

/** Merge SSE live points onto observed trips → the trips actually drawn. */
function mergeLive(
  observed: MareyTrip[],
  live: Map<string, { ts: number; offset_ft: number; vehicle_id: string }>,
): { trips: MareyTrip[]; heads: { trip_id: string; ts: number; off: number }[] } {
  if (live.size === 0)
    return { trips: observed, heads: observed.filter((t) => t.live && t.series.length).map((t) => ({ trip_id: t.trip_id, ts: t.series[t.series.length - 1][0], off: t.series[t.series.length - 1][1] })) };
  const byId = new Map(observed.map((t) => [t.trip_id, t]));
  const trips: MareyTrip[] = observed.map((t) => ({ ...t, series: t.series.slice() }));
  const tripsById = new Map(trips.map((t) => [t.trip_id, t]));
  const heads: { trip_id: string; ts: number; off: number }[] = [];
  for (const [trip_id, p] of live) {
    let t = tripsById.get(trip_id);
    if (!t) {
      if (byId.has(trip_id)) continue;
      t = { trip_id, live: true, series: [] };
      trips.push(t);
      tripsById.set(trip_id, t);
    }
    const last = t.series[t.series.length - 1];
    if (!last || last[0] < p.ts) t.series.push([p.ts, p.offset_ft]);
    t.live = true;
    heads.push({ trip_id, ts: p.ts, off: p.offset_ft });
  }
  // trips whose live head wasn't in the SSE frame but were already live
  for (const t of trips)
    if (t.live && !heads.some((h) => h.trip_id === t.trip_id) && t.series.length)
      heads.push({ trip_id: t.trip_id, ts: t.series[t.series.length - 1][0], off: t.series[t.series.length - 1][1] });
  return { trips, heads };
}

/** Detect visible convergence points between temporally-adjacent trips (bunching). */
function bunchingMarkers(trips: MareyTrip[], gapSec = 150): { ts: number; off: number }[] {
  const marks: { ts: number; off: number }[] = [];
  const sorted = trips.filter((t) => t.series.length > 1).sort((a, b) => a.series[0][0] - b.series[0][0]);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1].series;
    const b = sorted[i].series;
    // sample b's points, compare to a at same offset via nearest a point
    for (let k = 0; k < b.length; k += 2) {
      const [bt, bo] = b[k];
      // nearest a point in offset
      let best = Infinity;
      let bestTs = 0;
      for (const [at, ao] of a) {
        if (Math.abs(ao - bo) < 300) {
          const dt = Math.abs(at - bt);
          if (dt < best) {
            best = dt;
            bestTs = at;
          }
        }
      }
      if (best < gapSec) {
        marks.push({ ts: (bt + bestTs) / 2, off: bo });
        break; // one marker per adjacent pair is enough
      }
    }
  }
  return marks;
}

export default function MareyChart({ route, displayName, accent = "#2563eb" }: Props) {
  const [direction, setDirection] = useState(0);
  const [windowSel, setWindowSel] = useState("today");
  const [dateSel, setDateSel] = useState(""); // "" = today
  const [data, setData] = useState<MareyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "err">("loading");
  const [asOf, setAsOf] = useState<number | null>(null);
  const [perfMs, setPerfMs] = useState<number | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    trip: string;
    vehicle?: string;
    time: string;
    stop: string;
    delay: string;
  } | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 900, h: 460 });
  const liveRef = useRef<Map<string, { ts: number; offset_ft: number; vehicle_id: string }>>(new Map());
  const lastSseRef = useRef(0);
  const rafRef = useRef(0);
  const [dark, setDark] = useState(
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  // client-side brush-zoom window over the loaded time domain
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const brushRef = useRef<{ x0: number; x1: number } | null>(null);
  const [, forceTick] = useState(0);

  // -------- theme listener --------
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = () => setDark(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  // -------- responsive size --------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((ents) => {
      const cr = ents[0].contentRect;
      const h = Math.max(320, Math.min(560, Math.round(cr.width * 0.52)));
      setSize({ w: Math.round(cr.width), h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // -------- data fetch --------
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setZoom(null);
    liveRef.current.clear();
    getMarey(route, direction, windowSel, dateSel || undefined)
      .then((d) => {
        if (cancelled) return;
        if (d.error) {
          setStatus("err");
          setData(null);
          return;
        }
        setData(d);
        setAsOf(d.window_end_ts);
        setStatus("ok");
      })
      .catch(() => !cancelled && setStatus("err"));
    return () => {
      cancelled = true;
    };
  }, [route, direction, windowSel, dateSel]);

  // -------- live SSE + poll fallback --------
  const liveEnabled = !!data?.is_today;
  useEffect(() => {
    if (!liveEnabled) return;
    let stop = () => {};
    let pollTimer = 0;
    const start = () => {
      stop = streamMarey(
        route,
        direction,
        (frame) => {
          lastSseRef.current = Date.now();
          for (const p of frame.points)
            liveRef.current.set(p.trip_id, { ts: p.ts, offset_ft: p.offset_ft, vehicle_id: p.vehicle_id });
          if (frame.as_of) setAsOf(frame.as_of);
          forceTick((n) => n + 1);
        },
        () => {
          /* onError → poll fallback picks it up */
        },
      );
    };
    start();
    // Poll fallback: if no SSE frame in 35s, refetch the whole Marey window.
    pollTimer = window.setInterval(() => {
      if (Date.now() - lastSseRef.current < 35000) return;
      getMarey(route, direction, windowSel, dateSel || undefined)
        .then((d) => {
          if (!d.error) {
            setData(d);
            setAsOf(d.window_end_ts);
          }
        })
        .catch(() => {});
    }, 30000);
    return () => {
      stop();
      window.clearInterval(pollTimer);
    };
  }, [route, direction, windowSel, dateSel, liveEnabled]);

  // -------- scales --------
  const domain = useMemo(() => {
    if (!data) return null;
    const t0 = zoom ? zoom[0] : data.window_start_ts;
    const t1 = zoom ? zoom[1] : data.window_end_ts;
    const maxOff = data.shape_length_ft || Math.max(1, ...data.stops.map((s) => s.offset_ft));
    return { t0, t1, maxOff };
  }, [data, zoom]);

  const geom = useMemo(() => {
    const plotW = size.w - MARGIN.left - MARGIN.right;
    const plotH = size.h - MARGIN.top - MARGIN.bottom;
    return { plotW, plotH };
  }, [size]);

  const xForTs = useCallback(
    (ts: number) => {
      if (!domain) return MARGIN.left;
      const { t0, t1 } = domain;
      return MARGIN.left + ((ts - t0) / Math.max(1, t1 - t0)) * geom.plotW;
    },
    [domain, geom],
  );
  const yForOff = useCallback(
    (off: number) => {
      if (!domain) return MARGIN.top;
      return MARGIN.top + (off / Math.max(1, domain.maxOff)) * geom.plotH;
    },
    [domain, geom],
  );

  const theme = useMemo(() => themeFor(dark), [dark]);

  // -------- draw the static offscreen buffer (grid, stops, axis, ghosts) ------
  const drawBuffer = useCallback(() => {
    if (!data || !domain) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let buf = bufRef.current;
    if (!buf) {
      buf = document.createElement("canvas");
      bufRef.current = buf;
    }
    buf.width = Math.round(size.w * dpr);
    buf.height = Math.round(size.h * dpr);
    const ctx = buf.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    // stop gridlines + y labels (label a spaced subset to avoid crowding)
    const stops = data.stops;
    const labelEvery = Math.max(1, Math.ceil(stops.length / 12));
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (let i = 0; i < stops.length; i++) {
      const y = yForOff(stops[i].offset_ft);
      ctx.strokeStyle = theme.stopLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(size.w - MARGIN.right, y);
      ctx.stroke();
      if (i % labelEvery === 0 || i === stops.length - 1) {
        ctx.fillStyle = theme.fg;
        ctx.textAlign = "right";
        const nm = stops[i].name.length > 9 ? stops[i].name.slice(0, 8) + "…" : stops[i].name;
        ctx.fillText(nm, MARGIN.left - 5, y);
      }
    }

    // time axis (x) ticks + labels
    const { t0, t1 } = domain;
    const spanS = t1 - t0;
    const stepS = spanS <= 3 * 3600 ? 1800 : spanS <= 7 * 3600 ? 3600 : 7200;
    const first = Math.ceil(t0 / stepS) * stepS;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.fg;
    for (let t = first; t <= t1; t += stepS) {
      const x = xForTs(t);
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(x, MARGIN.top);
      ctx.lineTo(x, size.h - MARGIN.bottom);
      ctx.stroke();
      ctx.fillText(fmtHM(t), x, size.h - MARGIN.bottom + 6);
    }
    // axis frame
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN.left, MARGIN.top, geom.plotW, geom.plotH);

    // scheduled ghost trajectories
    ctx.strokeStyle = theme.ghost;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const t of data.scheduled) {
      const s = t.series;
      if (s.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < s.length; i++) {
        const x = xForTs(s[i][0]);
        const y = yForOff(s[i][1]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }, [data, domain, size, theme, xForTs, yForOff, geom]);

  // -------- per-frame draw (blit buffer + observed + live + hover) -----------
  const render = useCallback(() => {
    const cvs = canvasRef.current;
    const buf = bufRef.current;
    if (!cvs || !buf || !data || !domain) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cvs.width !== Math.round(size.w * dpr)) {
      cvs.width = Math.round(size.w * dpr);
      cvs.height = Math.round(size.h * dpr);
    }
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const t0perf = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    ctx.drawImage(buf, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // clip to plot area so trajectories don't bleed over the axis gutters
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, MARGIN.top, geom.plotW, geom.plotH);
    ctx.clip();

    const { trips, heads } = mergeLive(data.observed, liveRef.current);

    // observed trajectories
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    for (const t of trips) {
      const s = t.series;
      if (s.length < 2) continue;
      ctx.strokeStyle = t.live ? theme.live : theme.observed;
      ctx.globalAlpha = t.live ? 1 : 0.9;
      ctx.beginPath();
      for (let i = 0; i < s.length; i++) {
        const x = xForTs(s[i][0]);
        const y = yForOff(s[i][1]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // bunching convergence markers
    const bunches = bunchingMarkers(trips);
    ctx.fillStyle = dark ? "rgba(248,113,113,0.9)" : "rgba(220,38,38,0.85)";
    for (const b of bunches) {
      const x = xForTs(b.ts);
      const y = yForOff(b.off);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // live pulse heads
    const phase = (Math.sin(performance.now() / 350) + 1) / 2; // 0..1
    for (const h of heads) {
      const x = xForTs(h.ts);
      const y = yForOff(h.off);
      ctx.beginPath();
      ctx.arc(x, y, 3 + phase * 3, 0, Math.PI * 2);
      ctx.fillStyle = accent + "55";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }
    ctx.restore();

    // brush selection overlay
    if (brushRef.current) {
      const { x0, x1 } = brushRef.current;
      ctx.fillStyle = accent + "22";
      ctx.fillRect(Math.min(x0, x1), MARGIN.top, Math.abs(x1 - x0), geom.plotH);
      ctx.strokeStyle = accent;
      ctx.strokeRect(Math.min(x0, x1), MARGIN.top, Math.abs(x1 - x0), geom.plotH);
    }

    setPerfMs(Math.round((performance.now() - t0perf) * 10) / 10);
  }, [data, domain, size, theme, xForTs, yForOff, geom, dark, accent]);

  // buffer redraw on data/size/zoom/theme
  useEffect(() => {
    drawBuffer();
    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawBuffer]);

  // animation loop only when there is live data to tick
  useEffect(() => {
    if (!liveEnabled || status !== "ok") return;
    let running = true;
    const loop = () => {
      if (!running) return;
      if (!document.hidden) render();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [liveEnabled, status, render]);

  // -------- pointer interactions (hover tooltip + brush zoom) ----------------
  const onPointerMove = (e: React.PointerEvent) => {
    const cvs = canvasRef.current;
    if (!cvs || !data || !domain) return;
    const rect = cvs.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (brushRef.current) {
      brushRef.current.x1 = Math.max(MARGIN.left, Math.min(size.w - MARGIN.right, px));
      render();
      return;
    }
    // nearest observed point
    const { trips } = mergeLive(data.observed, liveRef.current);
    let best = 14; // px threshold
    let hit: { trip: MareyTrip; ts: number; off: number } | null = null;
    for (const t of trips)
      for (const [ts, off] of t.series) {
        const dx = xForTs(ts) - px;
        const dy = yForOff(off) - py;
        const d = Math.hypot(dx, dy);
        if (d < best) {
          best = d;
          hit = { trip: t, ts, off };
        }
      }
    if (!hit) {
      if (hover) setHover(null);
      return;
    }
    // nearest stop by offset
    let stopName = "—";
    let bestOff = Infinity;
    for (const s of data.stops) {
      const d = Math.abs(s.offset_ft - hit.off);
      if (d < bestOff) {
        bestOff = d;
        stopName = s.name;
      }
    }
    // delay vs nearest scheduled point (same offset band)
    let delay = "no ghost nearby";
    let bestSched = Infinity;
    let schedTs = 0;
    for (const t of data.scheduled)
      for (const [ts, off] of t.series)
        if (Math.abs(off - hit.off) < 400) {
          const d = Math.abs(ts - hit.ts);
          if (d < bestSched) {
            bestSched = d;
            schedTs = ts;
          }
        }
    if (bestSched < 3600) {
      const dmin = Math.round((hit.ts - schedTs) / 60);
      delay = dmin === 0 ? "on schedule" : dmin > 0 ? `${dmin} min behind ghost` : `${-dmin} min ahead of ghost`;
    }
    const vehicle = liveRef.current.get(hit.trip.trip_id)?.vehicle_id;
    setHover({
      x: px,
      y: py,
      trip: hit.trip.trip_id,
      vehicle,
      time: fmtClock(hit.ts),
      stop: stopName,
      delay,
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const rect = cvs.getBoundingClientRect();
    const px = Math.max(MARGIN.left, Math.min(size.w - MARGIN.right, e.clientX - rect.left));
    brushRef.current = { x0: px, x1: px };
    setHover(null);
  };
  const tsForX = (px: number) => {
    if (!domain) return 0;
    return domain.t0 + ((px - MARGIN.left) / Math.max(1, geom.plotW)) * (domain.t1 - domain.t0);
  };
  const onPointerUp = () => {
    const b = brushRef.current;
    brushRef.current = null;
    if (!b) return;
    if (Math.abs(b.x1 - b.x0) > 8) {
      const a = tsForX(Math.min(b.x0, b.x1));
      const c = tsForX(Math.max(b.x0, b.x1));
      setZoom([a, c]);
    } else {
      render();
    }
  };
  const resetZoom = () => setZoom(null);

  // -------- downloads --------
  const downloadPng = () => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const a = document.createElement("a");
    a.href = cvs.toDataURL("image/png");
    a.download = `marey_${displayName}_${data?.date ?? "today"}_dir${direction}.png`;
    a.click();
  };
  const downloadCsv = () => {
    if (!data) return;
    const rows: string[] = ["kind,trip_id,live,ts_utc,offset_ft"];
    const push = (kind: string, t: MareyTrip) => {
      for (const [ts, off] of t.series)
        rows.push(`${kind},${t.trip_id},${t.live ? 1 : 0},${new Date(ts * 1000).toISOString()},${off}`);
    };
    for (const t of data.observed) push("observed", t);
    for (const t of data.scheduled) push("scheduled", t);
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `marey_${displayName}_${data.date}_dir${direction}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="obs-marey">
      <div className="obs-marey-head">
        <div>
          <h2 style={{ margin: 0 }}>
            Marey diagram <span style={{ opacity: 0.6, fontWeight: 400 }}>· time × distance</span>
          </h2>
          <div className="obs-marey-legend">
            <span><i className="ln solid" style={{ background: accent }} /> observed</span>
            <span><i className="ln dash" /> scheduled (ghost)</span>
            <span><i className="dot live" style={{ background: accent }} /> live vehicle</span>
            <span><i className="dot bunch" /> bunching</span>
          </div>
        </div>
        <div className="obs-marey-dl">
          <button onClick={downloadPng} title="PNG snapshot of the current view">Download PNG</button>
          <button onClick={downloadCsv} title="All trajectory points as CSV">Download CSV</button>
        </div>
      </div>

      <div className="obs-controls">
        <div className="seg">
          <span className="seg-label">Direction</span>
          <button className={direction === 0 ? "on" : ""} onClick={() => setDirection(0)}>Outbound</button>
          <button className={direction === 1 ? "on" : ""} onClick={() => setDirection(1)}>Inbound</button>
        </div>
        <div className="seg">
          <span className="seg-label">Window</span>
          {WINDOWS.map((w) => (
            <button key={w.key} className={windowSel === w.key ? "on" : ""} onClick={() => setWindowSel(w.key)}>
              {w.label}
            </button>
          ))}
        </div>
        <div className="seg">
          <span className="seg-label">Date</span>
          <input
            type="date"
            value={dateSel}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDateSel(e.target.value)}
          />
          {dateSel && (
            <button onClick={() => setDateSel("")} title="Back to today">Today</button>
          )}
        </div>
        {zoom && (
          <button className="obs-zoom-reset" onClick={resetZoom}>Reset zoom ✕</button>
        )}
      </div>

      <div className="obs-marey-wrap" ref={wrapRef}>
        {status === "loading" && <div className="obs-marey-msg">Loading trajectories…</div>}
        {status === "err" && (
          <div className="obs-marey-msg">
            No trajectory data for {displayName} direction {direction === 0 ? "outbound" : "inbound"} in this
            window. Try the other direction, a wider window, or another date.
          </div>
        )}
        {status === "ok" && (
          <>
            <canvas
              ref={canvasRef}
              style={{ width: size.w, height: size.h, touchAction: "none" }}
              onPointerMove={onPointerMove}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerLeave={() => {
                setHover(null);
                if (brushRef.current) {
                  brushRef.current = null;
                  render();
                }
              }}
              onDoubleClick={resetZoom}
            />
            {hover && (
              <div
                className="obs-tip"
                style={{
                  left: Math.min(hover.x + 12, size.w - 190),
                  top: Math.max(6, hover.y - 10),
                }}
              >
                <strong>{hover.trip.length > 24 ? "…" + hover.trip.slice(-22) : hover.trip}</strong>
                <div>{hover.time} · near {hover.stop}</div>
                {hover.vehicle && <div>vehicle {hover.vehicle}</div>}
                <div className="d">{hover.delay}</div>
              </div>
            )}
          </>
        )}
      </div>

      {data && (
        <div className="obs-marey-foot">
          <span className={"nyc-asof-inline" + (data.is_today ? "" : " past")}>
            <span className="dot" /> as of {fmtClock(asOf)} {data.is_today ? "(live)" : `(${data.date})`}
          </span>
          <span className="obs-counts">
            {data.counts.observed_trips} observed · {data.counts.scheduled_trips} scheduled ·{" "}
            {data.counts.live_vehicles} live · {data.counts.stops} stops
          </span>
          {perfMs != null && <span className="obs-perf">frame {perfMs} ms</span>}
        </div>
      )}
      <ArchiveBadge archive={data?.archive} />
      <p className="nyc-note" style={{ fontSize: "0.78rem", marginTop: "0.4rem" }}>
        Drag left-to-right on the graph to zoom a time span; double-click to reset. Solid lines are observed
        vehicles; faint dashed lines are the GTFS schedule. Where two solid lines touch, buses are bunching.
        Times shown in America/New_York; offsets are feet along the canonical route shape.
      </p>
    </section>
  );
}
