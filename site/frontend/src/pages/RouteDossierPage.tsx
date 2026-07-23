// Route dossier (S5 item 2) — /observatory/:route. THE Marey view sits at the
// top, then the per-stop headway strip, then the dossier panels: ridership by
// hour, slowest segments, SAI/shelter, ACE (fetched from the SBS "+" sibling
// where one exists), scheduled service, and active alerts. Every chart follows
// the Universal Graph Contract via ArkPlotly; the Marey is the custom canvas.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getDossier,
  getObsRoutes,
  type DossierResponse,
  type AceInfo,
} from "../lib/api";
import MareyChart from "../components/MareyChart";
import Breadcrumbs from "../components/Breadcrumbs";
import ReliabilityRibbon from "../components/ReliabilityRibbon";
import HeadwayStrip from "../components/HeadwayStrip";
import ChartErrorBoundary from "../components/ChartErrorBoundary";
import ArkPlotly from "../components/ArkPlotly";
import ArchiveBadge from "../components/ArchiveBadge";
import ReconciliationNote from "../components/ReconciliationNote";
import { ContextCallouts } from "../components/ContextCallout";

const fmtInt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

// Q0.6.4: cache the set of base route ids that actually HAVE an SBS "+" sibling,
// derived once from the routes catalog. The dossier previously fired a second
// heavy getDossier(routeId + "+") for EVERY non-SBS route (most have no sibling),
// doubling dossier traffic. We now probe the sibling only when the catalog
// confirms it exists. Robust to id form: "M15+" and "M15-SBS" both map to base
// "M15".
let _sbsBasesPromise: Promise<Set<string>> | null = null;
function sbsSiblingBases(): Promise<Set<string>> {
  if (!_sbsBasesPromise) {
    _sbsBasesPromise = getObsRoutes()
      .then((resp) => {
        const bases = new Set<string>();
        for (const r of resp.routes) {
          if (!r.sbs) continue;
          const base = r.route_id.replace(/\+$/, "").replace(/[-\s]?SBS$/i, "").trim();
          if (base) bases.add(base);
        }
        return bases;
      })
      .catch(() => new Set<string>());
  }
  return _sbsBasesPromise;
}

// MTA alert descriptions arrive with literal HTML; render as clean plain text
// (Carson CONTENT_RENDERING: never ship literal markup). Block tags → line breaks.
const stripHtml = (s: string) =>
  s
    .replace(/<\/p>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="obs-stat">
      <div className="obs-stat-v">{value}</div>
      <div className="obs-stat-l">{label}</div>
      {sub && <div className="obs-stat-s">{sub}</div>}
    </div>
  );
}

function RidershipPanel({ d, route }: { d: DossierResponse; route: string }) {
  if (!d.ridership_by_hour.length) return null;
  const hours = d.ridership_by_hour.map((r) => r.hod);
  return (
    <ArkPlotly
      title="Ridership by hour of day"
      subtitle="Average boardings by hour — weekday vs weekend"
      data={[
        { type: "bar", name: "Weekday", x: hours, y: d.ridership_by_hour.map((r) => r.weekday_boardings), marker: { color: "#2563eb" } },
        { type: "bar", name: "Weekend", x: hours, y: d.ridership_by_hour.map((r) => r.weekend_boardings), marker: { color: "#93c5fd" } },
      ]}
      layout={{ barmode: "group", xaxis: { title: { text: "hour of day" }, dtick: 3 }, yaxis: { title: { text: "boardings" } } }}
      csvRows={d.ridership_by_hour.map((r) => ({
        hour_of_day: r.hod,
        weekday_boardings: r.weekday_boardings,
        weekend_boardings: r.weekend_boardings,
        total_boardings: r.total_boardings,
      }))}
      csvName={`ridership_${route}.csv`}
      source="Source: MTA Bus Hourly Ridership (kv7t-n8in / gxb3-akrn)."
    />
  );
}

function AcePanel({ ace, aceRoute }: { ace: AceInfo; aceRoute: string }) {
  return (
    <section className="obs-panel">
      <h3 style={{ marginTop: 0 }}>Automated Camera Enforcement (ACE)</h3>
      <p className="nyc-note" style={{ marginTop: 0 }}>
        Bus-lane camera violations for <strong>{aceRoute}</strong> (the SBS variant carries the ACE program).
        Program: {ace.program ?? "—"}, live since {ace.implementation_date?.slice(0, 10) ?? "—"}.
      </p>
      <div className="obs-stats-row">
        <StatTile label="violations total" value={fmtInt(ace.violations_total)} sub={`${ace.first_violation?.slice(0, 10) ?? ""}–${ace.last_violation?.slice(0, 10) ?? ""}`} />
      </div>
      {ace.by_year.length > 0 && (
        <ArkPlotly
          title="ACE violations by year"
          subtitle={`${aceRoute} — bus-lane camera violations issued per year`}
          data={[{ type: "bar", x: ace.by_year.map((y) => y.year), y: ace.by_year.map((y) => y.violations), marker: { color: "#d97706" } }]}
          layout={{ xaxis: { title: { text: "year" }, dtick: 1 }, yaxis: { title: { text: "violations" } } }}
          height={280}
          csvRows={ace.by_year.map((y) => ({ year: y.year, violations: y.violations }))}
          csvName={`ace_${aceRoute}.csv`}
          source="Source: MTA Bus Automated Camera Enforcement Violations."
        />
      )}
      <ReconciliationNote
        title="Does camera enforcement speed the bus up? Our reading vs the MTA's"
        ours={{
          label: "Our measurement",
          value: "≈ 0 mph",
          detail: "median change in per-segment through-speed on ACE vs non-ACE corridors (peak, weighted) — a blunt, unmatched citywide difference",
          source: "nycvisualizer segment-speed analysis, 2026-07",
        }}
        authority={{
          label: "MTA ACE program",
          value: "+5% average",
          detail: "reported speed-up across the 39 ACE-enforced routes, with some corridors up to +30%",
          source: "MTA ACE program materials, 2024–25",
        }}
        why="These measure different things. Ours is the median difference in raw through-speed across every segment citywide — an unmatched comparison dominated by ordinary congestion and route mix, so the net difference washes out near zero. The MTA's is a targeted before-and-after on the specific corridors it enforces, where a blocked bus lane is the binding delay; on those corridors, and by that estimand, clearing the lane buys measurable speed."
        closes="A matched difference-in-differences — ACE corridors before vs after enforcement against comparable control routes — rather than a citywide segment average. The congestion-pricing and ACE-evaluation acquisitions (campaign Q3) are what feed that design."
        dated="2026-07 (MTA figures current to 2024–25)"
      />
    </section>
  );
}

export default function RouteDossierPage() {
  const { route: routeParam } = useParams();
  const routeId = decodeURIComponent(routeParam ?? "");
  const [d, setD] = useState<DossierResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "err">("loading");
  // ACE lives on the SBS "+" sibling; fetch it separately when this route isn't itself "+".
  const [sblAce, setSblAce] = useState<{ ace: AceInfo; route: string } | null>(null);

  useEffect(() => {
    setStatus("loading");
    setSblAce(null);
    getDossier(routeId)
      .then((res) => {
        setD(res);
        setStatus("ok");
        // If no ACE here and this isn't the "+" variant, probe the sibling —
        // but ONLY when the routes catalog confirms an SBS sibling exists
        // (Q0.6.4: avoids a wasted heavy dossier fetch for every plain route).
        if ((!res.ace || !res.ace.ace_enabled) && !routeId.endsWith("+")) {
          const sib = routeId + "+";
          sbsSiblingBases().then((bases) => {
            if (!bases.has(routeId)) return; // no SBS sibling — skip the probe
            getDossier(sib)
              .then((s2) => {
                if (s2.ace && s2.ace.ace_enabled) setSblAce({ ace: s2.ace, route: s2.meta.short_name || sib });
              })
              .catch(() => {});
          });
        }
      })
      .catch(() => setStatus("err"));
  }, [routeId]);

  const display = d?.meta.short_name || routeId;
  const ace = useMemo(() => {
    if (d?.ace?.ace_enabled) return { ace: d.ace, route: d.meta.short_name || routeId };
    if (sblAce) return sblAce;
    return null;
  }, [d, sblAce, routeId]);

  if (status === "err")
    return (
      <div>
        <Breadcrumbs crumbs={[{ label: "Observatory", to: "/observatory" }, { label: routeId }]} />
        <Link to="/observatory" className="obs-back">← All routes</Link>
        <div className="nyc-note">No dossier for route “{routeId}”. It may not be a current bus route.</div>
      </div>
    );

  return (
    <div>
      {/* Q4.1: breadcrumb trail (Observatory → M15) + cross-links to the same
          route in the leagues and service-changes views. */}
      <Breadcrumbs crumbs={[{ label: "Observatory", to: "/observatory" }, { label: display }]} />
      <div className="obs-crosslinks" aria-label="This route elsewhere">
        <Link className="obs-xchip" to="/observatory/leagues">Reliability leagues</Link>
        <Link className="obs-xchip" to={`/observatory/changes?route=${encodeURIComponent(display)}`}>
          Service changes for {display}
        </Link>
        <Link className="obs-xchip" to="/observatory">← All routes</Link>
      </div>
      <div className="obs-dossier-head">
        <h1 style={{ margin: "0.3rem 0" }}>
          {display}
          {d?.meta.sbs && !display.toUpperCase().includes("SBS") && (
            <span className="obs-chip-sbs" style={{ marginLeft: 8, verticalAlign: "middle" }}>SBS</span>
          )}
        </h1>
        {d?.meta.long_name && <div className="obs-dossier-sub">{d.meta.long_name} · {d.meta.borough}</div>}
      </div>

      {/* THE Marey view */}
      <ChartErrorBoundary label="Marey diagram">
        <MareyChart route={routeId} displayName={display} accent="#2563eb" />
      </ChartErrorBoundary>

      {/* Reliability ribbon — segment speeds on the map (Q1.3) */}
      <ChartErrorBoundary label="Reliability ribbon">
        <ReliabilityRibbon route={routeId} displayName={display} />
      </ChartErrorBoundary>

      {status === "ok" && d && (
        <>
          {/* headline reliability tiles */}
          {d.reliability_summary && (
            <div className="obs-stats-row">
              <StatTile label="median headway" value={`${d.reliability_summary.median_headway_min ?? "—"} min`} sub={`sched ${d.reliability_summary.sched_median_headway_s ? Math.round(d.reliability_summary.sched_median_headway_s / 60) : "—"} min`} />
              <StatTile label="bunching index" value={`${d.reliability_summary.bunching_index ?? "—"}`} sub="lower = steadier" />
              <StatTile label="median deviation" value={`${d.reliability_summary.median_deviation_s != null ? Math.round(d.reliability_summary.median_deviation_s) : "—"} s`} sub="vs schedule" />
              <StatTile label="observed" value={`${fmtInt(d.reliability_summary.n_headways)}`} sub={`headways · ${d.reliability_summary.observed_days}d`} />
              {d.route_peak_speed && <StatTile label="peak speed" value={`${d.route_peak_speed.wt_speed_mph} mph`} sub="weighted, peak hrs" />}
            </div>
          )}

          {/* per-stop headway strip (with click-through hourly detail) */}
          <HeadwayStrip route={routeId} direction={0} />

          {/* ridership by hour */}
          <RidershipPanel d={d} route={routeId} />

          {/* slowest segments */}
          {d.slowest_segments.length > 0 && (
            <section className="obs-panel">
              <h3 style={{ marginTop: 0 }}>Slowest segments (peak)</h3>
              <div className="nyc-table-wrap">
                <table className="nyc-table">
                  <thead>
                    <tr><th>From</th><th>To</th><th style={{ textAlign: "right" }}>Speed (mph)</th><th style={{ textAlign: "right" }}>Trips</th><th style={{ textAlign: "right" }}>Miles</th></tr>
                  </thead>
                  <tbody>
                    {d.slowest_segments.map((s, i) => (
                      <tr key={i}>
                        <td>{s.from_stop}</td><td>{s.to_stop}</td>
                        <td style={{ textAlign: "right" }}>{s.wt_speed_mph}</td>
                        <td style={{ textAlign: "right" }}>{fmtInt(s.n_trips)}</td>
                        <td style={{ textAlign: "right" }}>{s.seg_miles}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="nyc-note" style={{ fontSize: "0.78rem" }}>Source: bus segment-speed analysis (peak hours), weighted by trip count.</p>
              {/* Q3.3: congestion-pricing context — our segment speeds are the
                  post-CP era (CP began 5 Jan 2025). Quote-verified KB callouts. */}
              <ContextCallouts anchor="dossier-speed" />
            </section>
          )}

          {/* SAI / shelter + stop spacing */}
          {(d.sai_stats || d.stop_spacing) && (
            <section className="obs-panel">
              <h3 style={{ marginTop: 0 }}>Stops: accessibility &amp; spacing</h3>
              <div className="obs-stats-row">
                {d.sai_stats && <StatTile label="stops matched" value={fmtInt(d.sai_stats.n_stops_matched)} />}
                {d.sai_stats?.median_composite_sai != null && <StatTile label="median SAI" value={`${d.sai_stats.median_composite_sai}`} sub="stop accessibility index" />}
                {d.sai_stats?.pct_sheltered != null && <StatTile label="sheltered" value={`${d.sai_stats.pct_sheltered}%`} sub="stops with a shelter ≤100ft" />}
                {d.sai_stats?.median_walkshed_population != null && <StatTile label="walkshed pop." value={fmtInt(d.sai_stats.median_walkshed_population)} sub="median, per stop" />}
                {d.stop_spacing && <StatTile label="stop spacing" value={`${Math.round(d.stop_spacing.median_spacing_ft)} ft`} sub={`${d.stop_spacing.n_stops} stops, median`} />}
              </div>
            </section>
          )}

          {/* ACE */}
          {ace && <AcePanel ace={ace.ace} aceRoute={ace.route} />}
          {!ace && (
            <section className="obs-panel">
              <h3 style={{ marginTop: 0 }}>Automated Camera Enforcement (ACE)</h3>
              <p className="nyc-note" style={{ marginTop: 0 }}>No ACE bus-lane camera program on this route.</p>
            </section>
          )}

          {/* scheduled service */}
          {d.scheduled_service.length > 0 && (
            <section className="obs-panel">
              <h3 style={{ marginTop: 0 }}>Scheduled service</h3>
              <div className="nyc-table-wrap">
                <table className="nyc-table">
                  <thead>
                    <tr><th>Dir</th><th>Period</th><th style={{ textAlign: "right" }}>Span (min)</th><th style={{ textAlign: "right" }}>Trips</th><th style={{ textAlign: "right" }}>Headway (min)</th></tr>
                  </thead>
                  <tbody>
                    {d.scheduled_service.map((s, i) => (
                      <tr key={i}>
                        <td>{s.direction_id === 0 ? "Out" : s.direction_id === 1 ? "In" : "—"}</td>
                        <td>{s.period}</td>
                        <td style={{ textAlign: "right" }}>{fmtInt(s.span_min)}</td>
                        <td style={{ textAlign: "right" }}>{fmtInt(s.trips)}</td>
                        <td style={{ textAlign: "right" }}>{s.headway_min ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* alerts */}
          {d.alerts_active.length > 0 && (
            <section className="obs-panel">
              <h3 style={{ marginTop: 0 }}>Active service alerts</h3>
              {d.alerts_active.map((a) => (
                <div key={a.id} className="nyc-alert" style={{ position: "static", marginBottom: "0.5rem" }}>
                  <strong>{stripHtml(a.header)}</strong>
                  {a.description && (
                    <div style={{ marginTop: 4, fontSize: "0.82rem", whiteSpace: "pre-line" }}>
                      {stripHtml(a.description)}
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}

          <ArchiveBadge archive={d.archive} />
          <p className="nyc-note" style={{ fontSize: "0.76rem" }}>
            Dossier generated {new Date(d.generated_at).toLocaleString([], { timeZone: "America/New_York" })} in{" "}
            {d.elapsed_ms} ms. Real data only — panels with no data are omitted, never faked.
          </p>
        </>
      )}
      {status === "loading" && <div className="nyc-note">Loading dossier…</div>}
    </div>
  );
}
