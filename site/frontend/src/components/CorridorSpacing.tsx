// CORRIDOR STOP SPACING — every consecutive stop gap along a route, in order, per
// direction.
//
// Measuring two stops answers one question. Seeing EVERY consecutive gap at once answers
// the question underneath it: **where is this route's spacing wrong?** That question is
// only answerable when the whole corridor is on screen in order, which is why this view
// pairs a full table with a compact in-order strip — the strip carries the shape, the
// table carries the numbers.
//
// Honesty rules this component implements rather than assumes:
//   * PER DIRECTION, never averaged. The two directions do not use the same stops, and an
//     average would describe neither — the payload's `per_direction_note` says so and is
//     rendered verbatim.
//   * The outlier flags are DISTRIBUTION-RELATIVE — Tukey fences on this direction's own
//     gaps, explicitly not an external spacing standard this platform does not hold.
//     `fences.rule` is on screen as the caption, in the payload's own words.
//   * `fences.applied === false` is honoured: no thresholds are shown and every gap reads
//     `not flagged`, with the server's `not_applied_reason`. A lower fence at or below
//     zero means nothing can be flagged short, and `short_fence_note` says that in a
//     sentence rather than printing a negative distance.
//   * `precision_note` is rendered because this is one of the few places the platform may
//     claim precision: surveyed static geometry (~0.3–0.4 ft), unlike anything derived
//     from live vehicle positions. `depth_note` is rendered because this view uses no
//     observed archive data at all, so archive depth does not limit it.
//   * Downloads are CSV / XLSX / Parquet — no JSON, per the estate's download standard.
//     The table is assembled SERVER-SIDE with its provenance inside the file; nothing here
//     builds a CSV in the browser.
//
// COST: the strip is plain divs — no charting library, no SVG animation, no map. Bars are
// derived once per direction with a single pass memoised on payload identity.

import { memo, useMemo } from "react";
import { spacingExportUrl, type SpacingDirection, type SpacingGap, type SpacingResponse } from "../lib/api";

const DASH = "—";
// Precision matches the evidence: feet to the nearest 10 (the API already rounds there,
// because one surveyed coordinate stands for a ~40 ft kerbside zone), miles to 2 dp.
// Thousands separators, as everywhere else distances are shown on this site.
const round10 = (ft: number) => Math.round(ft / 10) * 10;
const fmtFt = (ft: number | null | undefined) =>
  ft == null || !Number.isFinite(ft) ? null : `${round10(ft).toLocaleString()} ft`;
const fmtMi = (mi: number | null | undefined) =>
  mi == null || !Number.isFinite(mi) ? null : `${mi.toFixed(2)} mi`;
const fmtSigned = (ft: number | null | undefined) =>
  ft == null || !Number.isFinite(ft)
    ? null
    : `${ft > 0 ? "+" : ""}${round10(ft).toLocaleString()} ft`;

const FLAG_LABEL: Record<string, string> = {
  long: "long",
  short: "short",
  typical: "typical",
  not_flagged: "not flagged",
};

function flagOf(g: SpacingGap): string {
  return g.flag ?? "not_flagged";
}

function ExportRow({ routeId, direction }: { routeId: string; direction?: number }) {
  return (
    <div className="crd-dl">
      <span className="crd-dl-label">
        Download {direction == null ? "all directions" : `direction ${direction}`}:
      </span>
      {(["csv", "xlsx", "parquet"] as const).map((f) => (
        <a
          key={f}
          className="nyc-dl-btn"
          href={spacingExportUrl(routeId, f, direction)}
          // The file is assembled server-side, provenance inside it. No JSON download.
          download
        >
          {f.toUpperCase()}
        </a>
      ))}
    </div>
  );
}

function GapTable({
  gaps,
  caption,
  showIndex,
}: {
  gaps: SpacingGap[];
  caption: string;
  showIndex: boolean;
}) {
  return (
    <div className="nyc-table-wrap">
      <table className="nyc-table">
        <caption className="crd-cap" style={{ captionSide: "bottom", textAlign: "left" }}>
          {caption}
        </caption>
        <thead>
          <tr>
            {showIndex && <th className="crd-idx">#</th>}
            <th>From</th>
            <th>To</th>
            <th style={{ textAlign: "right" }}>Spacing</th>
            <th style={{ textAlign: "right" }}>vs median</th>
            <th>Flag</th>
          </tr>
        </thead>
        <tbody>
          {gaps.map((g) => {
            const fl = flagOf(g);
            return (
              <tr key={g.index}>
                {showIndex && <td className="crd-idx">{g.index + 1}</td>}
                <td>{g.from_stop_name}</td>
                <td>{g.to_stop_name}</td>
                <td style={{ textAlign: "right" }}>
                  {fmtFt(g.spacing_ft) ?? DASH}
                  <span className="crd-sec"> {fmtMi(g.spacing_miles) ?? ""}</span>
                </td>
                <td style={{ textAlign: "right" }}>{fmtSigned(g.deviation_from_median_ft) ?? DASH}</td>
                <td className={"crd-flagcell flag-" + fl}>{FLAG_LABEL[fl] ?? fl}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DirectionBlock = memo(function DirectionBlock({
  routeId,
  dir,
}: {
  routeId: string;
  dir: SpacingDirection;
}) {
  const st = dir.stats;
  const fences = dir.fences;

  // The strip: one bar per gap, in route order, height ∝ spacing, coloured ONLY by flag.
  // Cheap by construction — divs, one pass, no library and no animation.
  const bars = useMemo(() => {
    const max = dir.gaps.reduce((m, g) => Math.max(m, g.spacing_ft ?? 0), 0) || 1;
    return dir.gaps.map((g) => ({
      key: g.index,
      h: Math.max(3, Math.round((100 * (g.spacing_ft ?? 0)) / max)),
      flag: flagOf(g),
      title: `${g.from_stop_name} → ${g.to_stop_name}: ${fmtFt(g.spacing_ft) ?? "spacing not captured"}${
        g.spacing_miles != null ? ` (${fmtMi(g.spacing_miles)})` : ""
      } · ${FLAG_LABEL[flagOf(g)] ?? flagOf(g)}`,
    }));
  }, [dir]);

  const counts = dir.flag_counts ?? {};

  return (
    <section className="crd-panel">
      <div className="crd-dirhead">
        <h3>Direction {dir.direction_id}</h3>
        <span className="crd-dirmeta">
          shape {dir.shape_id} · {dir.n_stops} stops · {st.n_gaps} consecutive gap
          {st.n_gaps === 1 ? "" : "s"}
        </span>
      </div>

      <div className="crd-stats">
        <div className="crd-stat">
          <div className="crd-stat-v">{fmtFt(st.median_ft) ?? DASH}</div>
          <div className="crd-stat-l">Median gap</div>
          <div className="crd-stat-s">{fmtMi(st.median_miles) ?? ""}</div>
        </div>
        <div className="crd-stat">
          <div className="crd-stat-v">{fmtFt(st.min_ft) ?? DASH}</div>
          <div className="crd-stat-l">Shortest</div>
        </div>
        <div className="crd-stat">
          <div className="crd-stat-v">{fmtFt(st.max_ft) ?? DASH}</div>
          <div className="crd-stat-l">Longest</div>
        </div>
        <div className="crd-stat">
          <div className="crd-stat-v">{fmtFt(st.iqr_ft) ?? DASH}</div>
          <div className="crd-stat-l">IQR</div>
          <div className="crd-stat-s">
            q1 {fmtFt(st.q1_ft) ?? DASH} · q3 {fmtFt(st.q3_ft) ?? DASH}
          </div>
        </div>
        <div className="crd-stat">
          <div className="crd-stat-v">{fmtMi(st.total_miles) ?? DASH}</div>
          <div className="crd-stat-l">Total length</div>
        </div>
        <div className="crd-stat">
          <div className="crd-stat-v">{st.n_gaps}</div>
          <div className="crd-stat-l">Gaps</div>
        </div>
      </div>

      {/* The shape of the corridor, in order. Colour carries the flag and nothing else. */}
      <div className="crd-strip-wrap">
        <div
          className="crd-strip"
          role="img"
          aria-label={`Consecutive stop spacing along direction ${dir.direction_id}, in route order: ${st.n_gaps} gaps, median ${
            fmtFt(st.median_ft) ?? "not captured"
          }, longest ${fmtFt(st.max_ft) ?? "not captured"}.`}
        >
          {bars.map((b) => (
            <div
              key={b.key}
              className={"crd-bar flag-" + b.flag}
              style={{ height: `${b.h}%` }}
              title={b.title}
            />
          ))}
        </div>
      </div>
      <div className="crd-striplabels">
        <span>{dir.gaps[0]?.from_stop_name ?? ""}</span>
        <span>{dir.gaps[dir.gaps.length - 1]?.to_stop_name ?? ""}</span>
      </div>
      <div className="crd-flags">
        {(["long", "short", "typical", "not_flagged"] as const).map((f) =>
          counts[f] ? (
            <span key={f} className="crd-flagchip">
              <span className={"crd-sw flag-" + f} />
              {FLAG_LABEL[f]}: {counts[f]}
            </span>
          ) : null,
        )}
      </div>

      {/* The rule, on screen, in the payload's own words — distribution-relative, and
          explicitly NOT an external spacing standard. */}
      <p className="crd-cap">{fences.rule}</p>
      {fences.applied ? (
        <p className="crd-cap">
          Flagged long above {fmtFt(fences.long_above_ft) ?? DASH}
          {fences.short_below_ft != null
            ? `; flagged short below ${fmtFt(fences.short_below_ft)}.`
            : "."}
          {/* A lower fence at or below zero: render the sentence, never a negative
              distance. */}
          {fences.short_fence_note ? ` ${fences.short_fence_note}` : ""}
        </p>
      ) : (
        <p className="crd-cap">
          No gap in this direction is flagged
          {fences.not_applied_reason ? ` — ${fences.not_applied_reason}` : "."} (at least{" "}
          {fences.min_gaps_to_flag} gaps are needed before the fences are applied.)
        </p>
      )}

      {dir.longest.length > 0 && (
        <GapTable
          gaps={dir.longest}
          showIndex={false}
          caption={`The five longest gaps in direction ${dir.direction_id}.`}
        />
      )}
      {dir.shortest.length > 0 && (
        <GapTable
          gaps={dir.shortest}
          showIndex={false}
          caption={`The five shortest gaps in direction ${dir.direction_id}.`}
        />
      )}

      <GapTable
        gaps={dir.gaps}
        showIndex
        caption={`Every consecutive gap in direction ${dir.direction_id}, in order along the route. Blank cells are not zero.`}
      />

      <ExportRow routeId={routeId} direction={dir.direction_id} />
    </section>
  );
});

export interface CorridorSpacingProps {
  routeId: string;
  data: SpacingResponse;
}

function CorridorSpacing({ routeId, data }: CorridorSpacingProps) {
  if (data.error) {
    return <div className="crd-err">No stop spacing for this route: {data.error}</div>;
  }
  return (
    <div className="crd-spacing">
      <div className="crd-panel">
        <h2 style={{ marginTop: 0 }}>Corridor stop spacing</h2>
        <p className="crd-note">{data.method}</p>
        <p className="crd-note">{data.per_direction_note}</p>
        {/* One of the few places this platform may claim precision — and it says why. */}
        <p className="crd-note">{data.precision_note}</p>
        <p className="crd-note">{data.depth_note}</p>
        <ExportRow routeId={routeId} />
        <p className="crd-cap">
          Downloads are assembled on the server with their provenance inside the file. CSV,
          Excel and Parquet only — a JSON download is deliberately not offered.
        </p>
      </div>

      {data.directions.length === 0 && (
        <div className="crd-err">
          No direction on this route has a canonical GTFS shape, so no spacing can be
          measured.
        </div>
      )}
      {data.directions.map((d) => (
        <DirectionBlock key={d.direction_id + ":" + d.shape_id} routeId={routeId} dir={d} />
      ))}
    </div>
  );
}

export default memo(CorridorSpacing);
