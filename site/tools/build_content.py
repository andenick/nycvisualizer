"""Pre-render site content: methodology HTML, data catalog, chart data.

Server-side/pre-rendered per CONTENT_RENDERING_STANDARD -- the SPA never ships or
renders literal markdown. Env-parameterized (no absolute workspace paths):
  OUTPUTS_ROOT   -- analysis outputs (default <platform>/../../Outputs/NYCPlatform)
  ANALYSIS_ROOT  -- analysis scripts+docs (default <platform>/analysis)
  DATA_ROOT      -- data lake (default <platform>/data)
Writes into <site>/frontend/src/content/.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import duckdb
import markdown

HERE = Path(__file__).resolve()
SITE = HERE.parents[1]
PLATFORM = SITE.parents[0]
OUT_ROOT = Path(os.environ.get("OUTPUTS_ROOT", PLATFORM.parents[1] / "Outputs" / "NYCPlatform"))
ANALYSIS = Path(os.environ.get("ANALYSIS_ROOT", PLATFORM / "analysis"))
DATA = Path(os.environ.get("DATA_ROOT", PLATFORM / "data"))
CONTENT = SITE / "frontend" / "src" / "content"
CONTENT.mkdir(parents=True, exist_ok=True)

MD = markdown.Markdown(extensions=["tables", "fenced_code", "sane_lists"])


def render_md(src: Path, out_name: str) -> None:
    html = MD.reset().convert(src.read_text(encoding="utf-8"))
    (CONTENT / out_name).write_text(html, encoding="utf-8")
    print(f"  {out_name}: {len(html)/1e3:.0f} KB")


# ---------------------------------------------------------------- methodology docs
DOCS = [
    (ANALYSIS / "sai" / "METHODS.md", "methods_sai.html"),
    (ANALYSIS / "sai" / "FINDINGS_sai.md", "findings_sai.html"),
    (ANALYSIS / "sidewalk" / "METHODS.md", "methods_sidewalk.html"),
    (OUT_ROOT / "sidewalk" / "FINDINGS_sidewalk.md", "findings_sidewalk.html"),
    (ANALYSIS / "bus" / "METHODS.md", "methods_bus.html"),
    (ANALYSIS / "bus" / "FINDINGS_bus.md", "findings_bus.html"),
    # --- spokes campaign (S2 derive2, S4 access/isochrones, S7 renters, S3/S8 changes) ---
    (PLATFORM / "realtime" / "derive2" / "METHODS_derive2.md", "methods_derive2.html"),
    (ANALYSIS / "access" / "METHODS.md", "methods_access.html"),
    (ANALYSIS / "access" / "FINDINGS_access.md", "findings_access.html"),
    (ANALYSIS / "renters" / "METHODS.md", "methods_renters.html"),
    (PLATFORM / "changes" / "README.md", "methods_changes.html"),
]
for src, out in DOCS:
    if src.exists():
        render_md(src, out)
    else:
        print(f"  MISSING: {src}")

# ---------------------------------------------------------------- data catalog
catalog = []
for prov in sorted(DATA.glob("raw/**/PROVENANCE.json")):
    try:
        p = json.loads(prov.read_text(encoding="utf-8"))
    except Exception:
        continue
    ident = p.get("dataset_id") or p.get("id_or_url") or ""
    url = p.get("url") or (ident if str(ident).startswith("http") else "")
    if str(ident).startswith("http"):
        ident = ""
    portal = ""
    u = url or str(p.get("url") or "")
    if "cityofnewyork" in u:
        portal = "data.cityofnewyork.us"
    elif "data.ny.gov" in u:
        portal = "data.ny.gov"
    elif "mta" in u or "rrgtfsfeeds" in u or "obanyc" in u:
        portal = "MTA"
    elif "census.gov" in u or "www2.census.gov" in u:
        portal = "U.S. Census"
    elif "nyc.gov" in u:
        portal = "NYC DCP (BYTES)"
    catalog.append({
        "name": p.get("dataset_name") or prov.parent.name,
        "category": prov.parent.parent.name,
        "id": ident,
        "portal": portal or p.get("license", ""),
        "vintage": p.get("feed_version") or (p.get("retrieved_at") or "")[:10],
        "rows": p.get("rows_or_features"),
        "bytes": p.get("bytes"),
        "license": p.get("license", ""),
    })
catalog.sort(key=lambda d: (d["category"], d["name"]))
(CONTENT / "data_catalog.json").write_text(json.dumps(catalog, indent=0), encoding="utf-8")
print(f"  data_catalog.json: {len(catalog)} datasets")

# ---------------------------------------------------------------- chart data
con = duckdb.connect()
charts: dict = {}

rows = con.execute(
    f"SELECT yr, payment_method, boardings FROM read_parquet('{(OUT_ROOT / 'bus' / '01_fare_payment_by_year.parquet').as_posix()}') ORDER BY yr"
).fetchall()
years = sorted({int(r[0]) for r in rows})
omny = {int(r[0]): r[2] for r in rows if r[1] == "omny"}
mc = {int(r[0]): r[2] for r in rows if r[1] == "metrocard"}
charts["omny"] = {
    "years": years,
    "omny_pct": [round(100 * omny.get(y, 0) / (omny.get(y, 0) + mc.get(y, 0)), 1) for y in years],
    "omny": [omny.get(y, 0) for y in years],
    "metrocard": [mc.get(y, 0) for y in years],
}

rows = con.execute(
    f"SELECT borough, sai_median, sai_mean, pct_sheltered, pct_ramp, pct_seating, n_stops FROM read_parquet('{(OUT_ROOT / 'sai' / 'sai_borough_summary.parquet').as_posix()}') ORDER BY sai_median DESC"
).fetchall()
charts["sai_borough"] = {
    "borough": [r[0] for r in rows],
    "median": [round(r[1], 1) for r in rows],
    "mean": [round(r[2], 1) for r in rows],
    "pct_sheltered": [r[3] for r in rows],
    "pct_seating": [r[5] for r in rows],
    "n_stops": [r[6] for r in rows],
}

rows = con.execute(
    f"SELECT borough, none, one_side, both_sides, total FROM read_parquet('{(OUT_ROOT / 'sidewalk' / '01_coverage_borough_summary.parquet').as_posix()}') WHERE borough <> 'Citywide' ORDER BY total DESC"
).fetchall()
charts["coverage"] = {
    "borough": [r[0] for r in rows],
    "pct_both": [round(100 * r[3] / r[4], 1) for r in rows],
    "pct_one": [round(100 * r[2] / r[4], 1) for r in rows],
    "pct_none": [round(100 * r[1] / r[4], 1) for r in rows],
}

(CONTENT / "chartdata.json").write_text(json.dumps(charts, indent=0), encoding="utf-8")
print("  chartdata.json written")

# ---------------------------------------------------------------- download extracts
# Stage the served download extracts into OUT_ROOT so the box sync (REFRESH.md B3,
# which tars OUT_ROOT to the box) ships them and /api/downloads can resolve them.
# The daily headways CSV updates in place; access GeoParquet/CSVs are derived here.
# D-4 discipline: geospatial -> GeoParquet; tabular -> CSV/XLSX/Parquet (no plain JSON).
try:
    import geopandas as gpd  # noqa: F401
    _HAVE_GPD = True
except Exception:
    _HAVE_GPD = False

HEADWAYS_SRC = ANALYSIS / "headways_dataset"
ACCESS_SRC = ANALYSIS / "access"

# S2 — NYC Observed Bus Headways (beta): all-days Parquet + datapackage + latest daily CSV.
hw_out = OUT_ROOT / "headways_dataset"
hw_out.mkdir(parents=True, exist_ok=True)
allp = HEADWAYS_SRC / "observed_bus_headways_all.parquet"
if allp.exists():
    shutil.copy2(allp, hw_out / "observed_bus_headways_all.parquet")
dp = HEADWAYS_SRC / "datapackage.json"
if dp.exists():
    shutil.copy2(dp, hw_out / "datapackage.json")
csvs = sorted((HEADWAYS_SRC / "data").glob("observed_bus_headways_*.csv"))
if csvs:
    shutil.copy2(csvs[-1], hw_out / "observed_bus_headways_latest.csv")
    print(f"  headways extract: staged {csvs[-1].name} -> latest.csv (+ all.parquet, datapackage)")

# S4 — Access & isochrones: isochrone grid as GeoParquet (from geom_wkt, EPSG:4326),
# jobs-accessibility-by-block CSV, access-equity CSV/XLSX/Parquet.
acc_out = OUT_ROOT / "access"
acc_out.mkdir(parents=True, exist_ok=True)
iso = ACCESS_SRC / "isochrone_grid_45min.parquet"
if iso.exists() and _HAVE_GPD:
    df = con.execute(
        f"SELECT * FROM read_parquet('{iso.as_posix()}') WHERE geom_wkt IS NOT NULL"
    ).df()
    geom = gpd.GeoSeries.from_wkt(df.pop("geom_wkt"), crs="EPSG:4326")
    gdf = gpd.GeoDataFrame(df, geometry=geom, crs="EPSG:4326")
    gdf.to_parquet(acc_out / "isochrone_grid_45min.geoparquet")
    print(f"  isochrone extract: {len(gdf)} cells -> isochrone_grid_45min.geoparquet")
jobs = ACCESS_SRC / "jobs_accessibility_block.parquet"
if jobs.exists():
    con.execute(
        f"COPY (SELECT * FROM read_parquet('{jobs.as_posix()}')) "
        f"TO '{(acc_out / 'jobs_accessibility_block.csv').as_posix()}' (HEADER, DELIMITER ',')"
    )
for ext in ("parquet", "xlsx"):
    src = ACCESS_SRC / f"access_equity.{ext}"
    if src.exists():
        shutil.copy2(src, acc_out / f"access_equity.{ext}")
eqp = ACCESS_SRC / "access_equity.parquet"
if eqp.exists():
    con.execute(
        f"COPY (SELECT * FROM read_parquet('{eqp.as_posix()}')) "
        f"TO '{(acc_out / 'access_equity.csv').as_posix()}' (HEADER, DELIMITER ',')"
    )
    print("  access-equity extract: access_equity.{csv,parquet,xlsx} staged")
# S7 renters aggregates already live under OUT_ROOT/renters/ (build outputs) — no staging.
print("  download extracts staged")
