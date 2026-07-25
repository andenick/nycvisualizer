"""Pre-render site content: methodology HTML, data catalog, chart data.

Server-side/pre-rendered per CONTENT_RENDERING_STANDARD -- the SPA never ships or
renders literal markdown. Env-parameterized (no absolute workspace paths):
  OUTPUTS_ROOT   -- analysis outputs (defaults to the analysis outputs tree two
                    levels above the platform root)
  ANALYSIS_ROOT  -- analysis scripts+docs (default <platform>/analysis)
  DATA_ROOT      -- data lake (default <platform>/data)
Writes into <site>/frontend/src/content/.

PUBLICATION-HYGIENE GATE (added 2026-07-25). Everything under src/content/ is shipped to
public visitors -- the methodology tabs are pre-rendered from the pipeline's own working
markdown, which is written for us. On 2026-07-25 that leaked a Windows interpreter path,
absolute workspace output paths, an internal container hostname and internal
research-archive document ids onto the live site. Every render is now checked against
`hygiene.PATTERNS` BEFORE it is written, and the whole content directory is re-checked at
the end; ANY hit aborts this build with a non-zero exit. Fix the SOURCE document --
patching the generated HTML is silently undone by the next run of this script.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import duckdb
import markdown

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hygiene import assert_clean, assert_clean_text  # noqa: E402  (local tool, same dir)

HERE = Path(__file__).resolve()
SITE = HERE.parents[1]
PLATFORM = SITE.parents[0]
OUT_ROOT = Path(os.environ.get("OUTPUTS_ROOT", PLATFORM.parents[1] / "Outputs" / "NYCPlatform"))
ANALYSIS = Path(os.environ.get("ANALYSIS_ROOT", PLATFORM / "analysis"))
DATA = Path(os.environ.get("DATA_ROOT", PLATFORM / "data"))
CONTENT = SITE / "frontend" / "src" / "content"
CONTENT.mkdir(parents=True, exist_ok=True)

MD = markdown.Markdown(extensions=["tables", "fenced_code", "sane_lists"])


def write_checked(out_name: str, text: str) -> None:
    """Gate a content file, THEN write it. A leak aborts the build (exit 2).

    Checked before the write, deliberately: a failed build must not leave a leaking
    artefact on disk where a later `vite build` could pick it up.
    """
    assert_clean_text(text, out_name)
    (CONTENT / out_name).write_text(text, encoding="utf-8")


def render_md(src: Path, out_name: str) -> None:
    html = MD.reset().convert(src.read_text(encoding="utf-8"))
    write_checked(out_name, html)
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
write_checked("data_catalog.json", json.dumps(catalog, indent=0))
print(f"  data_catalog.json: {len(catalog)} datasets")

# ---------------------------------------------------------------- KB context callouts
# The "From the archive" marginalia (components/ContextCallout.tsx). Curated by hand in
# kb_callouts.source.json, which carries an internal `doc` id per passage so we can trace
# each quote back to the document it was verified against.
#
# That id is OURS, not the reader's: it resolves to nothing outside this workspace, and
# CODE_DATA_FIRST_STANDARD s4.2 bars knowledge-base artefact references from reaching a
# visitor. It used to ship -- first visibly beside the source line, then in a title=
# attribute, and either way it was in the JS bundle. It is now STRIPPED here: the shipped
# kb_callouts.json carries the passage, its real published source and its year (the
# provenance a reader can actually use), and nothing a reader cannot resolve.
CALLOUT_SRC = SITE / "content_src" / "kb_callouts.source.json"
if CALLOUT_SRC.exists():
    _raw = json.loads(CALLOUT_SRC.read_text(encoding="utf-8"))
    _public = [{k: v for k, v in c.items() if k not in ("doc", "kb_doc")} for c in _raw]
    write_checked("kb_callouts.json", json.dumps(_public, indent=1))
    print(f"  kb_callouts.json: {len(_public)} callouts (internal doc ids stripped)")
else:
    print(f"  MISSING: {CALLOUT_SRC} — kb_callouts.json left as-is")

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

# Hub-Bound cordon series (Q3.3) — 24-hour persons entering the Manhattan CBD by
# mode, 14 born-digital NYMTC report years. Long parquet -> per-mode arrays.
hb = OUT_ROOT / "cordon" / "hub_bound_series.parquet"
if hb.exists():
    rows = con.execute(
        f"SELECT year, mode, entering FROM read_parquet('{hb.as_posix()}') ORDER BY year"
    ).fetchall()
    years = sorted({int(r[0]) for r in rows})
    modes = ["subway", "auto", "bus", "rail", "ferry", "bike", "tram"]
    by = {(int(r[0]), r[1]): int(r[2]) for r in rows}
    charts["hub_bound"] = {
        "years": years,
        "modes": modes,
        "series": {m: [by.get((y, m), 0) for y in years] for m in modes},
        "total": [sum(by.get((y, m), 0) for m in modes) for y in years],
        # No internal archive document ids here: the reader's provenance is the published
        # NYMTC report series itself, which they can look up. An internal id is an index
        # into our own archive and resolves to nothing for them.
        "source": "NYMTC Hub Bound Travel Report; 24-hour persons "
                  "entering the Manhattan CBD (south of 60th St) by mode. 14 born-digital "
                  "report years; 2010-11 & pre-2007 await re-extraction from scans, "
                  "2021-22 not surveyed (COVID). Ferry excludes the Staten Island Ferry.",
    }
    print(f"  chartdata hub_bound: {len(years)} years")
else:
    print(f"  MISSING: {hb} (run analysis/cordon/build_hub_bound_series.py)")

write_checked("chartdata.json", json.dumps(charts, indent=0))
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

# S2 — NYC Observed Bus Headways (beta).
#
# MOVED 2026-07-25 (W6a defect 4). This staging used to live here, and ONLY here — but
# build_content.py is a SITE-BUILD tool that nothing schedules and that run_derive.ps1
# never calls, while the dataset it stages is regenerated every 30 minutes by
# JaneNYCDerive. The served copy therefore froze at whenever a human last ran a site
# build (measured 2026-07-25: staged 25,691,216 B dated 07-23 01:51 vs produced
# 36,138,004 B dated 07-24 22:21 — two whole service days missing) and the nightly
# JaneNYCDerivedSync faithfully tarred the stale copy to the box, directly under the
# flagship "NYC Observed Bus Headways" dataset on /api/downloads.
#
# The staging now runs in the PRODUCER — realtime/derive2/package_headways.py
# stage_downloads(), called from build(), on every derive cycle — so the served copy
# cannot lag the computed copy by more than one cycle. Re-copying here would be a
# REGRESSION: this block picked `csvs[-1]`, which is always the in-progress UTC day,
# whereas /api/downloads advertises "the most recent COMPLETE service day".
#
# We only VERIFY here, and say so loudly if the producer has not run.
hw_out = OUT_ROOT / "headways_dataset"
_stamp = hw_out / "STAGING.json"
if _stamp.exists():
    _s = json.loads(_stamp.read_text(encoding="utf-8"))
    print(f"  headways extract: staged by package_headways at {_s.get('staged_at')} "
          f"(latest_service_day={_s.get('latest_service_day')}, "
          f"{len(_s.get('files', {}))} files) — not re-copied here")
else:
    print(f"  headways extract: NOT STAGED — no {_stamp}. "
          f"Run: PYTHONIOENCODING=utf-8 python realtime/derive2/package_headways.py")

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

# ---------------------------------------------------------------- hygiene gate (final)
# Each artefact was gated as it was written; this final pass covers the WHOLE shipped
# content directory, so a hand-added or hand-edited file (a curated JSON, a stale render
# from an earlier build) cannot slip through unchecked either. Non-zero exit on any hit.
print("\nPublication-hygiene gate over", CONTENT.as_posix())
assert_clean([CONTENT])
print("  PASS: no internal artefacts in shipped content.")
