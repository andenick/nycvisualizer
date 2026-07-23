"""Assemble the NYMTC Hub-Bound cordon series: persons ENTERING Manhattan's
Central Business District (south of 60th St) by mode, one 24-hour fall business
day per report year.

SOURCE
------
NYMTC "Hub Bound Travel Report", the born-digital report PDFs ingested into the
Jane KB as DOC0346..DOC0374 (H4_NYMTC_HubBound). Each modern report opens with a
"Quick Reference Data - Persons Entering and Leaving the Hub by Mode and Sector"
table (the QRD table), a 24-hour daily total broken out by entry sector
(60th St / Brooklyn / Queens / New Jersey) and by mode, with
Entering / Leaving / Total columns. We take the ENTERING column and SUM across
those sectors to get that year's CBD entries by mode.

SCOPE / FERRY CAVEAT (verified by reconciliation)
-------------------------------------------------
This per-mode-and-sector QRD table carries FOUR entry sectors -- 60th Street,
Brooklyn, Queens, New Jersey -- in every vintage; it does NOT carry a Staten
Island sector. The six major modes (subway, auto, bus, rail, bike, tram)
reconcile EXACTLY with NYMTC's separate all-modes "Persons by Mode" summary
(e.g. 2014: subway 2,252,428 here == NYMTC's 2,252K summary; auto 912,617 ==
913K; bus 262,671 == 263K; rail 318,335 == 318K; bike 27,758 == 28K). FERRY is
the one exception: the Staten Island Ferry is tallied in the omitted Staten
Island sector, so `ferry` here is the East-River + NY-Waterway ferry only and
UNDERSTATES total ferry by the SI Ferry (~30-45k/day). Because the SI sector is
omitted in the same way every year, the series is internally consistent for
year-over-year comparison; the ferry caveat is surfaced on the chart and in
MODE_MAPPING.json rather than silently patched from a second source.

COVERAGE (HONEST)
-----------------
The 85 verified cordon CSVs span 21 born-digital report years (1996-2024), but
only 14 of those years carry the clean, consistently-structured 24-hour QRD
by-mode table in the extracted set. Those 14 years are the series:

    2007, 2008, 2009, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020,
    2023, 2024

Gaps and why (documented, never interpolated):
  * 2010, 2011 -> the extracted tables for these two reports are the by-hour /
    by-sector detail tables, not the clean by-mode QRD table; a by-mode split
    was not recoverable from the born-digital extract without guessing, so they
    are LEFT OUT rather than fabricated. (An AM-peak-only by-mode series for
    2010-2016 exists in the 2016 report's Appendix-III "YEAR/SECTOR/MODE"
    table, but that is a different period definition -- AM peak, not 24-hour --
    and is NOT mixed into this daily series.)
  * 2021, 2022 -> NYMTC published no Hub Bound survey for these years
    (COVID interruption); there is no data to show.
  * 1996-2006 (except 2007-09 here) -> the earlier reports' extracted tables are
    tables-of-contents / appendix indexes / hourly detail, not the by-mode QRD;
    the by-mode split for those years awaits GPU (Hopper) re-extraction of the
    scanned pages and the 1963-1995 archive.

MODE NORMALIZATION (HONEST MAPPING)
-----------------------------------
Report row label (any vintage)                    -> canonical bucket
  SUBWAY / "SUBWAY and PATH" / "SUBWAY/PATH" /
  "Subway & PATH"                                  -> subway
      (PATH is heavy-rail rapid transit; NYMTC groups it inside the subway
       row for the New Jersey sector, so it rides in `subway`.)
  "AUTOS, TAXIS, VANS AND TRUCKS" / "Auto, Van,
  Truck"                                           -> auto
      (persons arriving by private motor vehicle -- includes taxis and trucks;
       this is NYMTC's own combined bucket in every year of the clean set.)
  BUS                                              -> bus
  "SUBURBAN AND INTERCITY RAIL" / "Suburban Rail"  -> rail
      (commuter + intercity rail: LIRR, Metro-North, NJ Transit, Amtrak.)
  FERRY                                            -> ferry
  BICYCLE                                          -> bike
  TRAMWAY                                          -> tram
      (Roosevelt Island Tramway; a very small bucket, kept separate and
       reported honestly rather than folded into another mode.)

A "-" cell (mode absent from a sector) parses as 0.

OUTPUT
------
  Outputs/NYCPlatform/cordon/hub_bound_series.parquet   (long: year, mode, entering)
  Outputs/NYCPlatform/cordon/hub_bound_series.csv
  Outputs/NYCPlatform/cordon/hub_bound_series_wide.csv  (year x mode, + total)
  Outputs/NYCPlatform/cordon/MODE_MAPPING.json          (audit trail: per year,
        which DOC + table file supplied each mode, and the raw row labels seen)

CRS / units: none (tabular counts). EPSG discipline N/A.
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve()
PLATFORM = HERE.parents[2]                       # .../NYCPlatform
JANE = PLATFORM.parents[1]                       # .../Jane
KB = JANE / "Knowledge_Base"
OUT = JANE / "Outputs" / "NYCPlatform" / "cordon"
OUT.mkdir(parents=True, exist_ok=True)

# year -> KB doc dir. Only the 14 years whose report carries the clean 24-hour
# by-mode QRD table in the extracted set (see module docstring).
YEAR_DOC = {
    2007: "DOC0359_b11c320e",
    2008: "DOC0360_b85d80d8",
    2009: "DOC0361_fc2d43c3",
    2012: "DOC0364_a404bb4d",
    2013: "DOC0365_e2076f0a",
    2014: "DOC0366_d3975e8d",
    2015: "DOC0367_d0da3f16",
    2016: "DOC0368_ee199a75",
    2017: "DOC0369_e686f908",
    2018: "DOC0370_35b08a6f",
    2019: "DOC0371_ad2116c6",
    2020: "DOC0372_e8936f0a",
    2023: "DOC0373_d55c353b",
    2024: "DOC0374_0ab21b67",
}

MODE_RULES = [
    ("subway", re.compile(r"^\s*subway", re.I)),
    ("auto", re.compile(r"auto", re.I)),
    ("bus", re.compile(r"^\s*bus\b", re.I)),
    ("rail", re.compile(r"rail", re.I)),
    ("ferry", re.compile(r"ferry", re.I)),
    ("bike", re.compile(r"bicycl", re.I)),
    ("tram", re.compile(r"tram", re.I)),
]
CANON = [m for m, _ in MODE_RULES]


def classify(label: str) -> str | None:
    for bucket, rx in MODE_RULES:
        if rx.search(label):
            return bucket
    return None


def to_int(cell: str) -> int:
    s = (cell or "").strip().replace(",", "")
    if s in ("", "-", "--", "N/A", "n/a"):
        return 0
    m = re.match(r"-?\d+", s)
    return int(m.group()) if m else 0


def is_qrd_table(rows: list[list[str]]) -> bool:
    """A 24-hour by-mode QRD table has an Entering/Leaving/Total header AND at
    least 5 distinct mode buckets in column 0. This distinguishes it from the
    AM-peak YEAR/SECTOR/MODE table (which has year columns, not Entering/Leaving)
    and from tables-of-contents (no Entering/Leaving header)."""
    flat = " ".join(c.lower() for r in rows[:4] for c in r)
    if "entering" not in flat or "leaving" not in flat:
        return False
    buckets = {classify(r[0]) for r in rows if r and classify(r[0])}
    return len(buckets) >= 5


def entering_value(row: list[str]) -> int:
    """The 'Entering' count for a mode row = the FIRST non-empty cell after the
    label (column 0). This is robust to two extracted layouts:
      normal:  SUBWAY,"629,664","628,356",...      -> col 1
      spacer:  SUBWAY,,"834,306",,"809,732",...    -> col 2 (empty spacer at 1)
    A "-" (mode absent from a sector) is the first non-empty cell and parses 0."""
    for c in row[1:]:
        if c.strip() != "":
            return to_int(c)
    return 0


def parse_year(year: int, doc_dir: Path) -> tuple[dict[str, int], dict]:
    """Return {bucket: entering_total} plus an audit dict for the chosen table."""
    tables = sorted((doc_dir / "tables").glob("*.csv"))
    chosen = None
    for f in tables:
        with open(f, encoding="utf-8", errors="replace") as fh:
            rows = list(csv.reader(fh))
        if is_qrd_table(rows):
            chosen = (f, rows)
            break
    if chosen is None:
        raise RuntimeError(f"{year}: no clean 24-hour QRD by-mode table found in {doc_dir.name}")
    f, rows = chosen
    totals = {b: 0 for b in CANON}
    seen_labels: dict[str, list[str]] = {b: [] for b in CANON}
    for r in rows:
        if not r:
            continue
        bucket = classify(r[0])
        if bucket is None:
            continue
        val = entering_value(r)
        totals[bucket] += val
        lbl = r[0].strip()
        if lbl not in seen_labels[bucket]:
            seen_labels[bucket].append(lbl)
    audit = {
        "year": year,
        "doc": doc_dir.name,
        "table_file": f.name,
        "row_labels_by_bucket": seen_labels,
        "entering_by_bucket": totals,
        "total_all_modes": sum(totals.values()),
    }
    return totals, audit


def main() -> None:
    long_rows = []
    audits = []
    for year in sorted(YEAR_DOC):
        doc_dir = KB / YEAR_DOC[year]
        totals, audit = parse_year(year, doc_dir)
        audits.append(audit)
        for bucket in CANON:
            long_rows.append({"year": year, "mode": bucket, "entering": totals[bucket]})
        tot = sum(totals.values())
        print(f"{year}: total {tot:>10,}  "
              + "  ".join(f"{b}={totals[b]:,}" for b in CANON))

    df = pd.DataFrame(long_rows)
    df.to_parquet(OUT / "hub_bound_series.parquet", index=False)
    df.to_csv(OUT / "hub_bound_series.csv", index=False)

    wide = df.pivot(index="year", columns="mode", values="entering").reset_index()
    wide = wide[["year"] + CANON]
    wide["total"] = wide[CANON].sum(axis=1)
    wide.to_csv(OUT / "hub_bound_series_wide.csv", index=False)

    mapping = {
        "series": "NYMTC Hub Bound - persons entering Manhattan CBD (south of 60th St) "
                  "by mode, 24-hour fall business day",
        "source": "NYMTC Hub Bound Travel Report (KB DOC0346-DOC0374)",
        "unit": "persons entering (24-hour count)",
        "years_covered": sorted(YEAR_DOC),
        "n_years": len(YEAR_DOC),
        "gaps": {
            "2010-2011": "extracted tables are hourly/sector detail, not the by-mode QRD; "
                         "by-mode split not recoverable without guessing (omitted, not interpolated)",
            "2021-2022": "NYMTC published no Hub Bound survey (COVID interruption)",
            "pre-2007": "earlier reports' extracted tables are TOC/appendix/hourly detail; "
                        "by-mode QRD awaits GPU re-extraction; 1963-1995 archive still to process",
        },
        "mode_buckets": CANON,
        "mode_mapping_note": "subway includes PATH; auto = private motor vehicle persons "
                             "(autos+taxis+vans+trucks, NYMTC's combined bucket); rail = "
                             "suburban+intercity (LIRR/Metro-North/NJT/Amtrak); tram = "
                             "Roosevelt Island Tramway (kept separate).",
        "scope": "4 entry sectors (60th St, Brooklyn, Queens, New Jersey); the Staten "
                 "Island sector is not in NYMTC's per-mode-and-sector QRD table.",
        "ferry_caveat": "ferry EXCLUDES the Staten Island Ferry (tallied in the omitted "
                        "Staten Island sector); understates total ferry by ~30-45k/day. "
                        "subway/auto/bus/rail/bike/tram reconcile exactly with NYMTC's "
                        "all-modes summary.",
        "per_year_audit": audits,
    }
    (OUT / "MODE_MAPPING.json").write_text(json.dumps(mapping, indent=2), encoding="utf-8")

    print(f"\nwrote {OUT/'hub_bound_series.parquet'}  ({len(df)} rows, {len(YEAR_DOC)} years)")
    print(f"wrote {OUT/'hub_bound_series.csv'}")
    print(f"wrote {OUT/'hub_bound_series_wide.csv'}")
    print(f"wrote {OUT/'MODE_MAPPING.json'}")


if __name__ == "__main__":
    main()
