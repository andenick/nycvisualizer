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
