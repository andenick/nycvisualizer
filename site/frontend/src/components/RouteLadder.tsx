// THE ROUTE LADDER — an ordered stop list for one route with the live buses interleaved
// at their true along-route positions.
//
// This is MTA Bus Time's single best idea and it is a PURE RENDERING of data the platform
// already holds: /api/autostats/ladder aggregates server-side and hands back a finished
// payload. Nothing here re-derives a statistic, and nothing here fetches per stop.
//
// Why it earns its place: **bunching becomes legible at a glance with no statistic to
// defend.** Two vehicle rows between the same pair of stops IS the finding — no index, no
// threshold anyone has to accept. The payload's own `bunching_note` states the one
// distance threshold used to draw the mark and says plainly that it is a rendering aid,
// not the derived bunching statistic; it is rendered verbatim as the caption.
//
// Honesty rules this component implements rather than assumes:
//   * PER DIRECTION, never averaged. The two directions of a route do not even use the
//     same stops. Each `directions[]` entry is its own labelled section, and the payload's
//     `direction_labelling` (why these are direction_id and not destination-sign text) is
//     shown rather than a headsign we would have had to invent.
//   * `live.vehicles_unplaced` is ALWAYS on screen with its `unplaced_reason`. Buses whose
//     along-shape offset was withheld are counted, never guessed onto the ladder — hiding
//     that count would make the ladder look more complete than it is.
//   * An uncaptured occupancy renders as an em-dash carrying the server's reason on hover,
//     never as a blank: at ~50 % fleet coverage a blank must never read as "empty bus".
//   * The "as of" stamp REPLACES its label with `STALE — N old` (the Ops-wall pattern,
//     copied below), so the word "live" can never sit on stale data.
//
// A STOP ROW IS A MAP STOP. Each LadderStop carries surveyed lat/lon, so a click here
// emits the same namespaced `"b:"+stop_id` key the workstation map's snap index mints and
// the host folds it in with the same `toggleCapped` primitive — one selection model, one
// shareable link. With no handler supplied the row still LINKS to the stop; it just does
// not select.
//
// COST: O(clicks), never O(stops). One delegated click handler for the whole ladder (no
// per-row listeners), one grouping pass per direction memoised on payload identity, and
// no fetching of anything per stop.

import {
  memo,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { Link } from "react-router-dom";
import type {
  LadderDirection,
  LadderResponse,
  LadderStop,
  LadderVehicle,
} from "../lib/api";

// ---------------------------------------------------------------------------
// The Ops-wall stamp, copied verbatim (OpsWallPage.tsx:13-38, 63-80) rather than
// reinvented. Two behaviours matter and both are load-bearing:
//   * fmtClock appends the DATE whenever the timestamp is not from today, so a week-old
//     timestamp can never be misread as a clock;
//   * Stamp REPLACES the label with "STALE — N old" rather than decorating it.
// (OpsWallPage keeps these module-local, so they are duplicated here, not re-exported.)
// ---------------------------------------------------------------------------
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

function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "unknown age";
  const min = seconds / 60;
  if (min < 90) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 36) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

export function Stamp({
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
    <span className={"ops-stamp crd-stamp" + (stale ? " stale" : "")}>
      <span className="dot" />
      {stale ? `STALE — ${fmtAge(ageS)} old` : label} {fmtClock(epoch)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatting. Precision matches the evidence: feet to the nearest 10 (the API already
// rounds), miles to 2 dp, minutes to 1 dp. No three-decimal figures anywhere.
// ---------------------------------------------------------------------------
const DASH = "—";
const round10 = (ft: number) => Math.round(ft / 10) * 10;
const fmtFt = (ft: number | null | undefined) =>
  ft == null || !Number.isFinite(ft) ? null : `${round10(ft).toLocaleString()} ft`;
const fmtMi = (mi: number | null | undefined) =>
  mi == null || !Number.isFinite(mi) ? null : `${mi.toFixed(2)} mi`;
const fmtMin = (m: number | null | undefined) =>
  m == null || !Number.isFinite(m) ? null : `${m.toFixed(1)} min`;
const fmtPct = (p: number | null | undefined) =>
  p == null || !Number.isFinite(p) ? null : `${p.toFixed(1)}%`;

/** Raw ft + miles for a title attribute — the phrase is what's rendered, but the numbers
 *  behind it stay one hover away (the payload's own `vocabulary_note` promises this). */
function rawDistance(ft: number | null, mi: number | null): string {
  const a = fmtFt(ft);
  const b = fmtMi(mi);
  if (a && b) return `${a} (${b}) along the route`;
  return a ?? b ?? "distance along the route not published";
}

/** The namespaced selection key the workstation's snap index mints for a bus stop
 *  (`buildSnapIndex` in lib/stopGeo.ts uses "b:" + stop_id). Exported so a ladder click
 *  and a map click cannot drift apart. */
export const ladderStopKey = (stop: { stop_id: string }) => "b:" + stop.stop_id;

/** Where a stop row points when the host supplies no click handler: the same stop,
 *  preselected on the workstation map, in the workstation's own URL vocabulary
 *  (`?routes=…&stops=b:…`) — so the fallback link and a click produce the same view. */
const workstationHref = (routeId: string, stop: LadderStop) =>
  `/workstation?routes=${encodeURIComponent(routeId)}&stops=${encodeURIComponent(
    ladderStopKey(stop),
  )}`;

// ---------------------------------------------------------------------------

export interface RouteLadderProps {
  routeId: string;
  data: LadderResponse;
  /** Supplied by the host when a ladder click should SELECT the stop. The host is
   *  expected to fold it in with `toggleCapped` from lib/stopGeo, keyed by
   *  `ladderStopKey(stop)`, so this behaves exactly like clicking the map's stop dot. */
  onStopClick?: (stop: LadderStop) => void;
  /** Namespaced keys (`"b:"+stop_id`) currently selected — the same set the map holds. */
  selectedStopIds?: Set<string>;
}

/** Vehicles grouped by the stop they sit AFTER. `after_stop_index === -1` means the bus is
 *  before the first stop of the shape; those render above stop 1 rather than vanishing. */
function groupVehicles(dir: LadderDirection): Map<number, LadderVehicle[]> {
  const m = new Map<number, LadderVehicle[]>();
  for (const v of dir.vehicles) {
    const arr = m.get(v.after_stop_index);
    if (arr) arr.push(v);
    else m.set(v.after_stop_index, [v]);
  }
  return m;
}

function VehicleLine({ v }: { v: LadderVehicle }) {
  const bunched = (v.bunched_with?.length ?? 0) > 0;
  const occ = v.occupancy;
  const eta = fmtMin(v.eta_next_stop_min_est);
  const delay = v.mta_delay_min;
  return (
    <div className="crd-veh">
      <span className="crd-veh-id" title={v.trip_id ? `trip ${v.trip_id}` : undefined}>
        {v.vehicle_id}
      </span>
      <span
        className="crd-veh-dist"
        title={rawDistance(v.distance_to_next_stop_ft, v.distance_to_next_stop_miles)}
      >
        {v.presentable_distance}
      </span>
      {eta && (
        <span className="crd-chip" title={v.speed_basis ? `speed basis: ${v.speed_basis}` : undefined}>
          ~{eta} to next stop
        </span>
      )}
      {/* Crowding. `captured:false` carries the reason; an em-dash with that reason on
          hover is the only honest rendering at ~50 % fleet coverage. A blank is not. */}
      {occ?.captured ? (
        <span className="crd-chip" title={occ.basis ?? undefined}>
          {occ.status_label ?? "occupancy reported"}
          {occ.passenger_count != null ? ` · ${occ.passenger_count} aboard` : ""}
          {occ.load_pct != null ? ` (${Math.round(occ.load_pct)}% of capacity)` : ""}
        </span>
      ) : (
        <span className="crd-chip crd-dim" title={occ?.not_captured ?? undefined}>
          crowding {DASH}
        </span>
      )}
      {/* MTA's OWN TripUpdate.delay, positive = late. Never this platform's reconstructed
          adherence — `mta_delay_basis` rides in the tooltip so the two cannot merge. */}
      {delay != null ? (
        <span
          className={"crd-chip " + (delay > 0 ? "late" : delay < 0 ? "early" : "")}
          title={v.mta_delay_basis ?? undefined}
        >
          MTA delay {delay > 0 ? "+" : ""}
          {delay.toFixed(1)} min {delay > 0 ? "late" : delay < 0 ? "early" : "on time"}
        </span>
      ) : (
        <span className="crd-chip crd-dim" title={v.mta_delay_absent_reason ?? undefined}>
          MTA delay {DASH}
        </span>
      )}
      {bunched && (
        <span className="crd-chip bunched" title={`bunched with ${v.bunched_with.join(", ")}`}>
          BUNCHED with {v.bunched_with.join(", ")}
        </span>
      )}
      {v.age_s != null && (
        <span className="crd-sec" title={`position reported ${fmtClock(v.timestamp)}`}>
          {v.age_s}s ago
        </span>
      )}
    </div>
  );
}

function StopRows({
  dir,
  routeId,
  selectable,
  selectedStopIds,
}: {
  dir: LadderDirection;
  routeId: string;
  selectable: boolean;
  selectedStopIds?: Set<string>;
}) {
  const byStop = useMemo(() => groupVehicles(dir), [dir]);
  const rows: ReactElement[] = [];

  const pushVehicles = (idx: number) => {
    const vs = byStop.get(idx);
    if (!vs) return;
    for (const v of vs) {
      rows.push(
        <tr
          key={"v:" + v.vehicle_id}
          className={"crd-vrow" + ((v.bunched_with?.length ?? 0) > 0 ? " is-bunched" : "")}
        >
          <td />
          <td colSpan={3}>
            <VehicleLine v={v} />
          </td>
        </tr>,
      );
    }
  };

  // Buses sitting before the first stop of the shape.
  pushVehicles(-1);

  for (const s of dir.stops) {
    const key = ladderStopKey(s);
    const sel = selectedStopIds?.has(key) ?? false;
    const hasCoords = s.lat != null && s.lon != null;
    const clickable = selectable && hasCoords;
    rows.push(
      <tr
        key={"s:" + s.stop_id + ":" + s.index}
        className={
          "crd-stoprow" + (clickable ? " is-clickable" : "") + (sel ? " is-selected" : "")
        }
        data-stop-index={clickable ? s.index : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-pressed={clickable ? sel : undefined}
        title={
          clickable
            ? sel
              ? "Selected — click to remove (same rule as the map)"
              : "Click to select this stop, exactly as on the map"
            : undefined
        }
      >
        <td className="crd-idx">{s.index + 1}</td>
        <td>
          {clickable ? (
            <span className="crd-stopname">{s.stop_name}</span>
          ) : (
            <Link className="crd-stopname" to={workstationHref(routeId, s)}>
              {s.stop_name}
            </Link>
          )}
          <span className="crd-stopid">#{s.stop_id}</span>
          {selectable && !hasCoords && (
            <span className="crd-nc" title="This stop's coordinates are not in this payload, so it cannot join a map selection.">
              {" "}
              coordinates not captured
            </span>
          )}
        </td>
        <td style={{ textAlign: "right" }}>
          {fmtFt(s.spacing_from_prev_ft) ?? DASH}
        </td>
        <td className="crd-nextbus">
          {s.next_vehicle ? (
            <span
              title={rawDistance(
                s.next_vehicle.distance_ft,
                s.next_vehicle.distance_miles,
              )}
            >
              {s.next_vehicle.presentable_distance}
              {s.next_vehicle.eta_min_est != null && (
                <span className="crd-sec">
                  {" "}
                  · ~{fmtMin(s.next_vehicle.eta_min_est)}
                </span>
              )}
            </span>
          ) : (
            DASH
          )}
        </td>
      </tr>,
    );
    pushVehicles(s.index);
  }
  return <>{rows}</>;
}

const DirectionBlock = memo(function DirectionBlock({
  dir,
  routeId,
  onStopClick,
  selectedStopIds,
}: {
  dir: LadderDirection;
  routeId: string;
  onStopClick?: (stop: LadderStop) => void;
  selectedStopIds?: Set<string>;
}) {
  // ONE delegated handler for the whole direction — never one listener per row. The row
  // carries its index in a data attribute and the lookup is O(1) in the stop array.
  const activate = useCallback(
    (target: EventTarget | null) => {
      if (!onStopClick) return;
      const el = (target as HTMLElement | null)?.closest?.("tr[data-stop-index]");
      if (!el) return;
      const i = Number((el as HTMLElement).dataset.stopIndex);
      if (!Number.isFinite(i)) return;
      const stop = dir.stops[i];
      if (stop) onStopClick(stop);
    },
    [dir, onStopClick],
  );
  const onClick = useCallback(
    (e: ReactMouseEvent) => activate(e.target),
    [activate],
  );
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      activate(e.target);
    },
    [activate],
  );

  return (
    <section className="crd-panel">
      <div className="crd-dirhead">
        <h3>Direction {dir.direction_id}</h3>
        <span className="crd-dirmeta">
          shape {dir.shape_id} · {dir.n_stops} stops · {dir.n_vehicles} bus
          {dir.n_vehicles === 1 ? "" : "es"} on the ladder · {dir.n_bunched_pairs} bunched
          pair{dir.n_bunched_pairs === 1 ? "" : "s"}
          {dir.shape_length_ft != null && ` · ${fmtMi(dir.shape_length_ft / 5280)} long`}
        </span>
      </div>

      {dir.bunched_pairs.length > 0 && (
        <ul className="crd-pairs">
          {dir.bunched_pairs.map((p, i) => (
            <li key={i}>
              <strong>{p.follower_vehicle_id}</strong> is {fmtFt(p.gap_ft)} (
              {fmtMi(p.gap_miles)}) behind <strong>{p.leader_vehicle_id}</strong>
              {p.between_stops.filter(Boolean).length > 0 &&
                ` — between ${p.between_stops.filter(Boolean).join(" and ")}`}
            </li>
          ))}
        </ul>
      )}

      <div className="nyc-table-wrap">
        <table className="nyc-table crd-ladder-table">
          <caption className="crd-cap" style={{ captionSide: "bottom", textAlign: "left" }}>
            Stops in order along direction {dir.direction_id}; each bus sits between the two
            stops it is actually between.
          </caption>
          <thead>
            <tr>
              <th className="crd-idx">#</th>
              <th>Stop</th>
              <th style={{ textAlign: "right" }}>From previous</th>
              <th>Nearest bus behind</th>
            </tr>
          </thead>
          <tbody onClick={onClick} onKeyDown={onKeyDown}>
            <StopRows
              dir={dir}
              routeId={routeId}
              selectable={!!onStopClick}
              selectedStopIds={selectedStopIds}
            />
          </tbody>
        </table>
      </div>
    </section>
  );
});

function RouteLadder({ routeId, data, onStopClick, selectedStopIds }: RouteLadderProps) {
  const live = data.live;
  const crowding = data.crowding;
  const delay = data.mta_delay;
  const vocabulary = data.vocabulary;

  if (data.error) {
    return <div className="crd-err">No ladder for this route: {data.error}</div>;
  }

  return (
    <div className="crd-ladder">
      <div className="crd-panel">
        <div className="crd-ladder-live">
          {live && (
            <Stamp
              label={live.source === "live" ? "live" : live.source || "unknown source"}
              epoch={live.as_of}
              stale={live.stale}
              ageS={live.age_s}
            />
          )}
          {live && (
            <span className="crd-count">
              <strong>{live.vehicles_placed_on_ladder}</strong> of{" "}
              <strong>{live.vehicles_on_route}</strong> buses on this route placed on the
              ladder · <strong>{live.vehicles_unplaced}</strong> unplaced
            </span>
          )}
        </div>
        {/* The unplaced count is never hidden, and never without its reason. */}
        {live?.unplaced_reason && <p className="crd-note">{live.unplaced_reason}</p>}

        {/* Crowding coverage, once per view. */}
        {crowding && (
          <p className="crd-note">
            Crowding: {crowding.vehicles_reporting_occupancy} of{" "}
            {crowding.vehicles_on_ladder} buses report occupancy
            {crowding.coverage_pct != null && ` (${fmtPct(crowding.coverage_pct)} coverage)`}
            {crowding.vehicles_reporting_headcount > 0 &&
              `, ${crowding.vehicles_reporting_headcount} of them with a head-count`}
            {crowding.median_passengers != null &&
              `; median ${crowding.median_passengers} aboard`}
            . {crowding.not_captured_note}
          </p>
        )}

        {/* MTA's own published schedule deviation, named as theirs. */}
        {delay && (
          <p className="crd-note">
            MTA schedule deviation: published for {delay.vehicles_with_published_delay} bus
            {delay.vehicles_with_published_delay === 1 ? "" : "es"}
            {delay.coverage_pct != null && ` (${fmtPct(delay.coverage_pct)} of the ladder)`}
            {delay.median_delay_min != null &&
              `; median ${delay.median_delay_min > 0 ? "+" : ""}${delay.median_delay_min.toFixed(1)} min`}
            . {delay.basis_note} {delay.absent_note}
          </p>
        )}

        {/* Why directions are numbered rather than signed — the payload's own words. */}
        {data.direction_labelling && <p className="crd-note">{data.direction_labelling}</p>}

        {/* The bunching mark's caption, verbatim: one stated threshold, and an explicit
            statement that this is a rendering aid, not the derived statistic. */}
        {data.bunching_note && (
          <p className="crd-cap">
            <span className="crd-chip bunched">BUNCHED</span> {data.bunching_note}
          </p>
        )}
        {data.eta_note && <p className="crd-cap">{data.eta_note}</p>}

        {vocabulary && Object.keys(vocabulary).length > 0 && (
          <details className="crd-details">
            <summary>What these distance phrases mean</summary>
            <dl>
              {Object.entries(vocabulary).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {data.vocabulary_note && <p className="crd-cap">{data.vocabulary_note}</p>}
          </details>
        )}
      </div>

      {data.directions.length === 0 && (
        <div className="crd-err">
          No direction on this route has a canonical GTFS shape, so no ladder can be drawn.
        </div>
      )}
      {data.directions.map((d) => (
        <DirectionBlock
          key={d.direction_id + ":" + d.shape_id}
          dir={d}
          routeId={routeId}
          onStopClick={onStopClick}
          selectedStopIds={selectedStopIds}
        />
      ))}
    </div>
  );
}

export default memo(RouteLadder);
