// Renter's Map scorecard — one location's place-based profile in plain language.
// Every number keeps its citywide percentile context; lower-is-better metrics are
// inverted honestly ("Quieter than 80% of NYC"). In compare mode each metric shows
// a neutral better/lower marker vs the other side (never moral red/green). The
// fair-housing disclaimer is pinned, visible, at the bottom.
import { useState } from "react";
import {
  METRIC_ORDER,
  METRIC_UI,
  goodPercentile,
  saiColor,
} from "../lib/renters";
import type { RenterProfile, RenterBuilding, RenterScoreKey } from "../lib/api";

function BuildingRow({ b }: { b: RenterBuilding }) {
  const [open, setOpen] = useState(false);
  const v = b.hpd_open_violations;
  const title = b.address || (b.bbl ? `BBL ${b.bbl}` : "Building");
  return (
    <li className="rent-bldg">
      <button type="button" className="rent-bldg-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="rent-bldg-title">{title}</span>
        <span className="rent-bldg-meta">
          {b.units_res != null ? `${b.units_res} units` : b.units_total != null ? `${b.units_total} units` : "—"}
          {b.year_built ? ` · ${b.year_built}` : ""}
          {v.total > 0 ? ` · ${v.total} open viol.` : " · 0 viol."}
          <span className="rent-caret">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <div className="rent-bldg-detail">
          {b.owner_name && (
            <div>
              <span className="k">Owner</span> {b.owner_name}
            </div>
          )}
          {b.dist_ft != null && (
            <div>
              <span className="k">Distance</span> {Math.round(b.dist_ft)} ft
            </div>
          )}
          <div>
            <span className="k">HPD open violations</span> {v.total}
            {v.total > 0 && (
              <span className="rent-viol">
                {v.class_c > 0 && <em>C (hazardous) {v.class_c}</em>}
                {v.class_b > 0 && <em>B {v.class_b}</em>}
                {v.class_a > 0 && <em>A {v.class_a}</em>}
                {v.class_i > 0 && <em>I {v.class_i}</em>}
              </span>
            )}
          </div>
          <div>
            <span className="k">DOB permits (5 yr)</span> {b.dob_permits_5y}
            {b.dob_last_permit_date ? ` · last ${b.dob_last_permit_date}` : ""}
          </div>
          {b.landlord && (b.landlord.portfolio_buildings != null || b.landlord.owner_name) && (
            <div>
              <span className="k">Landlord portfolio</span>{" "}
              {b.landlord.portfolio_buildings != null
                ? `${b.landlord.portfolio_buildings.toLocaleString()} registered building${b.landlord.portfolio_buildings === 1 ? "" : "s"}`
                : "—"}
              {b.landlord.owner_name ? ` (${b.landlord.owner_name})` : ""}
            </div>
          )}
          {b.bbl && (
            <div className="rent-bbl">
              BBL {b.bbl} · {b.bldg_class ?? "—"}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

interface Props {
  profile: RenterProfile;
  other?: RenterProfile | null;
  label?: string; // "A" / "B" in compare
  accent?: string;
}

export default function RenterScorecard({ profile, other, label, accent = "#2563eb" }: Props) {
  const q = profile.query;
  const t = profile.transit;
  const f = profile.flood;
  const jobs = profile.scores.jobs_45min;
  const iso = profile.isochrone_45min_8am;
  const jobsShare =
    iso && iso.approximate && iso.jobs_reachable_pct != null
      ? `≈ ${(iso.jobs_reachable_pct * 100).toFixed(1)}% of all NYC jobs`
      : null;

  const heading =
    q.address?.matched_label ||
    (q.address?.input ? q.address.input : `${q.lat.toFixed(5)}, ${q.lon.toFixed(5)}`);

  // per-metric compare verdict for THIS side
  const verdict = (key: RenterScoreKey): "better" | "lower" | "same" | null => {
    if (!other || other.error) return null;
    const a = goodPercentile(key, profile.scores[key]);
    const b = goodPercentile(key, other.scores[key]);
    if (a == null || b == null) return null;
    if (Math.abs(a - b) < 3) return "same";
    return a > b ? "better" : "lower";
  };

  return (
    <div className="rent-card">
      <div className="rent-card-head" style={{ borderColor: accent }}>
        {label && (
          <span className="rent-pin rent-pin-inline" style={{ background: accent }}>
            {label}
          </span>
        )}
        <div>
          <div className="rent-addr">{heading}</div>
          <div className="rent-sub">
            {q.address?.bbl ? `BBL ${q.address.bbl} · ` : ""}
            {q.populated_cell ? "residential grid cell" : "non-residential / edge cell"}
            {!q.grid_cell_exact ? " · nearest populated cell" : ""}
          </div>
        </div>
      </div>

      {/* Jobs headline */}
      <div className="rent-jobs">
        <div className="rent-jobs-num">{jobs.value != null ? Math.round(jobs.value).toLocaleString() : "—"}</div>
        <div className="rent-jobs-label">
          jobs reachable in 45 min by transit (8am)
          <div className="rent-sub">
            {jobs.percentile != null ? `${Math.round(jobs.percentile)}th percentile citywide` : "no estimate"}
            {jobsShare ? ` · ${jobsShare}` : ""}
          </div>
        </div>
      </div>

      {/* Metric bars */}
      <div className="rent-metrics">
        {METRIC_ORDER.map((key) => {
          const s = profile.scores[key];
          const gp = goodPercentile(key, s);
          const ui = METRIC_UI[key];
          const vd = verdict(key);
          return (
            <div className="rent-metric" key={key}>
              <div className="rent-metric-top">
                <span className="rent-metric-title">{ui.title}</span>
                {vd && vd !== "same" && (
                  <span className={"rent-vd " + vd}>{vd === "better" ? "▲ better" : "▼ lower"}</span>
                )}
                {vd === "same" && <span className="rent-vd same">≈ similar</span>}
              </div>
              {gp != null ? (
                <>
                  <div className="rent-bar" role="img" aria-label={ui.phrase(gp)}>
                    <div className="rent-bar-fill" style={{ width: `${gp}%`, background: accent }} />
                  </div>
                  <div className="rent-metric-line">{ui.phrase(gp)}</div>
                  {ui.fmtValue(s.value) && <div className="rent-sub">{ui.fmtValue(s.value)}</div>}
                </>
              ) : (
                <div className="rent-sub">Not enough nearby data to rank.</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Transit summary */}
      <div className="rent-block">
        <h4>Transit nearby</h4>
        <div className="rent-transit-grid">
          <div>
            <b>{t.bus_stops_within_400m}</b> bus stops within 400 m
          </div>
          <div>
            best SAI <b>{t.best_sai_within_400m != null ? t.best_sai_within_400m.toFixed(0) : "—"}</b>/100
          </div>
          <div>
            <b>{t.scheduled_am_trips_within_400m}</b> AM peak trips
          </div>
          <div>
            subway <b>{t.nearest_subway.name ?? "—"}</b>
            {t.nearest_subway.distance_mi != null ? ` · ${t.nearest_subway.distance_mi} mi` : ""}
          </div>
        </div>
        {t.nearest_stops_detail.length > 0 && (
          <div className="rent-chips">
            {t.nearest_stops_detail.slice(0, 6).map((s, i) => (
              <span
                key={i}
                className="rent-chip"
                title={
                  `${s.stop_name ?? "stop"} — SAI ${s.sai ?? "—"}` +
                  (s.subscores
                    ? ` | safety ${s.subscores.safety ?? "—"}, comfort ${s.subscores.comfort ?? "—"}, ` +
                      `condition ${s.subscores.condition ?? "—"}, service ${s.subscores.service_intensity ?? "—"}`
                    : "") +
                  (s.dist_ft != null ? ` | ${Math.round(s.dist_ft)} ft` : "")
                }
              >
                <span className="rent-chip-dot" style={{ background: s.sai != null ? saiColor(s.sai) : "#9ca3af" }} />
                {s.stop_name ?? "stop"} {s.sai != null ? `· ${s.sai.toFixed(0)}` : ""}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Flood badges (neutral) */}
      <div className="rent-block">
        <h4>Flood exposure</h4>
        <div className="rent-badges">
          {f.any_flag ? (
            <>
              {f.stormwater_moderate_current && <span className="rent-badge flood">Stormwater flood (moderate, today)</span>}
              {f.stormwater_extreme_2080 && <span className="rent-badge flood">Stormwater flood (extreme, 2080)</span>}
              {f.fema_firm_special_flood_hazard && (
                <span className="rent-badge flood">
                  FEMA special flood hazard{f.fema_firm_zone ? ` · zone ${f.fema_firm_zone}` : ""}
                </span>
              )}
            </>
          ) : (
            <span className="rent-badge clear">No mapped flood exposure</span>
          )}
        </div>
      </div>

      {/* Buildings */}
      {profile.buildings_nearby.length > 0 && (
        <div className="rent-block">
          <h4>Buildings nearby (tap for detail)</h4>
          <ul className="rent-bldgs">
            {profile.buildings_nearby.map((b, i) => (
              <BuildingRow key={b.bbl ?? i} b={b} />
            ))}
          </ul>
        </div>
      )}

      {/* Disclaimer — always visible, pinned at the bottom */}
      <div className="rent-disclaimer">{profile.disclaimer}</div>
    </div>
  );
}
