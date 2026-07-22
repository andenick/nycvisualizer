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
import ObsSubnav from "../components/ObsSubnav";

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
          style={{ color: bi < 0.15 ? "#16a34a" : bi < 0.3 ? "#d97706" : "#dc2626" }}
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

      {leagues && (
        <section className="nyc-section">
          <h2>Reliability leagues (preliminary)</h2>
          <div className="nyc-cards">
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
          <p className="nyc-note" style={{ fontSize: "0.8rem" }}>
            {leagues.criteria.qualifying_routes} routes qualify; {leagues.criteria.excluded_thin_routes} excluded
            as thin/gap-dominated ({leagues.criteria.note.split(".")[0]}).
          </p>
        </section>
      )}

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
    </div>
  );
}
