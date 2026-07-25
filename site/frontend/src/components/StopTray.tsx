// W11 — THE STOP TRAY: persistent multi-select stop cards + the measure readout.
//
// This is the anchor of the measure feature, and it inverts Google's model deliberately.
// Google measures *coordinates*, so measuring is its own mode. Our points are *entities*
// with a stop code, a name and a route list — so **measurement is a mode of the stop
// card**, not a separate tool. The planner's flow (from a named user, Taylor) is:
// click a stop → read it → click another → keep both → compare → measure. Selection
// therefore persists, and the measure path IS the selection, in click order.
//
// Design decisions carried in from `analysis/MEASURE_DISTANCE_DESIGN_20260725.md`:
//   * **The stop code is the headline** — large, copyable. It is the number a planner
//     carries into a meeting, not a technical detail.
//   * **The readout docks and does NOT grow.** All five products piloted dock their
//     total in fixed chrome; Google's card is byte-identical at 3, 5, 10 and 20 points.
//     Incremental detail lives on the geometry (see WorkstationPage's measure layer),
//     never in a growing list here.
//   * **Both units at once, no toggle** — feet primary, miles in parentheses.
//   * **Undo exists** (only CalTopo has one across the whole genre) and **Escape works**
//     (inert in Google, MapLibre and leaflet-measure alike).
//   * **No finish gesture.** CalTopo's ✓ *discards the answer*; `dblclick` is already
//     Leaflet's zoom. Leaving measure mode here keeps your stops and your number.
//   * **Absent fields read `not captured`**, never a blank or a zero — a planner has to
//     be able to tell "none" from "unknown".
//
// COST: this is ordinary React DOM, bounded by the selection cap (see CARD_CAP in
// WorkstationPage). It never touches the map, the flow engine, or the stop markers.

import { useEffect, useState } from "react";
import type { SnapStop } from "../lib/stopGeo";
import { fmtDistance, fmtFeet } from "../lib/stopGeo";

export interface MeasureLeg {
  fromKey: string;
  toKey: string;
  fromName: string;
  toName: string;
  straightFt: number;
  /** Stage 2 — set only when both stops genuinely share one route AND direction. */
  alongFt?: number | null;
  alongRoute?: string | null;
  alongDirLabel?: string | null;
  /** Why an along-route figure is absent, in the planner's words (never a code). */
  alongNote?: string | null;
  /** Stage 3 — OTP sidewalk routing, an explicit per-leg action. */
  walkFt?: number | null;
  walkMin?: number | null;
  walkNote?: string | null;
  walkState?: "idle" | "loading" | "done" | "unavailable";
}

export interface StopTrayProps {
  stops: SnapStop[];
  cap: number;
  measuring: boolean;
  legs: MeasureLeg[];
  totalStraightFt: number;
  totalAlongFt: number | null;
  totalAlongNote: string | null;
  /** null = no stop is under the cursor right now. */
  hoverName: string | null;
  colorFor: (s: SnapStop) => string;
  onToggleMeasure: () => void;
  onRemove: (key: string) => void;
  onUndo: () => void;
  onClear: () => void;
  /** Stage 3 — rendered only when supplied. */
  onCopyTable?: () => void;
  onExport?: (fmt: "csv" | "xlsx" | "parquet") => void;
  onShare?: () => void;
  onWalk?: (legIndex: number) => void;
  detailFor?: (key: string) => StopDetail | "loading" | undefined;
  exportNote?: string | null;
}

/** Server-side stop detail (Stage 2). Every field is nullable and every null is
 *  rendered as `not captured` — the honesty contract, not a formatting choice. */
export interface StopDetail {
  stop_id: string;
  stop_name: string | null;
  borough: string | null;
  /** One row per (route, direction) the stop is served by. */
  directions: {
    route_id: string;
    direction_id: number | null;
    direction_label: string | null;
    stop_seq: number | null;
    offset_ft: number | null;
    prev_stop_name: string | null;
    prev_spacing_ft: number | null;
    next_stop_name: string | null;
    next_spacing_ft: number | null;
    observed_headway_min: number | null;
    scheduled_headway_min: number | null;
    headway_deviation_min: number | null;
    bunching_index: number | null;
    worst_hour: number | null;
    worst_hour_deviation_min: number | null;
    n_headways: number | null;
    observed_days: number | null;
    preliminary: boolean | null;
  }[];
  sai: {
    sai: number | null;
    sai_pctile: number | null;
    sheltered: boolean | null;
    ramps_150ft: number | null;
    sidewalk_sqft_400m: number | null;
    walkshed_population: number | null;
    safety: number | null;
    comfort: number | null;
  } | null;
  wheelchair_boarding: string | null;
  active_changes: string[] | null;
  /** Field name -> why it is absent. Rendered verbatim. */
  not_captured: Record<string, string>;
  archive_depth_days: number | null;
  as_of: string | null;
}

const NC = <span className="stray-nc">not captured</span>;

function num(v: number | null | undefined, suffix = "", digits = 1) {
  if (v == null || !isFinite(v)) return NC;
  return (
    <span className="stray-v">
      {digits === 0 ? Math.round(v).toLocaleString() : v.toFixed(digits)}
      {suffix}
    </span>
  );
}

function CopyCode({ code }: { code: string }) {
  const [hit, setHit] = useState(false);
  useEffect(() => {
    if (!hit) return;
    const t = setTimeout(() => setHit(false), 1400);
    return () => clearTimeout(t);
  }, [hit]);
  return (
    <button
      type="button"
      className={"stray-code" + (hit ? " copied" : "")}
      title="Copy this stop code"
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(code);
          setHit(true);
        } catch {
          /* clipboard blocked — the code is still on screen and selectable */
        }
      }}
    >
      {code}
      <span className="stray-code-hint">{hit ? "copied" : "copy"}</span>
    </button>
  );
}

function hhmm(h: number | null): string {
  if (h == null) return "—";
  return String(h).padStart(2, "0") + ":00";
}

function DetailBlock({ d }: { d: StopDetail }) {
  return (
    <div className="stray-detail">
      {d.directions.length === 0 ? (
        <div className="stray-line stray-dim">
          No per-direction service record for this stop — {NC}
        </div>
      ) : (
        d.directions.map((r, i) => (
          <div className="stray-dir" key={i}>
            <div className="stray-dir-head">
              <strong>{r.route_id}</strong>
              <span className="stray-dir-lbl">{r.direction_label ?? "direction not captured"}</span>
              {r.preliminary && (
                <span className="stray-prelim" title="fewer than 14 observed days behind this figure">
                  prelim
                </span>
              )}
            </div>
            <div className="stray-kv">
              <span>Gap now</span>
              {num(r.observed_headway_min, " min")}
              <span>Gap planned</span>
              {num(r.scheduled_headway_min, " min")}
              <span>Bunching</span>
              {num(r.bunching_index, "", 2)}
              <span>Worst hour</span>
              {r.worst_hour == null ? (
                NC
              ) : (
                <span className="stray-v">
                  {hhmm(r.worst_hour)}
                  {r.worst_hour_deviation_min != null
                    ? ` (+${r.worst_hour_deviation_min.toFixed(1)} min)`
                    : ""}
                </span>
              )}
              <span>Stop #</span>
              {r.stop_seq == null ? NC : <span className="stray-v">{r.stop_seq}</span>}
              <span>Spacing back</span>
              {r.prev_spacing_ft == null ? NC : <span className="stray-v">{fmtFeet(r.prev_spacing_ft)}</span>}
              <span>Spacing on</span>
              {r.next_spacing_ft == null ? NC : <span className="stray-v">{fmtFeet(r.next_spacing_ft)}</span>}
            </div>
          </div>
        ))
      )}
      <div className="stray-sub">Stop environment</div>
      <div className="stray-kv">
        <span>Accessibility (SAI)</span>
        {d.sai ? num(d.sai.sai, "", 1) : NC}
        <span>Shelter</span>
        {d.sai?.sheltered == null ? NC : <span className="stray-v">{d.sai.sheltered ? "yes" : "no"}</span>}
        <span>Curb ramps ≤150 ft</span>
        {d.sai ? num(d.sai.ramps_150ft, "", 0) : NC}
        <span>Sidewalk ≤400 m</span>
        {d.sai ? num(d.sai.sidewalk_sqft_400m, " sq ft", 0) : NC}
        <span>People ≤400 m</span>
        {d.sai ? num(d.sai.walkshed_population, "", 0) : NC}
        <span>Wheelchair boarding</span>
        {d.wheelchair_boarding ? <span className="stray-v">{d.wheelchair_boarding}</span> : NC}
      </div>
      {d.active_changes && d.active_changes.length > 0 && (
        <div className="stray-line stray-dim">
          Recent service changes: {d.active_changes.slice(0, 2).join(" · ")}
        </div>
      )}
      {Object.keys(d.not_captured).length > 0 && (
        <div className="stray-line stray-dim">
          {Object.entries(d.not_captured)
            .slice(0, 3)
            .map(([k, why]) => `${k}: ${why}`)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

export default function StopTray(p: StopTrayProps) {
  const n = p.stops.length;
  if (n === 0 && !p.measuring) return null;

  const nLegs = p.legs.length;
  const last = nLegs ? p.legs[nLegs - 1] : null;

  return (
    <div className="stray" role="region" aria-label="Selected stops and measurement">
      {/* ---------------- header: count, cap, and the mode controls ---------------- */}
      <div className="stray-head">
        <span className="stray-title">Stops</span>
        <span className="stray-count" aria-live="polite">
          {n} of {p.cap}
        </span>
        <button
          type="button"
          className={"stray-btn stray-measure" + (p.measuring ? " on" : "")}
          aria-pressed={p.measuring}
          onClick={p.onToggleMeasure}
        >
          ⟷ Measure
        </button>
        {p.onShare && (
          <button type="button" className="stray-btn" onClick={p.onShare} title="Copy a link to this selection">
            🔗 Link
          </button>
        )}
        {p.onCopyTable && (
          <button type="button" className="stray-btn" onClick={p.onCopyTable} title="Copy the selection as a table">
            ⧉ Copy
          </button>
        )}
        {p.onExport && (
          <span className="stray-exp">
            <button type="button" className="stray-btn" onClick={() => p.onExport?.("csv")}>
              ↓ CSV
            </button>
            <button type="button" className="stray-btn" onClick={() => p.onExport?.("xlsx")}>
              XLSX
            </button>
            <button type="button" className="stray-btn" onClick={() => p.onExport?.("parquet")}>
              Parquet
            </button>
          </span>
        )}
        <button type="button" className="stray-btn stray-x" onClick={p.onClear} aria-label="Clear all selected stops">
          ✕
        </button>
      </div>

      {/* ---------------- the measure readout: DOCKED, and it never grows ----------
          Constant height at 2 stops and at 10. The per-leg numbers live on the map
          geometry, not here — that is Google's structural insight and it is right. */}
      {p.measuring && (
        <div className="stray-measure-card" role="status" aria-live="polite">
          <div className="stray-mrow">
            <span className="stray-mlbl">Straight line</span>
            <span className="stray-mval">
              {n < 2 ? <span className="stray-dash">—</span> : fmtDistance(p.totalStraightFt)}
            </span>
          </div>
          <div className="stray-mrow">
            <span className="stray-mlbl">
              {p.totalAlongFt != null && last?.alongRoute
                ? `Along the ${last.alongRoute}${last.alongDirLabel ? ", " + last.alongDirLabel : ""}`
                : "Along the route"}
            </span>
            <span className="stray-mval">
              {p.totalAlongFt != null ? (
                fmtDistance(p.totalAlongFt)
              ) : (
                <span className="stray-mnote">{p.totalAlongNote ?? "not measured in this build"}</span>
              )}
            </span>
          </div>
          {last && (last.walkState === "done" || last.walkState === "loading" || last.walkNote) && (
            <div className="stray-mrow">
              <span className="stray-mlbl">Walking · last leg</span>
              <span className="stray-mval">
                {last.walkState === "loading" ? (
                  <span className="stray-mnote">…</span>
                ) : last.walkFt != null ? (
                  <>
                    {fmtDistance(last.walkFt)}
                    {last.walkMin != null ? ` · ${Math.round(last.walkMin)} min` : ""}
                  </>
                ) : (
                  <span className="stray-mnote">{last.walkNote}</span>
                )}
              </span>
            </div>
          )}
          <div className="stray-mfoot">
            {n < 2 ? (
              <span>Click a stop to start measuring. Every stop on screen is a target.</span>
            ) : (
              <span>
                {n} stops · last leg {last?.fromName} → {last?.toName} {last ? fmtFeet(last.straightFt) : ""}
              </span>
            )}
          </div>
          <div className="stray-mfoot stray-dim">
            {p.hoverName ? (
              <>Next: {p.hoverName}</>
            ) : (
              <>Click a stop again to remove it · Ctrl+Z undo · Esc leaves measure mode and keeps your stops</>
            )}
          </div>
          <div className="stray-mactions">
            <button type="button" className="stray-btn" onClick={p.onUndo} disabled={n === 0}>
              ↺ Undo last stop
            </button>
            {p.onWalk && nLegs > 0 && (
              <button
                type="button"
                className="stray-btn"
                onClick={() => p.onWalk?.(nLegs - 1)}
                disabled={last?.walkState === "loading"}
              >
                🚶 Walking distance (last leg)
              </button>
            )}
          </div>
          <div className="stray-mprov">
            Measured between surveyed stop positions, not from live bus locations — stop geometry
            is precise to well under a foot, so these numbers are exact. The ~160–200&nbsp;ft floor
            on live vehicle tracking does not apply. Shown to the nearest 10&nbsp;ft, because a stop
            coordinate is one surveyed point for a ~40&nbsp;ft kerbside zone.
          </div>
        </div>
      )}

      {/* ---------------- the cards themselves ---------------- */}
      {n === 0 ? (
        <div className="stray-empty nyc-note">
          No stops selected yet. Click any stop dot on the map — cards stay up so you can compare
          several, and measuring works over whatever you have selected.
        </div>
      ) : (
        <div className="stray-cards">
          {p.stops.map((s, i) => {
            const d = p.detailFor?.(s.key);
            return (
              <div className={"stray-card stray-card--" + s.kind} key={s.key}>
                <div className="stray-card-head">
                  <span className="stray-idx" style={{ background: p.colorFor(s) }}>
                    {i + 1}
                  </span>
                  <CopyCode code={s.stopId} />
                  <button
                    type="button"
                    className="stray-card-x"
                    aria-label={`Remove ${s.name}`}
                    onClick={() => p.onRemove(s.key)}
                  >
                    ✕
                  </button>
                </div>
                <div className="stray-code-lbl">
                  {s.kind === "bus" ? "MTA bus stop code" : "Subway station id"}
                </div>
                <div className="stray-name">{s.name}</div>
                <div className="stray-routes">
                  {s.routes.length ? s.routes.join(" · ") : NC}
                </div>
                <div className="stray-coord">
                  {s.lat.toFixed(6)}, {s.lon.toFixed(6)}
                </div>
                {d === "loading" ? (
                  <div className="stray-line stray-dim">Loading stop detail…</div>
                ) : d ? (
                  <DetailBlock d={d} />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {p.exportNote && <div className="stray-note nyc-note">{p.exportNote}</div>}
    </div>
  );
}
