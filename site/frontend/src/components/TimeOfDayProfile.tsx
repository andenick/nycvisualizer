// TimeOfDayProfile — /api/autostats/profile, the strongest evidence base on the platform
// (619,814 published cells at route x direction x stop x hour, pooled into 24 local-hour
// buckets, each hour observed on several dates).
//
// TWO THINGS THIS COMPONENT WILL NOT DO, and they are the reason it looks like this:
//
//  1. NO DAY-OF-WEEK OR WEEK-OVER-WEEK VIEW, CONTROL OR TOGGLE. The archive holds one
//     observation per weekday and the single Tuesday is ~82% missing, so a weekday effect
//     is confounded 1:1 with the calendar date. The depth gate reports SIX qualifying days,
//     not nine partitions. The server publishes that refusal in /completeness's
//     `not_supported` list; adding a date axis here would walk around it. There is
//     deliberately no date control anywhere below.
//
//  2. A SUPPRESSED HOUR IS NEVER DRAWN AS A VALUE. Plotting a suppressed hour at zero
//     would read as "no wait at all", and simply leaving a hole would read as "nothing
//     happened". Suppressed hours are drawn as shaded bands across the full plot height,
//     carry a legend entry of their own, and every one of them is listed underneath with
//     the server's `suppressed_reason` verbatim.
//
// Charts go through ArkPlotly, which is the site's Universal Graph Contract component:
// Download CSV top-right, legend below the plot, one chart per row.
import { useEffect, useMemo, useState } from "react";
import { getProfile, type ProfileHour, type ProfileResponse } from "../lib/api";
import ArkPlotly from "../components/ArkPlotly";
import { fmtInt, fmtShare } from "./ArchiveCompletenessBanner";
import "../styles/autostats.css";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const hh = (h: number | null | undefined) =>
  h == null ? "—" : `${String(h).padStart(2, "0")}:00`;

/** Round a share/CV to the 2 dp the evidence supports (the server sends 3 dp). */
const r2 = (v: number | null | undefined) =>
  v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const r1 = (v: number | null | undefined) =>
  v == null || !isFinite(v) ? null : Math.round(v * 10) / 10;

/** Shaded band per suppressed hour, spanning the full plot height. Bands cannot be
 *  mistaken for a data point the way a marker at y=0 can. */
function suppressedShapes(hours: ProfileHour[]) {
  return hours
    .filter((h) => h.suppressed)
    .map((h) => ({
      type: "rect",
      xref: "x",
      yref: "paper",
      x0: h.local_hour - 0.5,
      x1: h.local_hour + 0.5,
      y0: 0,
      y1: 1,
      fillcolor: "rgba(225,87,89,0.14)",
      line: { width: 0 },
      layer: "below",
    }));
}

/** Legend-only trace so the shaded bands are NAMED in the legend rather than being an
 *  unexplained tint. An empty trace still renders a legend entry. */
const suppressedLegendTrace = {
  type: "scatter",
  mode: "markers",
  name: "hour suppressed — not published",
  x: [] as number[],
  y: [] as number[],
  marker: { color: "rgba(225,87,89,0.45)", symbol: "square", size: 12 },
};

export default function TimeOfDayProfile({
  route,
  borough,
  direction,
  heading = "Time-of-day reliability profile",
}: {
  route?: string;
  borough?: string;
  direction?: number;
  heading?: string;
}) {
  const [d, setD] = useState<ProfileResponse | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    getProfile({ route, borough, direction })
      .then((v) => live && setD(v))
      .catch(() => live && setErr(true));
    return () => {
      live = false;
    };
  }, [route, borough, direction]);

  const hours = useMemo(() => d?.hours ?? [], [d]);
  const suppressed = useMemo(() => hours.filter((h) => h.suppressed), [hours]);

  if (err)
    return (
      <div className="nyc-note">
        Time-of-day profile temporarily unavailable.
      </div>
    );
  if (!d) return null;

  const y = (f: (h: ProfileHour) => number | null) =>
    HOURS.map((n) => {
      const h = hours.find((x) => x.local_hour === n);
      return h && !h.suppressed ? f(h) : null;
    });

  const obs = y((h) => r1(h.median_headway_min));
  const sched = y((h) => r1(h.sched_median_headway_min ?? null));
  const cv = y((h) => r2(h.headway_cv));
  const bunch = y((h) => r2(h.bunched_gap_share));

  const csvRows = HOURS.map((n) => {
    const h = hours.find((x) => x.local_hour === n);
    return {
      local_hour: n,
      suppressed: h?.suppressed ? "true" : "false",
      suppressed_reason: h?.suppressed ? h.suppressed_reason ?? "" : "",
      n_headways: h?.n_headways ?? 0,
      n_cells: h?.n_cells ?? 0,
      median_headway_min: h && !h.suppressed ? r1(h.median_headway_min) : null,
      sched_median_headway_min: h && !h.suppressed ? r1(h.sched_median_headway_min ?? null) : null,
      headway_cv: h && !h.suppressed ? r2(h.headway_cv) : null,
      bunched_gap_share: h && !h.suppressed ? r2(h.bunched_gap_share) : null,
    };
  });

  const scope =
    d.route ??
    (d.borough ? d.borough : "every observed bus route citywide");
  const scopeSlug = (d.route ?? d.borough_code ?? "citywide").replace(/[^A-Za-z0-9_+-]/g, "_");
  const dirLabel = d.direction != null ? `direction ${d.direction}` : null;
  const shapes = suppressedShapes(hours);

  const commonLayout = {
    shapes,
    xaxis: {
      title: { text: "hour of day (New York local time), pooled across observed dates" },
      tickmode: "array",
      tickvals: HOURS.filter((h) => h % 2 === 0),
      ticktext: HOURS.filter((h) => h % 2 === 0).map((h) => String(h).padStart(2, "0")),
      range: [-0.6, 23.6],
    },
  };

  return (
    <div className="as-block">
      <div className="as-head">
        <h2>{heading}</h2>
        {/* This payload carries no generated_at, so there is no "as of" chip to show:
            what bounds it is archive DEPTH, which is stated in the stat row below. */}
      </div>

      <div className="as-tod-scope">
        <span className="as-chip">{scope}</span>
        {dirLabel && <span className="as-chip">{dirLabel}</span>}
        <span className="as-chip">
          {d.hours_published} of 24 hours published · {d.hours_suppressed} suppressed
        </span>
      </div>

      {/* `note` verbatim: it states that hours are POOLED ACROSS DATES and that this is
          explicitly NOT a weekday profile. It is the sentence that makes the whole
          surface defensible, so it is rendered before the charts, not after them. */}
      <p className="as-caption">{d.note}</p>
      {d.borough_note && <p className="as-caption">{d.borough_note}</p>}

      <div className="as-stats">
        <div className="as-stat">
          <span className="as-stat-k">observed gaps behind this profile</span>
          <span className="as-stat-v">{fmtInt(d.n_headways_total)}</span>
        </div>
        <div className="as-stat">
          <span className="as-stat-k">worst hour (bunched-gap share)</span>
          <span className="as-stat-v">
            {hh(d.worst_hour?.local_hour)}{" "}
            <small>{fmtShare(d.worst_hour?.bunched_gap_share)}</small>
          </span>
        </div>
        <div className="as-stat">
          <span className="as-stat-k">best hour (bunched-gap share)</span>
          <span className="as-stat-v">
            {hh(d.best_hour?.local_hour)}{" "}
            <small>{fmtShare(d.best_hour?.bunched_gap_share)}</small>
          </span>
        </div>
        <div className="as-stat">
          <span className="as-stat-k">archive depth behind it</span>
          <span className="as-stat-v">
            {fmtShare(d.coverage?.equivalent_complete_days)}{" "}
            <small>equivalent complete days</small>
          </span>
        </div>
      </div>

      <ArkPlotly
        title={`How long the gaps between buses actually were, by hour of day${
          dirLabel ? ` — ${dirLabel}` : ""
        }`}
        subtitle={`${scope} · observed against scheduled typical gap, minutes. Shaded hours are suppressed, not zero.`}
        data={[
          {
            type: "scatter",
            mode: "lines+markers",
            name: "Observed typical gap (min)",
            x: HOURS,
            y: obs,
            connectgaps: false,
            line: { color: "#4e79a7", width: 2 },
            marker: { size: 6 },
          },
          {
            type: "scatter",
            mode: "lines+markers",
            name: "Scheduled typical gap (min)",
            x: HOURS,
            y: sched,
            connectgaps: false,
            line: { color: "#9c755f", width: 2, dash: "dot" },
            marker: { size: 5, symbol: "diamond" },
          },
          suppressedLegendTrace,
        ]}
        layout={{
          ...commonLayout,
          yaxis: { title: { text: "minutes between buses" }, rangemode: "tozero" },
        }}
        csvRows={csvRows}
        csvName={`bus_time_of_day_profile_${scopeSlug}.csv`}
        height={360}
        source={`Suppression rule — ${d.suppression?.rule ?? ""}`}
      />

      <ArkPlotly
        title={`How EVEN the gaps were, by hour of day${dirLabel ? ` — ${dirLabel}` : ""}`}
        subtitle="Gap-to-gap coefficient of variation (0 = perfectly even) and the share of gaps shorter than half the scheduled gap (bunching). Shaded hours are suppressed."
        data={[
          {
            type: "scatter",
            mode: "lines+markers",
            name: "Gap-to-gap CV",
            x: HOURS,
            y: cv,
            connectgaps: false,
            line: { color: "#00a4a6", width: 2 },
            marker: { size: 6 },
          },
          {
            type: "scatter",
            mode: "lines+markers",
            name: "Bunched-gap share",
            x: HOURS,
            y: bunch,
            connectgaps: false,
            line: { color: "#edc948", width: 2 },
            marker: { size: 6, symbol: "square" },
          },
          suppressedLegendTrace,
        ]}
        layout={{
          ...commonLayout,
          yaxis: { title: { text: "share / coefficient (0–1)" }, rangemode: "tozero" },
        }}
        csvRows={csvRows}
        csvName={`bus_time_of_day_evenness_${scopeSlug}.csv`}
        height={340}
        source={`Suppression rule — ${d.suppression?.rule ?? ""}`}
      />

      {/* Every suppressed hour, with the server's own reason. A suppressed hour that is
          only a pale band on a chart is a gap a reader can misread as good service. */}
      <h3>Hours not published, and why</h3>
      {suppressed.length === 0 ? (
        <p className="as-sup-note">Every one of the 24 local hours cleared the publish floor.</p>
      ) : (
        <div className="nyc-table-wrap">
          <table className="nyc-table">
            <thead>
              <tr>
                <th>Hour (local)</th>
                <th style={{ textAlign: "right" }}>Observed gaps</th>
                <th style={{ textAlign: "right" }}>Cells</th>
                <th>Why it is not published</th>
              </tr>
            </thead>
            <tbody>
              {suppressed.map((h) => (
                <tr key={h.local_hour}>
                  <td>{hh(h.local_hour)}</td>
                  <td style={{ textAlign: "right" }}>{fmtInt(h.n_headways)}</td>
                  <td style={{ textAlign: "right" }}>{fmtInt(h.n_cells)}</td>
                  <td>{h.suppressed_reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="as-caption">
        <b>Published hours</b> — typical gap in minutes to 1 decimal, shares and CV to 2
        decimals: the archive is {fmtShare(d.coverage?.equivalent_complete_days)} equivalent
        complete days deep and does not support a third.
      </p>
      <p className="as-caption">
        There is no day-of-week or week-over-week view here, and there is no control to
        produce one: with at most one observation per weekday, a weekday number would be a
        date number wearing a weekday label. See “Not built, on purpose” at the top of this
        page.
      </p>
    </div>
  );
}
