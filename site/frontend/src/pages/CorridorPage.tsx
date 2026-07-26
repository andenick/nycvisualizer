// THE CORRIDOR VIEW — /observatory/:route/corridor
//
// Three questions about one corridor, each answered by a finished server-side payload:
//   * **Ladder** — where every bus on this route is right now, between which two stops.
//     Bunching is legible at a glance because two vehicle rows sit between the same pair
//     of stops; no statistic has to be defended.
//   * **Stop spacing** — every consecutive gap along the route, in order, per direction,
//     so the question "where is this route's spacing wrong?" is answerable at all.
//   * **Slow spots** — where buses actually crawl, from two independent sources, each
//     with its own method and caveat on screen.
//
// The archive/coverage honesty stamp is rendered ONCE for the page. `archive.preliminary`
// is true today and the stamp says so in words rather than a badge alone.
//
// Cost discipline: each tab fetches only when it is opened, the ladder polls only while it
// is the visible tab, and every payload is rendered as handed — nothing is re-derived in
// the browser. This page never touches the map or the flow engine.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  getLadder,
  getSlowSpots,
  getSpacing,
  type ArchiveMeta,
  type CoverageStamp,
  type LadderResponse,
  type LadderStop,
  type SlowSpotBin,
  type SlowSpotsResponse,
  type SpacingResponse,
} from "../lib/api";
import RouteLadder, { ladderStopKey } from "../components/RouteLadder";
import CorridorSpacing from "../components/CorridorSpacing";
import Breadcrumbs from "../components/Breadcrumbs";
import ObsSubnav from "../components/ObsSubnav";
import { toggleCapped, type SnapStop } from "../lib/stopGeo";
import "../styles/corridor.css";

/** Same cap the workstation applies to its stop cards (CARD_CAP), so a selection made on
 *  the ladder and one made on the map behave identically — including the eviction rule. */
const CARD_CAP = 10;

const DASH = "—";
const TABS = [
  { id: "ladder", label: "Ladder" },
  { id: "spacing", label: "Stop spacing" },
  { id: "slow", label: "Slow spots" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const fmtMi = (mi: number | null | undefined) =>
  mi == null || !Number.isFinite(mi) ? null : `${mi.toFixed(2)} mi`;
const fmtMph = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : `${v.toFixed(1)} mph`;
const fmtShare = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : v.toFixed(2);
const fmtInt = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v).toLocaleString();

/** The half-mile bin rows. `SlowSpotBin` in lib/api.ts is now taken FROM the live payload
 *  (it was previously a guessed shape whose column names did not exist, and which also
 *  collided by declaration-merging with the dossier's `SlowSegment`). Only the one field
 *  the endpoint may omit is widened here. */
interface SlowBinLive extends SlowSpotBin {
  suppressed_reason?: string;
}

/** One honesty stamp for the page: how much archive is behind the observed panels, and
 *  whether it is still preliminary. */
function ArchiveStamp({
  archive,
  coverage,
}: {
  archive: ArchiveMeta | null | undefined;
  coverage: CoverageStamp | null | undefined;
}) {
  if (!archive && !coverage) return null;
  return (
    <div className="crd-panel">
      <div className="crd-ladder-live">
        {archive?.preliminary && (
          <span className="nyc-badge type obs-prelim">Preliminary</span>
        )}
        {archive && (
          <span className="crd-count">
            <strong>{archive.qualifying_days}</strong> qualifying service day
            {archive.qualifying_days === 1 ? "" : "s"} of archive
            {archive.partition_days != null &&
              ` (${archive.partition_days} day directories, ${archive.non_qualifying_days} not qualifying)`}
          </span>
        )}
        {coverage?.equivalent_complete_days != null && (
          <span className="crd-count">
            {coverage.equivalent_complete_days.toFixed(2)} equivalent complete days ·{" "}
            {coverage.complete_days} complete
          </span>
        )}
      </div>
      {archive?.preliminary && (
        <p className="crd-note">
          These observed statistics are marked preliminary: the archive has not yet reached
          the depth at which this platform will rank routes against one another. Read them
          as what has been observed so far, not as a settled record.
        </p>
      )}
      {archive?.depth_basis && <p className="crd-cap">{archive.depth_basis}</p>}
      {archive?.gap_note && <p className="crd-cap">{archive.gap_note}</p>}
      {coverage?.complete_day_rule && <p className="crd-cap">{coverage.complete_day_rule}.</p>}
      {coverage?.depth_note && <p className="crd-cap">{coverage.depth_note}</p>}
      {archive && archive.excluded_dates?.length > 0 && (
        <details className="crd-details">
          <summary>
            {archive.excluded_dates.length} day
            {archive.excluded_dates.length === 1 ? "" : "s"} excluded, and why
          </summary>
          <dl>
            {archive.excluded_dates.map((d) => (
              <div key={d.date}>
                <dt>
                  {d.date} — {d.reason}
                </dt>
                <dd>{d.detail}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

function SlowSpots({ data }: { data: SlowSpotsResponse }) {
  const seg = data.stop_pair_segments;
  const bins = data.observed_half_mile_bins;
  const binRows = (bins?.slowest_10 ?? []) as SlowBinLive[];
  return (
    <div className="crd-slow">
      <div className="crd-panel">
        <h2 style={{ marginTop: 0 }}>Slow spots</h2>
        <div className="crd-stats">
          <div className="crd-stat">
            <div className="crd-stat-v">{fmtMph(data.route_median_speed_mph) ?? DASH}</div>
            <div className="crd-stat-l">Route median (analysis)</div>
          </div>
          <div className="crd-stat">
            <div className="crd-stat-v">
              {fmtMph(data.route_observed_median_speed_mph) ?? DASH}
            </div>
            <div className="crd-stat-l">Route median (observed)</div>
          </div>
          <div className="crd-stat">
            <div className="crd-stat-v">{seg?.n_segments ?? 0}</div>
            <div className="crd-stat-l">Stop-pair segments</div>
          </div>
          <div className="crd-stat">
            <div className="crd-stat-v">{bins?.n_bins_published ?? 0}</div>
            <div className="crd-stat-l">Half-mile bins published</div>
            <div className="crd-stat-s">
              {bins?.n_bins_suppressed ?? 0} suppressed of {bins?.n_bins ?? 0}
            </div>
          </div>
        </div>
      </div>

      <section className="crd-panel">
        <h3 style={{ marginTop: 0 }}>Slowest stop-pair segments</h3>
        {seg && seg.n_segments > 0 ? (
          <div className="nyc-table-wrap">
            <table className="nyc-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th style={{ textAlign: "right" }}>Speed</th>
                  <th style={{ textAlign: "right" }}>Length</th>
                  <th style={{ textAlign: "right" }}>Trips</th>
                  <th style={{ textAlign: "right" }}>Within-route pctile</th>
                </tr>
              </thead>
              <tbody>
                {seg.slowest_10.map((s, i) => (
                  <tr key={i}>
                    <td>{s.from_stop}</td>
                    <td>{s.to_stop}</td>
                    <td style={{ textAlign: "right" }}>
                      {fmtMph(s.wt_speed_mph) ?? DASH}
                    </td>
                    <td style={{ textAlign: "right" }}>{fmtMi(s.seg_miles) ?? DASH}</td>
                    <td style={{ textAlign: "right" }}>{fmtInt(s.n_trips) ?? DASH}</td>
                    <td style={{ textAlign: "right" }}>
                      {fmtShare(s.speed_pctile_within_route) ?? DASH}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          // An empty table is an absence of qualifying measurement, and must never read as
          // "this route is fine".
          <p className="crd-note">
            No stop-pair segment for this route appears in the source analysis, so none is
            published. That is an absence of measurement, not evidence that the route runs
            well.
          </p>
        )}
        {seg?.source && <p className="crd-cap">Source: {seg.source}</p>}
        {seg?.method && <p className="crd-cap">Method: {seg.method}</p>}
      </section>

      <section className="crd-panel">
        <h3 style={{ marginTop: 0 }}>Slowest observed half-mile bins</h3>
        {binRows.length > 0 ? (
          <div className="nyc-table-wrap">
            <table className="nyc-table">
              <thead>
                <tr>
                  <th>Dir</th>
                  <th>From</th>
                  <th>To</th>
                  <th style={{ textAlign: "right" }}>Median speed</th>
                  <th style={{ textAlign: "right" }}>Observations</th>
                  <th style={{ textAlign: "right" }}>vs route median</th>
                </tr>
              </thead>
              <tbody>
                {binRows.map((b, i) => (
                  <tr key={i}>
                    <td>{b.direction_id ?? DASH}</td>
                    <td>
                      {b.from_stop ?? DASH}
                      {b.beyond_labelling_shape && (
                        <span className="crd-nc" title="This bin sits past the end of the shape most trips use, so no stop name can be attached to it.">
                          {" "}
                          beyond the labelling shape
                        </span>
                      )}
                    </td>
                    <td>{b.to_stop ?? DASH}</td>
                    <td style={{ textAlign: "right" }}>{fmtMph(b.median_speed_mph) ?? DASH}</td>
                    <td style={{ textAlign: "right" }}>{fmtInt(b.n_observations) ?? DASH}</td>
                    <td style={{ textAlign: "right" }}>{fmtShare(b.vs_route_median) ?? DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="crd-note">
            No half-mile bin on this route reached the published minimum of{" "}
            {bins?.min_observations ?? DASH} observations, so none is published. No
            observations qualify at the published minimum — which is not the same as the
            route having no slow stretch.
          </p>
        )}
        {bins?.source && <p className="crd-cap">Source: {bins.source}</p>}
        {bins?.method && <p className="crd-cap">Method: {bins.method}</p>}
        {bins?.caveat && <p className="crd-cap">Caveat: {bins.caveat}</p>}
      </section>
    </div>
  );
}

export default function CorridorPage() {
  const params = useParams<{ route: string }>();
  const routeId = params.route ?? "";
  const [search, setSearch] = useSearchParams();
  const rawTab = search.get("tab");
  const tab: TabId = TABS.some((t) => t.id === rawTab) ? (rawTab as TabId) : "ladder";

  const [ladder, setLadder] = useState<LadderResponse | null>(null);
  const [ladderErr, setLadderErr] = useState<string | null>(null);
  const [spacing, setSpacing] = useState<SpacingResponse | null>(null);
  const [spacingErr, setSpacingErr] = useState<string | null>(null);
  const [slow, setSlow] = useState<SlowSpotsResponse | null>(null);
  const [slowErr, setSlowErr] = useState<string | null>(null);

  // Stop selection, in the workstation's own vocabulary: namespaced "b:"+stop_id keys and
  // the SAME capped/oldest-evicted primitive, so a ladder click and a map click produce
  // identical state and the same shareable link.
  const [selStops, setSelStops] = useState<SnapStop[]>([]);
  const selectedStopIds = useMemo(() => new Set(selStops.map((s) => s.key)), [selStops]);

  const onStopClick = useCallback(
    (stop: LadderStop) => {
      if (stop.lat == null || stop.lon == null) return; // never guess a position
      const snap: SnapStop = {
        key: ladderStopKey(stop),
        stopId: stop.stop_id,
        name: stop.stop_name,
        lat: stop.lat,
        lon: stop.lon,
        kind: "bus",
        routes: [routeId],
      };
      setSelStops((prev) => toggleCapped(prev, snap, CARD_CAP));
    },
    [routeId],
  );

  const setTab = useCallback(
    (id: TabId) => {
      const next = new URLSearchParams(search);
      if (id === "ladder") next.delete("tab");
      else next.set("tab", id);
      setSearch(next, { replace: true });
    },
    [search, setSearch],
  );

  // Reset every payload when the route changes.
  useEffect(() => {
    setLadder(null);
    setSpacing(null);
    setSlow(null);
    setLadderErr(null);
    setSpacingErr(null);
    setSlowErr(null);
    setSelStops([]);
  }, [routeId]);

  // The ladder is the default tab, and its archive/coverage block is the page stamp, so it
  // is fetched once on entry regardless of which tab is open.
  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    getLadder(routeId)
      .then((d) => !cancelled && setLadder(d))
      .catch(() => !cancelled && setLadderErr("Live ladder unavailable right now."));
    return () => {
      cancelled = true;
    };
  }, [routeId]);

  // …and refreshed ONLY while it is the visible tab. Nothing polls in the background.
  useEffect(() => {
    if (tab !== "ladder" || !routeId) return;
    let cancelled = false;
    const t = setInterval(() => {
      getLadder(routeId)
        .then((d) => !cancelled && setLadder(d))
        .catch(() => {
          /* transient — the previous frame stays on screen with its own age stamp */
        });
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [routeId, tab]);

  useEffect(() => {
    if (tab !== "spacing" || !routeId || spacing) return;
    let cancelled = false;
    getSpacing(routeId)
      .then((d) => !cancelled && setSpacing(d))
      .catch(() => !cancelled && setSpacingErr("Stop spacing unavailable for this route."));
    return () => {
      cancelled = true;
    };
  }, [routeId, tab, spacing]);

  useEffect(() => {
    if (tab !== "slow" || !routeId || slow) return;
    let cancelled = false;
    getSlowSpots(routeId)
      .then((d) => !cancelled && setSlow(d))
      .catch(() => !cancelled && setSlowErr("Slow spots unavailable for this route."));
    return () => {
      cancelled = true;
    };
  }, [routeId, tab, slow]);

  const meta = ladder?.meta ?? slow?.meta ?? spacing?.meta ?? null;
  const display = meta?.short_name || routeId;
  const archive = ladder?.archive ?? slow?.archive ?? null;
  const coverage = ladder?.coverage ?? slow?.coverage ?? null;

  const shareHref = selStops.length
    ? `/workstation?routes=${encodeURIComponent(routeId)}&stops=${encodeURIComponent(
        selStops.map((s) => s.key).join(","),
      )}`
    : null;

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { label: "Observatory", to: "/observatory" },
          { label: display, to: `/observatory/${encodeURIComponent(routeId)}` },
          { label: "Corridor" },
        ]}
      />
      <ObsSubnav />

      <div className="crd-head">
        <h1>{display} corridor</h1>
        {meta?.long_name && (
          <span className="crd-sub">
            {meta.long_name}
            {meta.borough ? ` · ${meta.borough}` : ""}
          </span>
        )}
      </div>
      <div className="obs-crosslinks" aria-label="This route elsewhere">
        <Link className="obs-xchip" to={`/observatory/${encodeURIComponent(routeId)}`}>
          ← {display} dossier
        </Link>
        <Link className="obs-xchip" to="/observatory">
          All routes
        </Link>
      </div>

      <p className="crd-note" style={{ marginTop: "0.8rem" }}>
        One corridor, three questions. <strong>Ladder</strong>: where every bus on this
        route is right now, and which of them are running in a pack.{" "}
        <strong>Stop spacing</strong>: how far apart the stops actually are, gap by gap,
        so an unusually long or short one is visible rather than argued about.{" "}
        <strong>Slow spots</strong>: where buses actually crawl.
      </p>

      <div className="crd-tabs" role="tablist" aria-label="Corridor views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="crd-tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ArchiveStamp archive={archive} coverage={coverage} />

      {tab === "ladder" && (
        <>
          {selStops.length > 0 && (
            <div className="crd-selbar">
              <span>
                <strong>{selStops.length}</strong> of {CARD_CAP} stops selected
              </span>
              <span className="crd-sel-stops">
                {selStops.map((s) => s.name).join(" · ")}
              </span>
              {shareHref && (
                <Link className="nyc-dl-btn" to={shareHref}>
                  Open these stops on the map
                </Link>
              )}
              <button
                type="button"
                className="nyc-dl-btn"
                onClick={() => setSelStops([])}
              >
                Clear
              </button>
            </div>
          )}
          {ladder ? (
            <RouteLadder
              routeId={routeId}
              data={ladder}
              onStopClick={onStopClick}
              selectedStopIds={selectedStopIds}
            />
          ) : ladderErr ? (
            <div className="crd-err">{ladderErr}</div>
          ) : (
            <div className="crd-note">Loading the ladder…</div>
          )}
        </>
      )}

      {tab === "spacing" &&
        (spacing ? (
          <CorridorSpacing routeId={routeId} data={spacing} />
        ) : spacingErr ? (
          <div className="crd-err">{spacingErr}</div>
        ) : (
          <div className="crd-note">Loading stop spacing…</div>
        ))}

      {tab === "slow" &&
        (slow ? (
          <SlowSpots data={slow} />
        ) : slowErr ? (
          <div className="crd-err">{slowErr}</div>
        ) : (
          <div className="crd-note">Loading slow spots…</div>
        ))}
    </div>
  );
}
