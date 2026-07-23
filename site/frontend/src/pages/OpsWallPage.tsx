import { useEffect, useRef, useState } from "react";
import { getWall, streamWall, type WallResponse, type WallTrailBin } from "../lib/api";
import OpsSparkline from "../components/OpsSparkline";
import OpsHotspotMap from "../components/OpsHotspotMap";
import MapLegend, { Swatch } from "../components/MapLegend";
import ConfidenceBadge from "../components/ConfidenceBadge";
import { archiveWindow } from "../lib/confidence";

function fmtClock(epoch: number | null | undefined): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDev(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function series(bins: WallTrailBin[], key: keyof WallTrailBin): (number | null)[] {
  return bins.map((b) => (b[key] as number | null) ?? null);
}

// A small honest "as of" chip used per panel.
function Stamp({ label, epoch, stale }: { label: string; epoch: number | null | undefined; stale?: boolean }) {
  return (
    <span className={"ops-stamp" + (stale ? " stale" : "")}>
      <span className="dot" />
      {label} {fmtClock(epoch)}
    </span>
  );
}

export default function OpsWallPage() {
  const [data, setData] = useState<WallResponse | null>(null);
  const [ticks, setTicks] = useState(0);
  const [conn, setConn] = useState<"sse" | "poll" | "connecting">("connecting");
  const [err, setErr] = useState<string | null>(null);
  const lastUpdate = useRef<number>(0);

  // Force a dark control-room theme for THIS page only. We stamp data-ops-theme on
  // <html> so the page-local dark tokens win; the site's own light/dark toggle still
  // renders correctly if the visitor flips it (the CSS honors both).
  useEffect(() => {
    document.documentElement.setAttribute("data-ops-theme", "dark");
    return () => document.documentElement.removeAttribute("data-ops-theme");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apply = (d: WallResponse, via: "sse" | "poll") => {
      if (cancelled) return;
      lastUpdate.current = Date.now();
      setData(d);
      setErr(null);
      setConn(via);
      setTicks((t) => t + 1);
    };
    // initial pull
    getWall()
      .then((d) => apply(d, "poll"))
      .catch(() => !cancelled && setErr("Ops feed unavailable."));
    // SSE
    const unsub = streamWall(
      (d) => apply(d, "sse"),
      () => !cancelled && setConn("poll"),
    );
    // poll safety net — also covers the case where SSE silently stalls
    const poll = setInterval(() => {
      getWall()
        .then((d) => {
          // only treat poll as authoritative if SSE hasn't updated recently
          if (Date.now() - lastUpdate.current > 25000) apply(d, "poll");
        })
        .catch(() => {});
    }, 30000);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(poll);
    };
  }, []);

  if (err && !data) {
    return (
      <div className="ops-wall">
        <div className="ops-error">{err} Retrying…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="ops-wall">
        <div className="ops-loading">Connecting to the live ops feed…</div>
      </div>
    );
  }

  const n = data.now;
  const bins = data.trailing3h.bins;
  const ratioSeries = series(bins, "service_ratio");
  const bunchSeries = series(bins, "active_bunching_pairs");
  const alertSeries = series(bins, "alerts_total");
  const devLast = data.trailing3h.headway_dev_last;
  const devSeries: (number | null)[] = data.trailing3h.headway_dev_series;
  const devNow = devLast ? devLast.value : null;

  const ratio = n.service_ratio;
  const ratioPct = ratio != null ? Math.round(ratio * 100) : null;
  const ratioColor =
    ratio == null ? "#94a3b8" : ratio >= 0.95 ? "#22c55e" : ratio >= 0.85 ? "#f59e0b" : "#ef4444";

  return (
    <div className="ops-wall">
      <header className="ops-head">
        <div>
          <h1>Live Ops Wall</h1>
          <p className="ops-sub">
            NYC transit service, right now — every number traces to a live endpoint.
          </p>
        </div>
        <div className="ops-conn">
          <span className={"ops-live-dot " + conn} />
          {conn === "sse" ? "streaming" : conn === "poll" ? "polling (30s)" : "connecting"}
          <span className="ops-ticks">· {ticks} updates</span>
        </div>
      </header>

      {/* -------- KPI tiles -------- */}
      <div className="ops-tiles">
        {/* vehicles vs scheduled */}
        <section className="ops-tile">
          <div className="ops-tile-label">Buses in service</div>
          <div className="ops-big">
            {n.buses.reporting.toLocaleString()}
            <span className="ops-big-sub">
              / {n.scheduled_active != null ? n.scheduled_active.toLocaleString() : "—"} scheduled
            </span>
          </div>
          <div className="ops-ratio">
            <div className="ops-ratio-bar">
              <div
                className="ops-ratio-fill"
                style={{ width: `${Math.min(100, ratioPct ?? 0)}%`, background: ratioColor }}
              />
            </div>
            <span className="ops-ratio-val" style={{ color: ratioColor }}>
              {ratioPct != null ? `${ratioPct}%` : "—"}
            </span>
          </div>
          <OpsSparkline values={ratioSeries} color="#38bdf8" liveValue={ratio} />
          <div className="ops-tile-foot">
            <Stamp label="live" epoch={n.buses.as_of} stale={n.buses.stale} />
            <span className="ops-src">{n.buses.source}</span>
          </div>
        </section>

        {/* routes bunching */}
        <section className="ops-tile">
          <div className="ops-tile-label">
            Routes with active bunching{" "}
            <ConfidenceBadge claimKey="ops-derived" window={archiveWindow(data.archive.archive_depth_days)} compact />
          </div>
          <div className="ops-big">
            {n.bunching.pct_routes_bunching}%
            <span className="ops-big-sub">
              {n.bunching.routes_bunching}/{n.bunching.routes_running} routes · {n.bunching.pairs} pairs
            </span>
          </div>
          <OpsSparkline values={bunchSeries} color="#f472b6" liveValue={n.bunching.pairs} invert />
          <div className="ops-tile-foot">
            <Stamp label="live" epoch={n.buses.as_of} stale={n.buses.stale} />
            <span className="ops-src">positions vs sched headway</span>
          </div>
        </section>

        {/* mean headway deviation (parquet rollup) */}
        <section className="ops-tile">
          <div className="ops-tile-label">
            Mean headway deviation{" "}
            <ConfidenceBadge claimKey="ops-derived" window={archiveWindow(data.archive.archive_depth_days)} compact />
          </div>
          <div className="ops-big">
            {fmtDev(devNow)}
            <span className="ops-big-sub">|observed − scheduled|, trailing 60 min</span>
          </div>
          <OpsSparkline values={devSeries} color="#fbbf24" invert />
          <div className="ops-tile-foot">
            <span className="ops-stamp">
              <span className="dot" style={{ background: "#94a3b8" }} />
              rollup {devLast ? devLast.local_iso.slice(11) : "—"}
            </span>
            <span className="ops-src">
              {devLast && devLast.lag_min > 15 ? `arrivals lag ~${devLast.lag_min}m` : "trailing 60 min"}
            </span>
          </div>
        </section>

        {/* active alerts */}
        <section className="ops-tile">
          <div className="ops-tile-label">Active service alerts</div>
          <div className="ops-big">
            {n.alerts.total.toLocaleString()}
            <span className="ops-big-sub">
              <span className="ops-sev high">{n.alerts.high} high</span> ·{" "}
              <span className="ops-sev medium">{n.alerts.medium} med</span> ·{" "}
              <span className="ops-sev low">{n.alerts.low} low</span>
            </span>
          </div>
          <OpsSparkline values={alertSeries} color="#a78bfa" liveValue={n.alerts.total} invert />
          <div className="ops-tile-foot">
            <Stamp label="live" epoch={n.alerts.as_of} />
            <span className="ops-src">bus + subway feeds</span>
          </div>
        </section>
      </div>

      {/* -------- map + ticker -------- */}
      <div className="ops-mid">
        <section className="ops-panel ops-map-panel">
          <div className="ops-panel-head">
            <h2>Bunching hotspots</h2>
            <Stamp label="live" epoch={n.buses.as_of} stale={n.buses.stale} />
          </div>
          <OpsHotspotMap hotspots={n.bunching.hotspots} />
          <MapLegend
            defaultOpen
            className="maplegend--inline maplegend--ops"
            items={[
              <span>
                Bunching severity: <Swatch color="#ef4444" />high <Swatch color="#f59e0b" />medium{" "}
                <Swatch color="#eab308" />low
              </span>,
              <span>Each mark is the midpoint between two bunched buses; line width also encodes severity.</span>,
            ]}
            stamps={
              <div>
                pair midpoints · showing {n.bunching.hotspots.length} of {n.bunching.pairs}
              </div>
            }
          />
        </section>

        <section className="ops-panel ops-ticker-panel">
          <div className="ops-panel-head">
            <h2>Alert ticker</h2>
            <Stamp label="live" epoch={n.alerts.as_of} />
          </div>
          <div className="ops-ticker">
            {n.alerts.items.length === 0 && <div className="ops-ticker-empty">No active alerts.</div>}
            {n.alerts.items.map((a) => (
              <div className={"ops-tick " + a.severity} key={a.id}>
                <span className={"ops-tick-sev " + a.severity} />
                <span className="ops-tick-routes">
                  {a.routes.length ? a.routes.slice(0, 4).join(" ") : a.subway ? "subway" : "bus"}
                </span>
                <span className="ops-tick-text">{a.header}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* -------- subway line strip -------- */}
      <section className="ops-panel ops-strip-panel">
        <div className="ops-panel-head">
          <h2>Subway line status</h2>
          <Stamp
            label="live"
            epoch={data.subway_strip.as_of}
            stale={data.subway_strip.stale}
          />
          <span className="ops-src">
            {data.subway_strip.total_trains.toLocaleString()} trains · {data.subway_strip.source}
          </span>
        </div>
        <div className="ops-strip">
          {data.subway_strip.lines.map((l) => (
            <div className="ops-line" key={l.route_id} title={`${l.count} trains`}>
              <span className="ops-bullet" style={{ background: l.color, color: l.text }}>
                {l.line}
              </span>
              <span className="ops-line-count">{l.count}</span>
              {l.alerted && <span className="ops-line-alert" title="active alert" />}
            </div>
          ))}
        </div>
      </section>

      {/* -------- honest footer -------- */}
      <footer className="ops-foot">
        <p>{data.trailing3h.splice_note}</p>
        <p>
          Sparklines show the last 3 h of the derive2 KPI rollup (5-min bins). The big
          numbers are computed live in-process from{" "}
          <code>/api/rt/vehicles</code>, <code>/api/rt/subway</code>, the alert feeds, and a
          live recompute of the scheduled-service denominator for the current 5-min bin
          {n.scheduled_bin_local_iso ? ` (${n.scheduled_bin_local_iso.slice(11)})` : ""}. The
          bunching tile is a live positional proxy (bus pairs within 25% of expected spacing
          and ≤500 m); the sparkline under it is the rigorous arrival-event metric from the
          rollup — the two are not blended across the splice.
        </p>
        {data.archive.preliminary && (
          <p className="ops-prelim">
            PRELIMINARY — the realtime archive is {data.archive.archive_depth_days ?? "?"} days
            deep. {data.archive.gap_note}
          </p>
        )}
      </footer>
    </div>
  );
}
