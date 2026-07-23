// Real data catalog, generated from the platform's PROVENANCE.json records
// (site/tools/build_content.py). Downloads served where we host extracts;
// giants link to the source portal instead (honest note below).
import { useState } from "react";
import { Link } from "react-router-dom";
import catalog from "../content/data_catalog.json";
import DownloadRow from "../components/DownloadRow";
import ConfidenceBadge from "../components/ConfidenceBadge";

interface CatRow {
  name: string; category: string; id: string; portal: string;
  vintage: string; rows: number | null; bytes: number | null; license: string;
}

const CAT_LABEL: Record<string, string> = {
  sidewalk_pedestrian: "Sidewalk & pedestrian",
  street_network: "Street network",
  population: "Population & census",
  landuse: "Land use",
  transit_static: "Transit (static)",
  ridership: "Ridership & operations",
  qol: "Quality of life",
  housing: "Housing & buildings",
  flood: "Flood & risk",
  raw: "Other",
};

function fmtRows(n: number | null): string {
  if (n == null) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}
function fmtBytes(b: number | null): string {
  if (b == null) return "";
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}

export default function DataPage() {
  const rows = catalog as CatRow[];
  const cats = [...new Set(rows.map((r) => r.category))];
  const [cat, setCat] = useState<string>("all");
  const shown = cat === "all" ? rows : rows.filter((r) => r.category === cat);

  return (
    <div>
      <h1 style={{ margin: "0.6rem 0" }}>Data</h1>
      <p className="lede" style={{ maxWidth: "64ch" }}>
        Every layer on this site traces to an authentic public source &mdash; NYC Open Data (two
        Socrata portals), the MTA, NYC City Planning, and the U.S. Census. The catalog below is
        generated from the platform's per-dataset provenance records ({rows.length} acquired datasets).
        See the <Link to="/code">reproduce &amp; code</Link> page for how each figure is built.
      </p>

      <section className="nyc-section">
        <div
          style={{
            border: "1px solid var(--ark-border, #d4d8dd)",
            borderRadius: 12,
            padding: "1rem 1.1rem",
            background: "var(--ark-surface, transparent)",
            margin: "0.4rem 0 1rem",
          }}
        >
          <h2 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            NYC Observed Bus Headways
            <span
              style={{
                border: "1px solid var(--ark-accent, #2563eb)",
                color: "var(--ark-accent, #2563eb)",
                borderRadius: 999,
                padding: "0.1rem 0.6rem",
                fontSize: "0.7rem",
                fontWeight: 700,
                letterSpacing: "0.03em",
              }}
            >
              BETA · PRELIMINARY
            </span>
            <ConfidenceBadge claimKey="data-headways" />
          </h2>
          <p style={{ maxWidth: "68ch" }}>
            The MTA publishes <em>scheduled</em> service. This dataset publishes what the buses{" "}
            <strong>actually did</strong> — observed headways, their variability (CV), a bunching index,
            and the gap versus schedule, per route &times; direction &times; stop &times; date &times;
            hour, derived from our own 31-second GTFS-realtime vehicle-position archive. Nobody else
            publishes this. Updated daily; ships an all-days Parquet, the latest service day as CSV, and
            a Frictionless <code>datapackage.json</code> (schema, CC-BY-4.0 licence, known gaps).
          </p>
          <p className="nyc-note" style={{ marginBottom: "0.6rem" }}>
            <strong>Preliminary:</strong> reliability figures firm up at &ge;14 days of archive; the
            2026-07-21 poller-suspension gap is excluded, not smoothed over. Arrival = trajectory crossing
            a stop&rsquo;s shape offset (positional), which is distinct from a true door-open arrival.
          </p>
          <DownloadRow groups={["Observed Headways"]} />
        </div>

        <h2>Analysis downloads</h2>
        <p className="nyc-note">
          Geospatial layers ship <strong>GeoJSON + GeoParquet</strong>; tabular data ships
          <strong> CSV / XLSX / Parquet</strong>, never plain JSON (Carson DNA D-4). New in this
          release: the 45-minute job-access <strong>isochrone grid</strong> and access-equity table
          (S4 OpenTripPlanner routing), and the <strong>Renter&rsquo;s Map</strong> cell grid plus
          per-BBL building aggregates (S7).
        </p>
        <DownloadRow exclude={["Observed Headways"]} />
      </section>

      <section className="nyc-section">
        <h2>Source catalog</h2>
        <p className="nyc-note">
          <strong>Honest size note:</strong> the biggest raw pulls (311 service requests ~19&nbsp;GB,
          subway hourly ridership ~14&nbsp;GB, PLUTO, planimetrics) are not served from this site &mdash;
          fetch them from the source portal via the dataset ID below. Everything we <em>derive</em> from
          them is downloadable above.
        </p>
        <div className="row" style={{ maxWidth: 320, marginBottom: "0.6rem" }}>
          <label htmlFor="catSel">Category</label>
          <select id="catSel" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">All categories ({rows.length})</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {CAT_LABEL[c] ?? c} ({rows.filter((r) => r.category === c).length})
              </option>
            ))}
          </select>
        </div>
        <div className="nyc-table-wrap">
          <table className="nyc-table">
            <thead>
              <tr>
                <th>Dataset</th><th>Source</th><th>ID</th><th>Vintage</th><th>Rows</th><th>Size</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  <td>{r.name}</td>
                  <td>{r.portal}</td>
                  <td><code>{r.id}</code></td>
                  <td>{r.vintage}</td>
                  <td>{fmtRows(r.rows)}</td>
                  <td>{fmtBytes(r.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="nyc-note">
        The realtime bus/subway archive grows continuously (31-second poller); the static
        geodatabase regenerates from the parquet lake. Acquisition scripts and full provenance ship
        in the public repository.
      </p>
    </div>
  );
}
