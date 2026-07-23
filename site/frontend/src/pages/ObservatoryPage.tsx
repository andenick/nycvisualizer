// Observatory landing (S5 item 1) — the route picker. A searchable, borough-
// grouped list of every route with SBS badges and a headline stat, plus league
// headline cards (most/least reliable, slowest corridor). Data honesty is front
// and centre: a PRELIMINARY badge + archive-depth stamp + gap note ride the top.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getObsRoutes,
  getLeagues,
  type ObsRoute,
  type ObsRoutesResponse,
  type LeaguesResponse,
} from "../lib/api";
import ArchiveBadge from "../components/ArchiveBadge";
import ArkPlotly from "../components/ArkPlotly";
import ConfidenceBadge from "../components/ConfidenceBadge";
import { ContextCallouts } from "../components/ContextCallout";
import KnowDontKnow from "../components/KnowDontKnow";
import { archiveWindow } from "../lib/confidence";
import ObsSubnav from "../components/ObsSubnav";
import charts from "../content/chartdata.json";

// Hub-Bound mode palette (categorical; validated to read in light + dark).
const HB_MODES: { key: string; name: string; color: string }[] = [
  { key: "subway", name: "Subway (incl. PATH)", color: "#2563eb" },
  { key: "rail", name: "Commuter/intercity rail", color: "#9333ea" },
  { key: "auto", name: "Auto / taxi / truck", color: "#6b7280" },
  { key: "bus", name: "Bus", color: "#16a34a" },
  { key: "ferry", name: "Ferry (excl. SI Ferry)", color: "#0891b2" },
  { key: "bike", name: "Bicycle", color: "#ea580c" },
  { key: "tram", name: "Tramway", color: "#db2777" },
];

function HubBoundChart() {
  const hb = (charts as Record<string, unknown>).hub_bound as
    | {
        years: number[];
        series: Record<string, number[]>;
        total: number[];
        source: string;
      }
    | undefined;
  if (!hb) return null;
  return (
    <ArkPlotly
      title="History meets live: who enters Manhattan's core, by mode"
      subtitle="NYMTC Hub-Bound — persons entering the CBD (south of 60th St) on a fall business day. 1963–1995 digitization in progress — the series extends as scans are processed."
      data={HB_MODES.map((m) => ({
        type: "bar",
        name: m.name,
        x: hb.years,
        y: hb.series[m.key],
        marker: { color: m.color },
      }))}
      layout={{
        barmode: "stack",
        yaxis: { title: { text: "persons entering (24-hour)" } },
        xaxis: { title: { text: "" }, dtick: 2, type: "linear" },
      }}
      csvRows={hb.years.map((y: number, i: number) => {
        const row: Record<string, number> = { year: y };
        for (const m of HB_MODES) row[m.key] = hb.series[m.key][i];
        row.total = hb.total[i];
        return row;
      })}
      csvName="hub_bound_cbd_entries_by_mode.csv"
      height={420}
      source={hb.source + " — Missing years: 2010–11 & pre-2007 await GPU re-extraction; 2021–22 not surveyed (COVID). We do NOT annotate a 'today' point: our live feeds count subway/bus systemwide, not cordon crossings south of 60th St, so they are not comparable to a Hub-Bound entry count. The congestion-pricing era (Jan 2025) is the newest chapter, measured by MTA's Central Business District Tolling entries — a distinct cordon count from a distinct program."}
    />
  );
}

const BOROUGH_ORDER = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "MTA Bus Co."];

function routeHref(routeId: string) {
  return `/observatory/${encodeURIComponent(routeId)}`;
}

function RouteChip({ r }: { r: ObsRoute }) {
  const bi = r.stats?.bunching_index;
  return (
    <Link className="obs-chip" to={routeHref(r.route_id)} title={r.long_name || r.short_name}>
      <span className="obs-chip-name">{r.short_name}</span>
      {r.sbs && !r.short_name.toUpperCase().includes("SBS") && <span className="obs-chip-sbs">SBS</span>}
      {bi != null && (
        <em
          className="obs-chip-bi"
          title={`bunching index ${bi}`}
          style={{ color: bi < 0.15 ? "#1a7f37" : bi < 0.3 ? "#b8860b" : "#dc2626" }}
        >
          {bi.toFixed(2)}
        </em>
      )}
    </Link>
  );
}

function LeagueCard({
  title,
  rows,
  metric,
  to,
}: {
  title: string;
  rows: { route_id: string; short_name?: string; label: string }[];
  metric: string;
  to: string;
}) {
  return (
    <div className="nyc-card obs-league-card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div className="obs-league-metric">{metric}</div>
      <ol className="obs-league-list">
        {rows.map((r, i) => (
          <li key={r.route_id + "-" + i}>
            <Link to={routeHref(r.route_id)}>{r.short_name || r.route_id}</Link>
            <span>{r.label}</span>
          </li>
        ))}
      </ol>
      <Link className="obs-league-more" to={to}>
        Full league tables →
      </Link>
    </div>
  );
}

export default function ObservatoryPage() {
  const [routes, setRoutes] = useState<ObsRoutesResponse | null>(null);
  const [leagues, setLeagues] = useState<LeaguesResponse | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");
  const [onlySbs, setOnlySbs] = useState(false);

  useEffect(() => {
    getObsRoutes().then(setRoutes).catch(() => setErr(true));
    getLeagues().then(setLeagues).catch(() => {});
  }, []);

  const grouped = useMemo(() => {
    if (!routes) return [];
    const ql = q.trim().toLowerCase();
    const filtered = routes.routes.filter((r) => {
      if (onlySbs && !r.sbs) return false;
      if (!ql) return true;
      return (
        r.short_name.toLowerCase().includes(ql) ||
        r.route_id.toLowerCase().includes(ql) ||
        r.long_name.toLowerCase().includes(ql)
      );
    });
    const byB = new Map<string, ObsRoute[]>();
    for (const r of filtered) {
      const b = r.borough_group || "Other";
      const g = byB.get(b) ?? [];
      g.push(r);
      byB.set(b, g);
    }
    for (const g of byB.values())
      g.sort((a, b) => a.short_name.localeCompare(b.short_name, undefined, { numeric: true }));
    const order = [...BOROUGH_ORDER, ...[...byB.keys()].filter((b) => !BOROUGH_ORDER.includes(b))];
    return order.filter((b) => byB.has(b)).map((b) => [b, byB.get(b)!] as [string, ObsRoute[]]);
  }, [routes, q, onlySbs]);

  return (
    <div>
      <ObsSubnav />
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0.6rem 0" }}>Bus Observatory</h1>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Live</span>
      </div>
      <p className="lede" style={{ maxWidth: "70ch" }}>
        Pick a bus route to open its dossier: the Marey diagram of every trip (observed vs scheduled), the
        per-stop headway strip, ridership by hour, slowest segments, stop-accessibility, and reliability &mdash;
        all built from a 31-second GTFS-RT archive of every vehicle in the five boroughs.
      </p>

      {routes && <ArchiveBadge archive={routes.archive} />}
      {err && <div className="nyc-note">Route list temporarily unavailable.</div>}

      {/* KB context: the Hub-Bound cordon series our live counts extend */}
      <ContextCallouts anchor="observatory-landing" />

      {/* Q3.3: the Hub-Bound "history meets live" hero chart — 60 years of CBD
          entries by mode (the born-digital slice; the scanned decades follow). */}
      <section className="nyc-section">
        <HubBoundChart />
      </section>

      {leagues && (() => {
        // Q2.3: the ranked route cards are gated on archive depth. Below 14 days
        // we don't name winners/losers on the landing either — we point to the
        // distribution. The Slowest-corridors card (MTA data) shows in both modes.
        const unlocked = leagues.rankings_unlocked || leagues.archive.archive_depth_days >= 14;
        return (
        <section className="nyc-section">
          <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            Reliability leagues
            <ConfidenceBadge claimKey="obs-leagues" window={archiveWindow(routes?.archive.archive_depth_days)} />
          </h2>
          <div className="nyc-cards">
            {unlocked ? (
              <>
                <LeagueCard
                  title="Most reliable"
                  metric="lowest bunching index"
                  to="/observatory/leagues"
                  rows={leagues.most_reliable.slice(0, 5).map((r) => ({
                    route_id: r.route_id,
                    short_name: r.short_name,
                    label: r.bunching_index.toFixed(3),
                  }))}
                />
                <LeagueCard
                  title="Least reliable"
                  metric="highest bunching index"
                  to="/observatory/leagues"
                  rows={leagues.least_reliable.slice(0, 5).map((r) => ({
                    route_id: r.route_id,
                    short_name: r.short_name,
                    label: r.bunching_index.toFixed(3),
                  }))}
                />
              </>
            ) : (
              <div className="nyc-card obs-league-card">
                <h3 style={{ marginTop: 0 }}>Reliability distribution</h3>
                <div className="obs-league-metric">rankings unlock at 14 observed days</div>
                <p style={{ margin: "0.2rem 0 0.8rem", fontSize: "0.9rem", opacity: 0.85 }}>
                  With {leagues.archive.archive_depth_days} day{leagues.archive.archive_depth_days === 1 ? "" : "s"} of
                  archive we show the <em>distribution</em> of bunching across {leagues.criteria.qualifying_routes}{" "}
                  qualifying routes, not a most/least-reliable ranking — a short window would make the order an artifact.
                </p>
                <Link className="obs-league-more" to="/observatory/leagues">See the distribution →</Link>
              </div>
            )}
            <LeagueCard
              title="Slowest corridors"
              metric="weighted peak speed (mph)"
              to="/observatory/leagues"
              rows={leagues.slowest_corridors.slice(0, 5).map((r) => ({
                route_id: r.route_id,
                short_name: `${r.route_id}`,
                label: `${r.wt_speed_mph} mph`,
              }))}
            />
          </div>
          <p className="nyc-note" style={{ fontSize: "0.8rem", maxWidth: "72ch" }}>
            {leagues.criteria.qualifying_routes} routes qualify; {leagues.criteria.excluded_thin_routes} excluded
            as thin/gap-dominated ({leagues.criteria.note.split(".")[0]}).
          </p>
        </section>
        );
      })()}

      <section className="nyc-section">
        <div className="obs-picker-head">
          <h2 style={{ margin: 0 }}>All routes {routes && <span style={{ opacity: 0.6, fontWeight: 400 }}>({routes.count})</span>}</h2>
          <div className="obs-picker-controls">
            <input
              type="search"
              placeholder="Search route (e.g. M15, Bx12, SBS)…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search routes"
            />
            <label className="obs-sbs-toggle">
              <input type="checkbox" checked={onlySbs} onChange={(e) => setOnlySbs(e.target.checked)} /> SBS only
            </label>
          </div>
        </div>
        {routes && grouped.length === 0 && <p className="nyc-note">No routes match “{q}”.</p>}
        {grouped.map(([b, rs]) => (
          <div key={b} className="obs-group">
            <h3 className="obs-group-h">{b} <span>({rs.length})</span></h3>
            <div className="obs-chips">
              {rs.map((r) => (
                <RouteChip key={r.route_id} r={r} />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="nyc-section">
        <h2>What we can and can&rsquo;t say yet</h2>
        <KnowDontKnow
          scope="the Bus Observatory"
          dated="2026-07-23"
          can={[
            { text: "Which routes bunch and which run steadily over the days we have observed — bunching is measured positionally, as the evenness of gaps between consecutive buses at a stop." },
            { text: "Each trip's actual path against its schedule (the Marey diagram) and the per-stop headway strip, for any route with observed history." },
            { text: "The slowest bus corridors citywide, from MTA segment-speed data (administrative, not archive-gated)." },
          ]}
          cannot={[
            { text: "Name a single “most” or “least” reliable route with confidence.", closes: "→ 14 days of continuous archive (currently building) turns the distribution into a stable ranking." },
            { text: "Distinguish a true door-open arrival from a shape-offset crossing.", closes: "→ the bus feed's current_status is 100% NULL; a stop-event feed would settle it." },
            { text: "Attribute a slow corridor to a specific cause (traffic vs dwell vs signal timing).", closes: "→ a matched segment-level travel-time decomposition." },
          ]}
        />
      </section>
    </div>
  );
}
