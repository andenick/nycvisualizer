// Observatory · Service Changes (S8). Chronological changelog of detected GTFS
// schedule changes from the S3 snapshot+diff engine, in plain language.
// TEMPORARY (planned next-7-days window) vs PERSISTED badges follow the S3
// README semantics honestly: supplemented-subway changes stay "planned/temporary"
// until observed persisting across snapshots.
import { useEffect, useMemo, useState } from "react";
import { getChanges, type ChangesResponse, type ServiceChange } from "../lib/api";
import ObsSubnav from "../components/ObsSubnav";

const TYPE_LABEL: Record<string, string> = {
  headway_delta: "Headway",
  trip_count_delta: "Trip count",
  service_span_change: "Service span",
  route_added: "Route added",
  route_removed: "Route removed",
  stop_added: "Stop added",
  stop_removed: "Stop removed",
  stop_relocated: "Stop moved",
  shape_change: "Routing",
};

function ChangeCard({ c }: { c: ServiceChange }) {
  return (
    <div id={c.id} className={"nyc-change " + c.classification}>
      <div className="chline">
        <span className="chsum">{c.summary}</span>
        <span className={"nyc-badge " + c.classification}>
          {c.classification === "temporary" ? "Planned / temporary" : "Persisted"}
        </span>
        <span className="nyc-badge type">{TYPE_LABEL[c.change_type] ?? c.change_type}</span>
      </div>
      <div className="chmeta">
        {c.borough} · detected {c.detected_at.slice(0, 10)} · feed {c.feed}
      </div>
    </div>
  );
}

export default function ChangesPage() {
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [err, setErr] = useState(false);
  const [borough, setBorough] = useState("");
  const [changeType, setChangeType] = useState("");
  const [route, setRoute] = useState("");
  const [includeProof, setIncludeProof] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  // Debounce the free-text route search a touch.
  const [routeQ, setRouteQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setRouteQ(route.trim()), 250);
    return () => clearTimeout(t);
  }, [route]);

  useEffect(() => {
    setErr(false);
    getChanges({
      page,
      page_size: PAGE_SIZE,
      borough: borough || undefined,
      change_type: changeType || undefined,
      route: routeQ || undefined,
      include_proof: includeProof || undefined,
    })
      .then(setData)
      .catch(() => setErr(true));
  }, [page, borough, changeType, routeQ, includeProof]);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => setPage(1), [borough, changeType, routeQ, includeProof]);

  const facets = data?.facets;
  const boroughs = useMemo(
    () => (facets ? Object.keys(facets.borough) : []),
    [facets],
  );
  const types = useMemo(
    () => (facets ? Object.keys(facets.change_type) : []),
    [facets],
  );
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <ObsSubnav />
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0.6rem 0" }}>Service Changes</h1>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Live</span>
      </div>

      <p className="lede" style={{ maxWidth: "66ch" }}>
        What changed in NYC's published transit schedule, and when we detected it. A
        content-hashed snapshot of every MTA feed is taken every 6 hours; when the schedule
        moves, the difference is logged here in plain language &mdash; headway shifts, trip-count
        changes, and service-span edits, per route.
      </p>

      <p className="nyc-note" style={{ marginTop: 0 }}>
        <strong>Planned vs persisted, honestly.</strong> The supplemented subway feed folds in
        the next ~7 days of planned service (weekend track-work windows, temporary reroutes). A
        change from that feed is labelled <em>planned / temporary</em> until we see it persist
        across later snapshots &mdash; we don't guess "permanent" prematurely. Detection began{" "}
        <strong>2026-07-21</strong>; this history deepens over time.
      </p>

      <div className="nyc-feedlinks">
        <a href="/api/changes/feed.json" title="Machine feed (JSON), newest 200">JSON feed</a>
        <a href="/api/changes/rss" title="RSS 2.0 feed of all changes">RSS</a>
        {routeQ ? (
          <a href={`/api/changes/rss?route=${encodeURIComponent(routeQ)}`} title={`Watch route ${routeQ} by RSS`}>
            RSS · watch {routeQ.toUpperCase()}
          </a>
        ) : (
          <span className="nyc-note" style={{ border: "none", padding: 0, margin: 0, fontSize: "0.76rem" }}>
            type a route below for a per-route RSS watch feed
          </span>
        )}
      </div>

      {data && (
        <p className="nyc-note" style={{ fontSize: "0.8rem" }}>
          {data.counts.detected} detected change{data.counts.detected === 1 ? "" : "s"} so far
          {" "}({data.counts.temporary} planned/temporary, {data.counts.persisted} persisted).
        </p>
      )}

      <div className="nyc-filters">
        <div className="field">
          <label htmlFor="fBorough">Borough / system</label>
          <select id="fBorough" value={borough} onChange={(e) => setBorough(e.target.value)}>
            <option value="">All</option>
            {boroughs.map((b) => (
              <option key={b} value={b}>{b} ({facets!.borough[b]})</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fType">Change type</label>
          <select id="fType" value={changeType} onChange={(e) => setChangeType(e.target.value)}>
            <option value="">All</option>
            {types.map((t) => (
              <option key={t} value={t}>{(TYPE_LABEL[t] ?? t)} ({facets!.change_type[t]})</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fRoute">Route</label>
          <input
            id="fRoute"
            type="text"
            placeholder="e.g. C, M15, 6"
            value={route}
            onChange={(e) => setRoute(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="fProof" style={{ marginBottom: "0.45rem" }}>Backfill</label>
          <label htmlFor="fProof" style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", textTransform: "none", letterSpacing: 0, fontWeight: 400, opacity: 1 }}>
            <input
              id="fProof"
              type="checkbox"
              checked={includeProof}
              style={{ minWidth: "auto", width: "auto" }}
              onChange={(e) => setIncludeProof(e.target.checked)}
            />
            Show proof diff
          </label>
        </div>
      </div>

      {includeProof && (
        <p className="nyc-note" style={{ borderLeftColor: "#d97706", fontSize: "0.8rem" }}>
          The <strong>proof / backfill</strong> diff compares the supplemented subway feed to the
          base timetable. Its large trip-count drops are a feed-structure artifact (the base feed
          uses 3 repeating service patterns; the supplemented feed enumerates 100+ dated ones), not
          a real service cut &mdash; it is shown only to demonstrate the differ end-to-end.
        </p>
      )}

      {err && <div className="nyc-note">Service-change feed temporarily unavailable.</div>}

      {data && data.changes.length === 0 && !err && (
        <p className="nyc-note">No changes match these filters yet.</p>
      )}

      {data && data.changes.length > 0 && (
        <div className="nyc-changelist">
          {data.changes.map((c) => (
            <ChangeCard key={c.id} c={c} />
          ))}
        </div>
      )}

      {data && totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", margin: "1rem 0" }}>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{ padding: "0.35rem 0.8rem" }}
          >
            ← Newer
          </button>
          <span className="nyc-note" style={{ border: "none", padding: 0, margin: 0 }}>
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            style={{ padding: "0.35rem 0.8rem" }}
          >
            Older →
          </button>
        </div>
      )}
    </div>
  );
}
