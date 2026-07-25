import { useEffect, useRef, useState } from "react";
import { getWall, streamWall, type WallResponse, type WallTrailBin } from "../lib/api";
import OpsSparkline from "../components/OpsSparkline";
import OpsHotspotMap from "../components/OpsHotspotMap";
import MapLegend, { Swatch } from "../components/MapLegend";
import ConfidenceBadge from "../components/ConfidenceBadge";
import { archiveWindow } from "../lib/confidence";

// W6a defect 2 — the stamp used to render TIME-OF-DAY ONLY. A timestamp from
// 2026-07-17 16:23 therefore displayed as "16:23:31" beside the word "live", and a
// week-old alert set read as a current clock. Any timestamp that is not from today now
// carries its DATE, so staleness is visible at a glance and cannot be misread as a clock.
function fmtClock(epoch: number | null | undefined): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// Plain-language age. Mirrors the backend's _fmt_age so both sides read the same.
function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "unknown age";
  const min = seconds / 60;
  if (min < 90) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 36) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

function fmtAgeMin(minutes: number | null | undefined): string {
  return fmtAge(minutes == null ? null : minutes * 60);
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

// W7 defect 4: per-point bin labels so each trend chart's CSV is readable, not a bare
// column of numbers whose x-axis the reader has to guess.
function binLabels(bins: WallTrailBin[]): (string | null)[] {
  return bins.map((b) => b.t ?? null);
}

// A small honest "as of" chip used per panel. When `stale` is set the chip says so in
// words — the label is replaced, not decorated, so "live" can never sit on stale data.
function Stamp({
  label,
  epoch,
  stale,
  ageS,
}: {
  label: string;
  epoch: number | null | undefined;
  stale?: boolean;
  ageS?: number | null;
}) {
  return (
    <span className={"ops-stamp" + (stale ? " stale" : "")}>
      <span className="dot" />
      {stale ? `STALE — ${fmtAge(ageS)} old` : label} {fmtClock(epoch)}
    </span>
  );
}

// Caption shown under every trend chart, stating exactly what the series is and how old.
function TrendCaption({ basis, label }: { basis?: string; label?: string }) {
  if (basis === "none") return <div className="ops-trend-cap empty">no rollup available</div>;
  return (
    <div className={"ops-trend-cap" + (basis === "last_available_rollup" ? " stale" : "")}>
      {label ?? "trailing 3 h"}
    </div>
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
  const t3 = data.trailing3h;
  const bins = t3.bins;
  const ratioSeries = series(bins, "service_ratio");
  const bunchSeries = series(bins, "active_bunching_pairs");
  const alertSeries = series(bins, "alerts_total");
  const devLast = t3.headway_dev_last;
  const devSeries: (number | null)[] = t3.headway_dev_series;
  const devNow = devLast ? devLast.value : null;

  // W6a defect 3 — the trend charts are rollups, the big numbers are live. Appending a
  // live point to a series that ends hours ago would draw a line across an unmarked gap
  // and imply continuity that does not exist. Only splice when the rollups really are
  // the trailing 3 h; otherwise the chart stands alone under its own honest caption.
  const trendBasis = t3.window_basis ?? (bins.length ? "trailing_3h" : "none");
  const canSplice = trendBasis === "trailing_3h";
  const alerts = n.alerts;
  const alertsStale = alerts.stale === true;
  // Upstream publishes no GTFS `effect` for any alert, so the high/med/low split would be
  // our own default presented as MTA's judgement. Show it only when upstream classifies.
  const severityKnown = alerts.severity_basis !== "unclassified";
  const schedAgeMin = n.scheduled_cache_age_min ?? null;

  const ratio = n.service_ratio;
  const ratioPct = ratio != null ? Math.round(ratio * 100) : null;
  const ratioColor =
    ratio == null ? "#94a3b8" : ratio >= 0.95 ? "#22c55e" : ratio >= 0.85 ? "#f59e0b" : "#ef4444";

  return (
    <div className="ops-wall">
      <header className="ops-head">
        <div>
          <h1>Live Ops Wall</h1>
          {/* W6a defect 3 — this used to read "every number traces to a live endpoint",
              which was false: the trend charts are derived rollups, not live, and on this
              server they can be many hours old. The subtitle now says what is actually
              true and the per-panel stamps carry the rest. */}
          <p className="ops-sub">
            NYC transit service, right now. The big numbers are computed live from the
            transit feeds; the trend charts underneath are derived rollups, each stamped
            with its own age.
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
          <OpsSparkline
            values={ratioSeries}
            color="#38bdf8"
            liveValue={canSplice ? ratio : undefined}
            title="Buses in service vs schedule — trend"
            labels={binLabels(bins)}
            valueHeader="service_ratio"
            csvName="ops_trend_service_ratio.csv"
          />
          <TrendCaption basis={trendBasis} label={t3.window_label} />
          <div className="ops-tile-foot">
            <Stamp label="live" epoch={n.buses.as_of} stale={n.buses.stale} />
            <span className="ops-src">
              {n.buses.source}
              {schedAgeMin != null && (
                <> · schedule cache {fmtAgeMin(schedAgeMin)} old</>
              )}
            </span>
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
          <OpsSparkline
            values={bunchSeries}
            color="#f472b6"
            liveValue={canSplice ? n.bunching.pairs : undefined}
            invert
            title="Bunched bus pairs — trend"
            labels={binLabels(bins)}
            valueHeader="active_bunching_pairs"
            csvName="ops_trend_bunching_pairs.csv"
          />
          <TrendCaption basis={trendBasis} label={t3.window_label} />
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
          {/* W6a defect 3 — this sub-label said "trailing 60 min" unconditionally while
              the value was a single rollup bin measured up to 14 h earlier (observed
              lag_min = 850 on the live endpoint). It now states what the number IS and
              how old it is, from the same lag the backend already reported. */}
          <div className="ops-big">
            {fmtDev(devNow)}
            <span className="ops-big-sub">
              |observed − scheduled|
              {devLast ? ` · one 5-min rollup bin, ${fmtAgeMin(devLast.lag_min)} old` : " · no rollup available"}
            </span>
          </div>
          <OpsSparkline
            values={devSeries}
            color="#fbbf24"
            invert
            title="Mean headway deviation — trend"
            valueHeader="mean_abs_headway_dev_s"
            csvName="ops_trend_headway_deviation.csv"
          />
          <div className={"ops-trend-cap" + (devLast && devLast.lag_min > 180 ? " stale" : "")}>
            {devLast
              ? `last ${devSeries.length} rollup bins, ending ${devLast.local_iso.replace("T", " ")}`
              : "no rollup available"}
          </div>
          <div className="ops-tile-foot">
            <span className={"ops-stamp" + (devLast && devLast.lag_min > 180 ? " stale" : "")}>
              <span className="dot" style={{ background: "#94a3b8" }} />
              rollup {devLast ? devLast.local_iso.replace("T", " ") : "—"}
            </span>
            <span className="ops-src">
              {devLast ? `arrivals lag ~${fmtAgeMin(devLast.lag_min)}` : "not derived yet"}
            </span>
          </div>
        </section>

        {/* active alerts */}
        <section className="ops-tile">
          <div className="ops-tile-label">Active service alerts</div>
          <div className="ops-big">
            {alerts.total.toLocaleString()}
            {/* W6a — MTA publishes no GTFS `effect` on either alert feed (measured:
                424/424 UNKNOWN_EFFECT), so a "0 high · 0 med · N low" split would
                present our own default as MTA's severity judgement. Show the split
                only when upstream actually classifies. */}
            <span className="ops-big-sub">
              {severityKnown ? (
                <>
                  <span className="ops-sev high">{alerts.high} high</span> ·{" "}
                  <span className="ops-sev medium">{alerts.medium} med</span> ·{" "}
                  <span className="ops-sev low">{alerts.low} low</span>
                </>
              ) : (
                <>severity not published by the feed</>
              )}
            </span>
          </div>
          <OpsSparkline
            values={alertSeries}
            color="#a78bfa"
            liveValue={canSplice ? alerts.total : undefined}
            invert
            title="Active service alerts — trend"
            labels={binLabels(bins)}
            valueHeader="alerts_total"
            csvName="ops_trend_alerts.csv"
          />
          <TrendCaption basis={trendBasis} label={t3.window_label} />
          <div className="ops-tile-foot">
            <Stamp
              label={alerts.source === "archive" ? "archive" : "live"}
              epoch={alerts.as_of}
              stale={alertsStale}
              ageS={alerts.age_s}
            />
            <span className="ops-src">
              {alerts.feeds && Object.keys(alerts.feeds).length
                ? Object.entries(alerts.feeds)
                    .map(([f, v]) => `${f.replace("_alerts", "")} ${v.count}`)
                    .join(" · ")
                : "bus + subway feeds"}
            </span>
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
            <Stamp
              label={alerts.source === "archive" ? "archive" : "live"}
              epoch={alerts.as_of}
              stale={alertsStale}
              ageS={alerts.age_s}
            />
            <span className="ops-src">
              showing {alerts.items.length} of {alerts.total.toLocaleString()}
            </span>
          </div>
          <div className="ops-ticker">
            {alerts.items.length === 0 && <div className="ops-ticker-empty">No active alerts.</div>}
            {alerts.items.map((a) => (
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
          The big numbers are computed live, this request, from the MTA bus and subway
          position feeds, the bus and subway alert feeds, and a recompute of the
          scheduled-service denominator for the current 5-minute bin
          {n.scheduled_bin_local_iso ? ` (${n.scheduled_bin_local_iso.slice(11)})` : ""}
          {schedAgeMin != null
            ? ` against a schedule cache built ${fmtAgeMin(schedAgeMin)} ago`
            : ""}
          . The sparklines are a different thing: 5-minute rollup bins computed from the
          archive after the fact, captioned with the window they actually cover
          {trendBasis === "last_available_rollup"
            ? " — which on this server is NOT the last 3 hours, because derived rollups are published here once a day"
            : ""}
          . The bunching tile is a live positional proxy (bus pairs within 25% of expected
          spacing and ≤500 m); the sparkline under it is the rigorous arrival-event metric
          from the rollup — the two are never blended across the splice, and no live value
          is appended to a stale series.
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
