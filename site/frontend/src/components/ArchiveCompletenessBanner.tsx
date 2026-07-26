// ArchiveCompletenessBanner — /api/autostats/completeness, rendered so the GAPS ARE
// VISIBLE rather than silently averaged away.
//
// The endpoint has returned real data since 2026-07-25 with no consumer at all. Its whole
// point is that counting `date=` directories OVERSTATES the archive: nine or ten day
// folders are not nine or ten days of bus data. The server states the honest number in
// `headline`, publishes the per-hour status behind it, and — the strongest honesty signal
// on the site — publishes `not_supported`: the comparisons this platform REFUSES to
// compute, each with its real reason and what would unblock it.
//
// COMPACT BY DEFAULT. This banner sits above other statistics and must frame them, not
// dominate them: one headline line, one strip naming what is not built, and a disclosure
// for the day x hour grid, the vocabulary legend and the full refusal reasons. Mobile
// chrome is already ~87% of a phone viewport — nothing here is always-on beyond two lines.
import { useEffect, useState } from "react";
import {
  getCompleteness,
  type CompletenessDay,
  type CompletenessResponse,
} from "../lib/api";
import "../styles/autostats.css";

// ---------------------------------------------------------------------------
// Shared honest-"as of" chip (also imported by TimeOfDayProfile / BoroughRollups).
//
// Behaviour is copied from the OpsWallPage `Stamp` (OpsWallPage.tsx:63-80) rather than
// re-invented: when the payload is stale the LABEL IS REPLACED by "STALE — N old", it is
// not decorated with a warning colour beside a still-reassuring word. It lives here (and
// is exported) so all three autostats surfaces share ONE implementation.
// ---------------------------------------------------------------------------
export function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** These payloads are derived from a daily archive refresh behind a 5-10 min server
 *  cache, so "fresh" means "derived within the last day". Older than that and the label
 *  is replaced, not decorated. */
const STALE_AFTER_S = 36 * 3600;

export function AsOfStamp({ label, iso }: { label: string; iso?: string | null }) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!isFinite(t)) return <span className="as-stamp">{label}</span>;
  const ageS = (Date.now() - t) / 1000;
  const stale = ageS > STALE_AFTER_S;
  const clock = new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <span className={"as-stamp" + (stale ? " stale" : "")}>
      <span className="dot" />
      {stale ? `STALE — ${fmtAge(ageS)} old` : label} {clock}
    </span>
  );
}

/** Minutes: 1 dp. Shares and CVs: 2 dp. Never three decimals on a ~6-day archive —
 *  the server rounds shares to 3 dp, and repeating that here would be precision the
 *  evidence does not carry. Shared with the other two autostats surfaces. */
export const fmtMin = (v: number | null | undefined) =>
  v == null || !isFinite(v) ? "—" : v.toFixed(1);
export const fmtShare = (v: number | null | undefined) =>
  v == null || !isFinite(v) ? "—" : v.toFixed(2);
export const fmtInt = (v: number | null | undefined) =>
  v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString();

// ---------------------------------------------------------------------------

const HOURS = Array.from({ length: 24 }, (_, i) => i);
// Order the vocabulary the way the archive degrades, so the legend reads as a ramp.
const STATUS_ORDER = ["ok", "partial", "missing", "known_gap", "in_progress"];

function hourOf(day: CompletenessDay, h: number) {
  const hh = String(h).padStart(2, "0");
  return day.hours?.[hh] ?? day.hours?.[String(h)] ?? null;
}

function cellClass(status: string | undefined) {
  return "as-cell as-cell--" + (status && STATUS_ORDER.includes(status) ? status : "unknown");
}

export default function ArchiveCompletenessBanner({
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
}) {
  const [d, setD] = useState<CompletenessResponse | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    getCompleteness()
      .then(setD)
      .catch(() => setErr(true));
  }, []);

  if (err)
    return (
      <div className="nyc-note">
        Archive-completeness stamp temporarily unavailable — the figures below are still
        drawn from the same archive, but its coverage cannot be shown right now.
      </div>
    );
  if (!d) return null;

  const notSupported = d.not_supported ?? [];
  const vocab = d.status_vocabulary ?? {};
  const vocabKeys = [
    ...STATUS_ORDER.filter((k) => k in vocab),
    ...Object.keys(vocab).filter((k) => !STATUS_ORDER.includes(k)),
  ];

  return (
    <section className="as-banner" aria-label="Archive completeness">
      <div className="as-banner-line">
        {/* `headline` verbatim — it already states directories vs equivalent complete
            days vs genuinely complete days, which is the entire point. */}
        <p className="as-headline">{d.headline}</p>
        <span style={{ display: "flex", gap: "0.6rem", alignItems: "baseline" }}>
          <AsOfStamp label="derived" iso={d.generated_at} />
          <button
            type="button"
            className="as-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide detail" : "Show detail"}
          </button>
        </span>
      </div>

      {/* NOT BUILT, ON PURPOSE — always visible, one line. Naming the comparisons we
          refuse to compute is a feature: it is what stops a reader assuming a
          day-of-week or week-over-week claim exists somewhere on the site. */}
      {notSupported.length > 0 && (
        <div className="as-ns as-ns-strip">
          <span className="as-ns-lead">Not built, on purpose</span>
          {notSupported.map((n) => (
            <span key={n.metric} className="as-ns-pill" title={n.reason}>
              {n.metric} <b>{n.status}</b>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="as-banner-detail">
          <p className="as-caption">{d.equivalent_complete_days_method}</p>
          <p className="as-caption">
            <b>Complete day rule:</b> {d.complete_day_rule}
            {d.complete_day_list?.length > 0 && <> Complete: {d.complete_day_list.join(", ")}.</>}
          </p>

          <h3>Coverage by archive day and hour</h3>
          <div className="as-scroll">
            <div className="as-grid" role="table" aria-label="Archive coverage by day and hour">
              <div className="as-grow" role="row">
                <span className="as-glab" role="columnheader">
                  archive day (UTC)
                </span>
                {HOURS.map((h) => (
                  <span key={h} className="as-ghour" role="columnheader">
                    {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                  </span>
                ))}
              </div>
              {d.days.map((day) => (
                <div className="as-grow" role="row" key={day.archive_day_utc}>
                  <span className="as-glab" role="rowheader">
                    {day.archive_day_utc}{" "}
                    <span className="as-eq">
                      {day.complete ? "✓" : ""} {fmtShare(day.equivalent_complete_days)} eq. days
                    </span>
                  </span>
                  {HOURS.map((h) => {
                    const cell = hourOf(day, h);
                    const status = cell?.status;
                    const title =
                      `${day.archive_day_utc} ${String(h).padStart(2, "0")}:00 UTC — ` +
                      (status ?? "no record") +
                      (cell
                        ? ` · ${Math.round(cell.coverage_pct ?? 0)}% coverage · ${fmtInt(cell.rows)} rows`
                        : "") +
                      (day.excluded_local_hours?.length
                        ? ` · local hours dropped from every statistic this day: ${day.excluded_local_hours
                            .map((x) => String(x).padStart(2, "0"))
                            .join(", ")}`
                        : "");
                    return (
                      <span className="as-gcell" role="cell" key={h}>
                        <span className={cellClass(status)} title={title} aria-label={title} />
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <p className="as-caption">
            Hours are UTC, as archived (New York local time is UTC−4 across this whole
            window). A local service day therefore straddles two archive folders.
          </p>

          {/* The vocabulary comes from the payload and is rendered VERBATIM — the server
              owns what "partial" means, not this component. Collapsible content, not the
              legacy always-on legend. Five rows, inside the ≤8-item pact. */}
          {vocabKeys.length > 0 && (
            <div className="as-legend">
              {vocabKeys.map((k) => (
                <div className="as-legend-row" key={k}>
                  <span className={cellClass(k)} aria-hidden="true" />
                  <span>
                    <span className="as-legend-k">{k}</span>{" "}
                    <span className="as-legend-v">— {vocab[k]}</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {notSupported.length > 0 && (
            <>
              <h3>What this archive cannot answer — and what would unblock it</h3>
              <ul className="as-ns-list">
                {notSupported.map((n) => (
                  <li className="as-ns-item" key={n.metric}>
                    <div>
                      <span className="as-ns-metric">{n.metric}</span>
                      <span className="as-ns-status">{n.status}</span>
                    </div>
                    <p className="as-ns-reason">{n.reason}</p>
                    <p className="as-ns-unblock">Unblocks at: {n.unblocks_at}</p>
                  </li>
                ))}
              </ul>
            </>
          )}

          {d.coverage?.depth_note && <p className="as-caption">{d.coverage.depth_note}</p>}
        </div>
      )}
    </section>
  );
}
