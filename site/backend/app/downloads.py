"""Download registry + file serving (D-4 carve-out compliant).

Geospatial layers ship GeoJSON + GeoParquet; tabular data ships CSV/XLSX/Parquet —
never plain JSON for tabular. Whitelist registry only (no path traversal); every
entry carries the correct content-type and an honest note where the web layer is
simplified. Roots are env-parameterized (OUTPUTS_ROOT), never hardcoded.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from . import config

OUTPUTS_ROOT = Path(
    os.environ.get("OUTPUTS_ROOT", config.PLATFORM_ROOT.parents[1] / "Outputs" / "NYCPlatform")
)

CT = {
    ".geojson": "application/geo+json",
    ".geoparquet": "application/octet-stream",
    ".parquet": "application/octet-stream",
    ".csv": "text/csv; charset=utf-8",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

# key -> (relative path under OUTPUTS_ROOT, label, group, note)
_ITEMS: dict[str, tuple[str, str, str, str]] = {
    # --- Stop Accessibility Index (geospatial) ---
    "sai_stops.geojson": ("sai/sai_stops.geojson", "SAI per-stop layer (GeoJSON, full attributes)", "SAI", ""),
    "sai_stops.geoparquet": ("sai/sai_stops.geoparquet", "SAI per-stop layer (GeoParquet)", "SAI", ""),
    # --- SAI tables (tabular) ---
    "sai_scores.parquet": ("sai/sai_scores.parquet", "SAI scores, all 13,621 stops (Parquet)", "SAI", ""),
    "sai_scores.xlsx": ("sai/sai_scores.xlsx", "SAI scores, all stops (XLSX)", "SAI", ""),
    "sai_borough_summary.parquet": ("sai/sai_borough_summary.parquet", "SAI borough summary (Parquet)", "SAI", ""),
    "sai_borough_summary.xlsx": ("sai/sai_borough_summary.xlsx", "SAI borough summary (XLSX)", "SAI", ""),
    "sai_best50.xlsx": ("sai/sai_best50.xlsx", "Best-50 stops league table (XLSX)", "SAI", ""),
    "sai_worst50.xlsx": ("sai/sai_worst50.xlsx", "Worst-50 stops league table (XLSX)", "SAI", ""),
    # --- Sidewalk (geospatial) ---
    "sidewalk_coverage_segments.geoparquet": (
        "web_extracts/sidewalk_coverage_segments.geoparquet",
        "Segment coverage classes, 96,553 CSCL segments (GeoParquet, full res)", "Sidewalk", ""),
    "nta_sidewalk_equity.geojson": (
        "web_extracts/nta_sidewalk_equity.geojson", "NTA sidewalk equity (GeoJSON, full res)", "Sidewalk", ""),
    "nta_sidewalk_equity.geoparquet": (
        "web_extracts/nta_sidewalk_equity.geoparquet", "NTA sidewalk equity (GeoParquet)", "Sidewalk", ""),
    "ada_ramp_gaps.geojson": (
        "web_extracts/ada_ramp_gaps.geojson", "Intersections lacking ramps (GeoJSON)", "Sidewalk", ""),
    "ada_ramp_gaps.geoparquet": (
        "web_extracts/ada_ramp_gaps.geoparquet", "Intersections lacking ramps (GeoParquet)", "Sidewalk", ""),
    "ada_ramp_gaps.csv": (
        "web_extracts/ada_ramp_gaps.csv", "Intersections lacking ramps, attributes (CSV)", "Sidewalk", ""),
    # --- Sidewalk tables (tabular) ---
    "coverage_segments.parquet": (
        "sidewalk/01_coverage_segments.parquet", "Segment coverage classes, attributes only (Parquet)", "Sidewalk", ""),
    "coverage_segments.xlsx": (
        "sidewalk/01_coverage_segments.xlsx", "Segment coverage classes (XLSX)", "Sidewalk", ""),
    "width_segments.parquet": (
        "sidewalk/02_width_segments.parquet", "Per-segment width estimates (Parquet)", "Sidewalk",
        "width is a 2*Area/Perimeter proxy; validation r=0.47 vs inscribed width"),
    "block_equity.parquet": ("sidewalk/03_block_equity.parquet", "Block-level equity table (Parquet)", "Sidewalk", ""),
    "block_equity.xlsx": ("sidewalk/03_block_equity.xlsx", "Block-level equity workbook (XLSX)", "Sidewalk", ""),
    "nta_coverage.parquet": ("sidewalk/03_nta_coverage.parquet", "NTA coverage table (Parquet)", "Sidewalk", ""),
    "condition_cdta.xlsx": ("sidewalk/04_condition_cdta.xlsx", "Condition composite by community district (XLSX)", "Sidewalk", ""),
    "accessibility_nta.xlsx": ("sidewalk/05_accessibility_nta.xlsx", "Ramp coverage by NTA (XLSX)", "Sidewalk", ""),
    # --- Bus (tabular) ---
    "bus_route_boardings.parquet": ("bus/01_route_total_boardings.parquet", "Lifetime boardings per route (Parquet)", "Bus", ""),
    "bus_route_boardings.xlsx": ("bus/01_route_total_boardings.xlsx", "Lifetime boardings per route (XLSX)", "Bus", ""),
    "bus_fare_by_year.parquet": ("bus/01_fare_payment_by_year.parquet", "OMNY vs MetroCard by year (Parquet)", "Bus", ""),
    "bus_fare_by_year.xlsx": ("bus/01_fare_payment_by_year.xlsx", "OMNY vs MetroCard by year (XLSX)", "Bus", ""),
    "bus_route_peak_speed.parquet": ("bus/02_route_peak_speed.parquet", "Route peak speeds (Parquet)", "Bus", ""),
    "bus_slowest_segments.xlsx": ("bus/02_slowest_segments_peak.xlsx", "Slowest segments league table (XLSX)", "Bus", ""),
    "bus_most_crowded.xlsx": ("bus/03_most_crowded_routes.xlsx", "Most-crowded routes (XLSX)", "Bus", ""),
    "bus_observed_headways.parquet": ("bus/04_observed_headways_route.parquet", "Observed headways per route (Parquet, preliminary)", "Bus",
                                       "~2h of realtime archive; preliminary"),
}


def inventory() -> list[dict[str, Any]]:
    out = []
    for key, (rel, label, group, note) in _ITEMS.items():
        p = OUTPUTS_ROOT / rel
        if not p.exists():
            continue
        out.append({
            "key": key,
            "label": label,
            "group": group,
            "format": p.suffix.lstrip("."),
            "bytes": p.stat().st_size,
            "note": note,
            "href": f"/api/downloads/{key}",
        })
    return out


def resolve(key: str) -> tuple[Path, str] | None:
    item = _ITEMS.get(key)
    if item is None:
        return None
    p = OUTPUTS_ROOT / item[0]
    if not p.exists():
        return None
    return p, CT.get(p.suffix, "application/octet-stream")
