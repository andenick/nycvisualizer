import CodeToggle from "../components/CodeToggle";

const Q_SAI_PY = `import duckdb
con = duckdb.connect()
# Stop Accessibility Index - borough medians (sai_scores.parquet from /data downloads)
print(con.execute("""
    SELECT borough,
           median(sai)            AS median_sai,
           avg(shelter_100ft)*100 AS pct_sheltered
    FROM read_parquet('sai_scores.parquet')
    GROUP BY borough ORDER BY median_sai DESC
""").df())`;

const Q_SAI_R = `library(duckdb)
con <- dbConnect(duckdb())
# Stop Accessibility Index - borough medians (sai_scores.parquet from /data downloads)
dbGetQuery(con, "
    SELECT borough,
           median(sai)            AS median_sai,
           avg(shelter_100ft)*100 AS pct_sheltered
    FROM read_parquet('sai_scores.parquet')
    GROUP BY borough ORDER BY median_sai DESC
")`;

const Q_COV_PY = `import duckdb
con = duckdb.connect()
# Sidewalk coverage classes per borough (full-res geometry in the GeoParquet download)
print(con.execute("""
    SELECT borough, coverage_class, count(*) AS segments,
           round(sum(seg_len_mi), 1) AS miles
    FROM read_parquet('sidewalk_coverage_segments.geoparquet')
    GROUP BY borough, coverage_class ORDER BY borough, coverage_class
""").df())`;

const Q_COV_R = `library(duckdb)
con <- dbConnect(duckdb())
# Sidewalk coverage classes per borough (full-res geometry in the GeoParquet download)
dbGetQuery(con, "
    SELECT borough, coverage_class, count(*) AS segments
    FROM read_parquet('sidewalk_coverage_segments.geoparquet')
    GROUP BY borough, coverage_class ORDER BY borough, coverage_class
")`;

const Q_RT_PY = `import httpx
# Live vehicles from this site's public API (no key needed - keys stay server-side)
vehicles = httpx.get("https://nycvisualizer.com/api/rt/vehicles").json()
print(vehicles["as_of"], vehicles["count"])
trains = httpx.get("https://nycvisualizer.com/api/rt/subway").json()
print(trains["positional"])  # station-observed vs interpolated - honesty split`;

const Q_RT_R = `library(httr2)
# Live vehicles from this site's public API (no key needed - keys stay server-side)
v <- request("https://nycvisualizer.com/api/rt/vehicles") |> req_perform() |> resp_body_json()
v$as_of; v$count
t <- request("https://nycvisualizer.com/api/rt/subway") |> req_perform() |> resp_body_json()
t$positional  # station-observed vs interpolated - honesty split`;

export default function CodePage() {
  return (
    <div>
      <h1 style={{ margin: "0.6rem 0" }}>Code</h1>
      <p className="lede" style={{ maxWidth: "64ch" }}>
        nycvisualizer is fully open source: a monorepo with the data <code>/pipeline</code> (ingest,
        realtime poller, geodatabase build, the three analysis suites) and this <code>/site</code>
        (React&nbsp;+&nbsp;Vite SPA and FastAPI backend).
      </p>
      <ul>
        <li>
          <strong>Repository:</strong>{" "}
          <a href="https://github.com/andenick/nycvisualizer" rel="noopener">
            github.com/andenick/nycvisualizer
          </a>{" "}
          (MIT license for code; data under NYC Open Data / MTA terms).
        </li>
        <li>
          <strong>Analysis scripts</strong> ship in <code>/pipeline/analysis</code>:{" "}
          <code>sai/</code> (walksheds, stop environment, service, index, context),{" "}
          <code>sidewalk/</code> (coverage classes, width derivation, block equity, condition,
          accessibility), <code>bus/</code> (demand, speeds, supply, realtime headways).
        </li>
        <li>
          <strong>Bring your own keys:</strong> <code>.env.example</code> documents the MTA BusTime,
          Socrata, and Census credentials. Keys are server-side only and never committed.
        </li>
      </ul>

      <h2 style={{ marginTop: "1.6rem" }}>Reproduce the headline queries</h2>
      <p className="nyc-note">
        Grab the files from the <a href="/data">Data</a> page first; each snippet runs standalone
        with DuckDB (Python or R).
      </p>
      <CodeToggle title="SAI borough gradient" python={Q_SAI_PY} r={Q_SAI_R} />
      <CodeToggle title="Sidewalk coverage classes" python={Q_COV_PY} r={Q_COV_R} />
      <CodeToggle title="Live positions from the public API" python={Q_RT_PY} r={Q_RT_R} />

      <p className="nyc-note">
        Reproducible by design: the geodatabase regenerates from the parquet lake with one script,
        the realtime archive is append-only, and every analysis table carries its source dataset id
        and vintage. See <a href="/methodology">Methodology</a> for methods and caveats.
      </p>
    </div>
  );
}
