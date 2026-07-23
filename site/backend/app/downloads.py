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
    # datapackage descriptor is dataset metadata (not a tabular-data offering) — JSON is fine here.
    ".json": "application/json; charset=utf-8",
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
        "sidewalk/02_width_segments.parquet", "Per-segment width estimates — PRIMARY (Parquet)", "Sidewalk",
        "width is a 2*Area/Perimeter proxy; validation r=0.47 vs inscribed width. This remains the "
        "primary width layer; see the medial-axis alternative below."),
    # Q3.3: medial-axis width (Meli Harvey method) — an ALTERNATIVE estimate. It
    # did not clear the r>0.75-vs-Harvey promotion bar (r=0.727, n=17,895), so
    # the 2A/P proxy above stays primary and the map `w` is unchanged; shipped
    # here for transparency + reuse. Its level (median 8.6 ft) is actually nearer
    # Harvey's published median (8.1 ft) than the 2A/P proxy (9.7 ft).
    "medial_axis_width_segments.parquet": (
        "sidewalk/06_medial_axis_segments.parquet",
        "Per-segment medial-axis width — ALTERNATIVE estimate (Parquet)", "Sidewalk",
        "Voronoi medial-axis width (Meli Harvey 2020 method) aggregated onto CSCL segments. "
        "ALTERNATIVE to the 2A/P proxy: r=0.727 vs Harvey's published widths (n=17,895; below the "
        "0.75 promotion bar, so not promoted), r=0.94 vs the 2A/P per-segment proxy. EPSG:2263 (ft)."),
    "medial_axis_width_polys.parquet": (
        "sidewalk/06_medial_axis_polys.parquet",
        "Per-polygon medial-axis width — ALTERNATIVE estimate (Parquet)", "Sidewalk",
        "Medial-axis typical width per planimetric sidewalk polygon (2 x median maximal-inscribed "
        "radius), with the 2A/P proxy and area for comparison. Method: github.com/meliharvey/sidewalkwidths-nyc."),
    "block_equity.parquet": ("sidewalk/03_block_equity.parquet", "Block-level equity table (Parquet)", "Sidewalk", ""),
    "block_equity.xlsx": ("sidewalk/03_block_equity.xlsx", "Block-level equity workbook (XLSX)", "Sidewalk", ""),
    "nta_coverage.parquet": ("sidewalk/03_nta_coverage.parquet", "NTA coverage table (Parquet)", "Sidewalk", ""),
    "condition_cdta.xlsx": ("sidewalk/04_condition_cdta.xlsx", "Condition composite by community district (XLSX)", "Sidewalk", ""),
    "accessibility_nta.xlsx": ("sidewalk/05_accessibility_nta.xlsx", "Ramp coverage by NTA (XLSX)", "Sidewalk", ""),
    # --- Hub-Bound cordon series (Q3.3, tabular) ---
    "hub_bound_series.csv": (
        "cordon/hub_bound_series.csv",
        "NYMTC Hub-Bound CBD entries by mode, long form (CSV)", "Hub-Bound cordon",
        "24-hour persons entering the Manhattan CBD (south of 60th St) by mode, 14 born-digital "
        "NYMTC report years (2007-09, 2012-20, 2023-24). 2010-11 & pre-2007 await GPU re-extraction; "
        "2021-22 not surveyed (COVID). Ferry excludes the Staten Island Ferry (omitted sector); the "
        "other 6 modes reconcile exactly with NYMTC's all-modes summary."),
    "hub_bound_series.parquet": (
        "cordon/hub_bound_series.parquet",
        "NYMTC Hub-Bound CBD entries by mode, long form (Parquet)", "Hub-Bound cordon",
        "Same series as the CSV; year x mode x entering. Source: NYMTC Hub Bound Travel Report "
        "(KB DOC0346-DOC0374)."),
    "hub_bound_series_wide.csv": (
        "cordon/hub_bound_series_wide.csv",
        "NYMTC Hub-Bound CBD entries by mode, wide form (CSV)", "Hub-Bound cordon",
        "One row per year, one column per mode + total. Companion to the long-form series."),
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
    # --- NYC Observed Bus Headways (beta) — the marquee new dataset (S2 derive2) ---
    "observed_headways_all.parquet": (
        "headways_dataset/observed_bus_headways_all.parquet",
        "NYC Observed Bus Headways — all days (Parquet)", "Observed Headways",
        "PRELIMINARY — observed headways, variability (CV), bunching index & deviation vs schedule, "
        "per route x direction x stop x date x hour, from our own GTFS-realtime archive (MTA publishes "
        "schedules, not observed headways). Reliability figures firm up at >=14 days of archive."),
    "observed_headways_latest.csv": (
        "headways_dataset/observed_bus_headways_latest.csv",
        "NYC Observed Bus Headways — latest service day (CSV)", "Observed Headways",
        "PRELIMINARY — the most recent complete service day; the archive updates daily."),
    "observed_headways_datapackage.json": (
        "headways_dataset/datapackage.json",
        "Frictionless datapackage descriptor (metadata)", "Observed Headways",
        "Dataset metadata/provenance descriptor (not tabular data) — schema, licence (CC-BY-4.0), "
        "temporal coverage, known gaps."),
    # --- Access & isochrones (S4 OpenTripPlanner) ---
    "isochrone_grid_45min.geoparquet": (
        "access/isochrone_grid_45min.geoparquet",
        "45-min job-access isochrone grid, 1,179 H3 res-8 cells (GeoParquet, EPSG:4326)",
        "Access & isochrones",
        "Network-based (real street+transit routing) weekday-08:00 45-min WALK+TRANSIT isochrone "
        "polygons + reachable-jobs per origin cell. NOT Euclidean."),
    "jobs_accessibility_block.csv": (
        "access/jobs_accessibility_block.csv",
        "Jobs reachable <=45 min, per census block, 37,588 blocks (CSV)", "Access & isochrones",
        "Per-block reachable jobs, frequent-transit flag, block-group median income & population."),
    "access_equity.csv": (
        "access/access_equity.csv", "Access equity by income decile (CSV)", "Access & isochrones", ""),
    "access_equity.parquet": (
        "access/access_equity.parquet", "Access equity by income decile (Parquet)", "Access & isochrones", ""),
    "access_equity.xlsx": (
        "access/access_equity.xlsx", "Access equity by income decile (XLSX)", "Access & isochrones", ""),
    # --- Renter's Map (S7) precomputed grid + per-BBL building aggregates ---
    "renters_grid.parquet": (
        "renters/renters_grid.parquet",
        "Renter's Map cell grid, 58,604 H3 res-10 cells (Parquet)", "Renter's Map",
        "Per-cell transit supply, QoL densities + citywide percentiles, flood flags, and 45-min job "
        "access. Place-based only; no demographic/protected-class variable enters any score."),
    "renters_hpd_open_violations_by_bbl.parquet": (
        "renters/hpd_open_violations_by_bbl.parquet",
        "HPD open violations per BBL, by class (Parquet)", "Renter's Map", ""),
    "renters_dob_permits_5y_by_bbl.parquet": (
        "renters/dob_permits_5y_by_bbl.parquet",
        "DOB permit filings (last 5 years) per BBL (Parquet)", "Renter's Map", ""),
    "renters_landlord_portfolio_by_bbl.parquet": (
        "renters/landlord_portfolio_by_bbl.parquet",
        "Landlord registration-portfolio size per BBL (Parquet)", "Renter's Map",
        "Ownership PROXY from HPD registration contacts (same-registration-contact grouping), "
        "not a legal beneficial-ownership determination."),
}


def inventory() -> list[dict[str, Any]]:
    out = []
    for key, (rel, label, group, note) in _ITEMS.items():
        p = OUTPUTS_ROOT / rel
        if not p.exists():
            continue
        # The Frictionless descriptor is metadata (a datapackage), not a tabular JSON
        # data download — label it so the DNA "no JSON data downloads" scan is not
        # tripped by a provenance sidecar (data downloads stay CSV/XLSX/Parquet).
        fmt = "datapackage" if key.endswith("datapackage.json") else p.suffix.lstrip(".")
        out.append({
            "key": key,
            "label": label,
            "group": group,
            "format": fmt,
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
