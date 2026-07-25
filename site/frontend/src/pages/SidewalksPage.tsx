import { Link } from "react-router-dom";
import SidewalkMap from "../components/SidewalkMap";
import MapsSubnav from "../components/MapsSubnav";
import ArkPlotly from "../components/ArkPlotly";
import ConfidenceBadge from "../components/ConfidenceBadge";
import { ContextCallouts } from "../components/ContextCallout";
import KnowDontKnow from "../components/KnowDontKnow";
import charts from "../content/chartdata.json";

export default function SidewalksPage() {
  const cov = charts.coverage;
  const sai = charts.sai_borough;
  return (
    <div>
      <MapsSubnav />
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0.6rem 0" }}>Sidewalk Explorer</h1>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Built</span>
      </div>

      {/* W7 framing: this opened with nine unexplained GIS terms in 60 words
          ("DCP planimetric", "coverage class", "zoom-gated", "data vintage",
          "simplified geometries"…). Rewritten to the /renters template — say what a
          person can do here, in words a planner uses in a meeting. The technical
          detail is not deleted, it moves into the fold below. */}
      <p className="nyc-note" style={{ marginTop: 0 }}>
        Where you can and can&rsquo;t walk in New York, street by street. Turn on any of four
        layers: whether a street has a sidewalk on both sides, one side or neither
        (96,553 streets); how easy each of the 13,621 bus stops is to walk to; how sidewalk
        provision compares neighbourhood by neighbourhood; and which intersections have no
        wheelchair ramp. Zoom in for the street and ramp detail.
      </p>
      <details className="nyc-fold">
        <summary>How the layers are built</summary>
        <p className="nyc-note" style={{ marginTop: "0.4rem" }}>
          The sidewalk shapes come from City Planning&rsquo;s 2022 aerial survey, matched to
          the city street centreline. The street and ramp layers only draw once you zoom in
          (there are too many to draw at once), and each layer&rsquo;s collection date is
          stamped inside the map legend. The shapes drawn in your browser are simplified so
          the map stays fast &mdash; the full-resolution files are in{" "}
          <Link to="/data">Data</Link>.
        </p>
      </details>

      <SidewalkMap />

      <section className="nyc-section">
        <h2>Headline findings</h2>
        <ul className="sw-findings">
          <li><strong>85%</strong> of NYC's pedestrian street segments have sidewalks on both sides; only <strong>3%</strong> have none &mdash; but 62% of the no-sidewalk segments are in Staten Island and Queens. <ConfidenceBadge claimKey="sw-coverage" compact /></li>
          <li>The equity gradient is a <strong>crowding story</strong> (per-frontage proxy): the poorest fifth of blocks has the <em>highest</em> coverage per frontage foot but the <em>least</em> sidewalk per person (47 vs 76 sqft/capita). <ConfidenceBadge claimKey="sw-equity" compact /></li>
          <li><strong>6,086 intersections</strong> (12.5%) lack any pedestrian ramp within 50 ft &mdash; and of ramps that exist, 25.9% fail the ADA 8.33% slope maximum. <ConfidenceBadge claimKey="sw-ramps" compact /></li>
          <li>A typical <strong>Staten Island</strong> bus stop ranks in the bottom third of the city on pedestrian access (median SAI 35 vs Manhattan 61); nearly three-quarters of stops citywide have no shelter. <ConfidenceBadge claimKey="sai-index" compact /></li>
        </ul>
        {/* W7 jargon + precision: this shipped "2·Area/Perimeter proxy, validated vs
            max-inscribed width at r = 0.47" — an unexplained formula and an
            unexplained correlation coefficient — and quoted 0.1-ft precision (12.9 /
            8.4 ft) on a measure that only correlates 0.47 with the real thing. Both
            fixed: the caveat is stated in words, and the numbers are rounded to the
            precision the method can carry. */}
        <p className="nyc-note" style={{ fontSize: "0.78rem" }}>
          Sidewalk width is an <strong>estimate, not a measurement</strong>: we infer it
          from the shape of each sidewalk polygon. Checked against a true width measurement
          it agrees only loosely, so use it to compare places, never as a figure for a
          specific sidewalk. On that basis Manhattan&rsquo;s sidewalks are the widest
          (about 13&nbsp;ft) and Staten Island&rsquo;s the narrowest (about 8&nbsp;ft).{" "}
          <ConfidenceBadge claimKey="sw-width" compact />
        </p>
        <p className="nyc-note">
          Full claims with caveats and pointers on the <a href="/methodology">Methodology</a> page.
        </p>
        {/* KB context: the Vision Zero safety backdrop to pedestrian infrastructure */}
        <ContextCallouts anchor="sidewalks-safety" />
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

      {/* KB context: pedestrian-safety trend beside the accessibility index */}
      <ContextCallouts anchor="sidewalks-sai" />

      <section className="nyc-section">
        <h2>What we can and can&rsquo;t say yet</h2>
        <KnowDontKnow
          scope="the sidewalk network &amp; stop access"
          dated="2026-07-23"
          can={[
            /* W7 honesty: the original said "**all** 96,553 … a **near-complete**
                census" in one sentence — the two claims contradict each other. It is
                the whole of the city's mapped pedestrian street network; "near-complete"
                referred to the aerial survey behind it, which is a different thing. */
            { text: "The sidewalk situation on every one of the 96,553 streets in the city's pedestrian street network: 85% have sidewalks on both sides, 3% have none, and the streets with none are concentrated in Staten Island and Queens. (The network itself is complete; what is approximate is the 2022 aerial survey the sidewalk shapes are traced from.)" },
            { text: "Where pedestrian ramps are missing (6,086 intersections lack any within 50 ft) and where existing ramps fail the ADA 8.33% slope maximum." },
            { text: "How bus-stop pedestrian access varies by borough (the Stop Accessibility Index); its borough gradient is weighting-robust." },
          ]}
          cannot={[
            { text: "How wide a particular sidewalk actually is.", closes: "→ measuring the true width down the middle of each sidewalk polygon (the Harvey 2020 method) would replace today's shape-based estimate, which only agrees loosely with a real measurement. Until then, treat width as a comparison between places, not a figure for a place." },
            { text: "Whether crash counts near ranked segments reflect a true safety gap.", closes: "→ normalizing counts by pedestrian volume/exposure converts a count concentration into a genuine rate." },
            { text: "Daytime crowding per capita.", closes: "→ worker (daytime) population resolves what the nighttime per-frontage proxy understates in the CBD." },
          ]}
        />
      </section>

      {/* W5 (2026-07-24): a <h2>Downloads</h2> + DownloadRow used to sit HERE, on a
          map page, along with the literal internal string "(Carson DNA D-4)". Both are
          gone: the sidewalk and stop-access files are in the Data tab with every other
          download, and this page is a map again. One quiet line points there. */}
      <p className="nyc-smallprint">
        The sidewalk and stop-access files &mdash; full resolution, GeoJSON, GeoParquet and
        CSV &mdash; are in <Link to="/data">Data</Link>.
      </p>
    </div>
  );
}
