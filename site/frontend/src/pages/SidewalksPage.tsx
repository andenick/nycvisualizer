import SidewalkMap from "../components/SidewalkMap";
import DownloadRow from "../components/DownloadRow";
import ArkPlotly from "../components/ArkPlotly";
import charts from "../content/chartdata.json";

export default function SidewalksPage() {
  const cov = charts.coverage;
  const sai = charts.sai_borough;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0.6rem 0" }}>Sidewalk Explorer</h1>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Built</span>
      </div>

      <p className="nyc-note" style={{ marginTop: 0 }}>
        Four real layers over the DCP planimetric sidewalk network: per-segment coverage class
        (96,553 street segments), the Stop Accessibility Index for all 13,621 bus stops,
        neighborhood coverage equity, and the ADA ramp-gap map. Segment and ramp layers are
        zoom-gated; each layer's data vintage is stamped in the legend. Web geometries are
        simplified for delivery &mdash; full resolution ships in the downloads below.
      </p>

      <SidewalkMap />

      <section className="nyc-section">
        <h2>Headline findings</h2>
        <ul>
          <li><strong>85%</strong> of NYC's pedestrian street segments have sidewalks on both sides; only <strong>3%</strong> have none &mdash; but 62% of the no-sidewalk segments are in Staten Island and Queens.</li>
          <li>The equity gradient is a <strong>crowding story</strong>: the poorest fifth of blocks has the <em>highest</em> coverage per frontage foot but the <em>least</em> sidewalk per person (47 vs 76 sqft/capita).</li>
          <li><strong>6,086 intersections</strong> (12.5%) lack any pedestrian ramp within 50 ft &mdash; and of ramps that exist, 25.9% fail the ADA 8.33% slope maximum.</li>
          <li>A typical <strong>Staten Island</strong> bus stop ranks in the bottom third of the city on pedestrian access (median SAI 35 vs Manhattan 61); nearly three-quarters of stops citywide have no shelter.</li>
        </ul>
        <p className="nyc-note">
          Full claims with caveats and pointers on the <a href="/methodology">Methodology</a> page.
        </p>
      </section>

      <ArkPlotly
        title="Sidewalk coverage class by borough"
        subtitle="Share of CSCL pedestrian street segments; DCP planimetric 2022"
        data={[
          { type: "bar", name: "Both sides", x: cov.borough, y: cov.pct_both, marker: { color: "#16a34a" } },
          { type: "bar", name: "One side", x: cov.borough, y: cov.pct_one, marker: { color: "#d97706" } },
          { type: "bar", name: "None", x: cov.borough, y: cov.pct_none, marker: { color: "#dc2626" } },
        ]}
        layout={{ barmode: "stack", yaxis: { title: { text: "% of segments" }, range: [0, 100] } }}
        csvRows={cov.borough.map((b: string, i: number) => ({
          borough: b, pct_both_sides: cov.pct_both[i], pct_one_side: cov.pct_one[i], pct_none: cov.pct_none[i],
        }))}
        csvName="sidewalk_coverage_by_borough.csv"
        source="Source: DCP planimetric sidewalks (2022 flight) x CSCL inkn-q76z; analysis 01_coverage_classes (2026-07-17)."
      />

      <ArkPlotly
        title="Stop Accessibility Index by borough"
        subtitle="Median composite SAI (0-100, citywide percentile construction) and shelter share"
        data={[
          { type: "bar", name: "Median SAI", x: sai.borough, y: sai.median, marker: { color: "#2563eb" } },
          { type: "bar", name: "% stops sheltered", x: sai.borough, y: sai.pct_sheltered, marker: { color: "#93c5fd" } },
        ]}
        layout={{ barmode: "group", yaxis: { title: { text: "score / %" }, range: [0, 100] } }}
        csvRows={sai.borough.map((b: string, i: number) => ({
          borough: b, median_sai: sai.median[i], mean_sai: sai.mean[i],
          pct_sheltered: sai.pct_sheltered[i], pct_seating: sai.pct_seating[i], n_stops: sai.n_stops[i],
        }))}
        csvName="sai_by_borough.csv"
        source="Source: analysis/sai (2026-07-17); SAI is a within-NYC percentile composite - relative, not absolute."
      />

      <section className="nyc-section">
        <h2>Downloads</h2>
        <p className="nyc-note">
          Geospatial layers ship <strong>GeoJSON + GeoParquet</strong>; tables ship
          <strong> CSV / XLSX / Parquet</strong> (Carson DNA D-4). Correct content-types on every file.
        </p>
        <DownloadRow groups={["Sidewalk", "SAI"]} />
      </section>
    </div>
  );
}
