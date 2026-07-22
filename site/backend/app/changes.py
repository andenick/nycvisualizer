"""Service-change monitor (S8) — reads the S3 GTFS diff engine's JSONL outputs.

The S3 snapshot+diff engine (../../changes/) writes structured schedule-change
records to `changes/deltas/<feed>__<from_ts>__to__<to_ts>.jsonl` and a human
CHANGELOG.md. This module turns those records into:

  * a paginated, filterable change list (`/api/changes`)
  * a machine feed (`/api/changes/feed.json`, newest 200)
  * an RSS 2.0 feed (`/api/changes/rss`, optionally `?route=M15`)

Honest semantics (mirrors changes/README.md "Feed semantics"):
  * The supplemented subway feed folds in the NEXT ~7 DAYS of planned service
    (weekend GO track work, temporary reroutes). A change seen in a supplemented
    diff is therefore PLANNED / TEMPORARY until it is observed persisting across
    later snapshots — we do NOT guess "permanent" prematurely. A change is only
    upgraded to PERSISTED once its signature recurs across multiple diff pairs.
  * Base/bus feeds use repeating calendars → a change there is a real schedule
    edit and is labelled PERSISTED.
  * The base-vs-supplemented "proof" diff is a deliberate one-off backfill whose
    raw trip-count drops are a feed-structure artifact, not a service cut; it is
    flagged `is_proof` and hidden from the default list.

Root is env-parameterized (CHANGES_ROOT), never hardcoded — same convention as
the S3 engine and the rest of the backend.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from email.utils import format_datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from . import config

# changes/ lives next to site/ under the platform root:  site/ -> NYCPlatform/ ; changes/ is a sibling.
CHANGES_ROOT: Path = Path(
    os.environ.get("CHANGES_ROOT", str(config.PLATFORM_ROOT / "changes"))
)
DELTAS_DIR: Path = CHANGES_ROOT / "deltas"

# Absolute base for feed/RSS <link> elements (RSS requires absolute URLs).
SITE_BASE: str = os.environ.get(
    "NYCV_SITE_BASE", "https://nycvisualizer.heterodata.org"
).rstrip("/")
CHANGES_PAGE_PATH = "/observatory/changes"

_WINDOW_PRETTY = {
    "am_peak": "AM peak",
    "midday": "midday",
    "pm_peak": "PM peak",
    "evening": "evening",
}

# Bus feed key -> borough. Subway/dated feeds have no single borough.
_FEED_BOROUGH = {
    "gtfs_bus_bronx": "Bronx",
    "gtfs_bus_brooklyn": "Brooklyn",
    "gtfs_bus_manhattan": "Manhattan",
    "gtfs_bus_queens": "Queens",
    "gtfs_bus_staten_island": "Staten Island",
    "gtfs_bus_mta_bus_company": "MTA Bus Company",
}


# --------------------------------------------------------------------------- #
# small formatters (shared by the list, feed.json and RSS so phrasing matches)
# --------------------------------------------------------------------------- #
def _num(x: Any) -> str:
    """1.5 -> '1.5', 12.0 -> '12', 5 -> '5'."""
    try:
        f = float(x)
    except (TypeError, ValueError):
        return str(x)
    return str(int(f)) if f == int(f) else str(f)


def _signed_pct(pct: Any) -> str:
    try:
        f = float(pct)
    except (TypeError, ValueError):
        return str(pct)
    return f"{f:+.1f}%"


def _mins_human(m: Any) -> str:
    try:
        v = int(round(float(m)))
    except (TypeError, ValueError):
        return str(m)
    sign = "-" if v < 0 else "+"
    v = abs(v)
    if v < 60:
        return f"{sign}{v} min"
    return f"{sign}{v // 60}h{v % 60:02d}m"


def _borough(feed: str, route_id: str) -> str:
    if feed in _FEED_BOROUGH:
        return _FEED_BOROUGH[feed]
    if feed == "gtfs_supplemented" or feed.startswith("proof"):
        # SIR is Staten Island; the rest of the supplemented feed is the subway system.
        if str(route_id).upper() in {"SIR", "SI"}:
            return "Staten Island"
        return "Subway"
    # Fallback: infer from bus route prefix (Bx/B/M/Q/S...).
    r = str(route_id).upper()
    if r.startswith("BX"):
        return "Bronx"
    if r.startswith("Q"):
        return "Queens"
    if r.startswith("B"):
        return "Brooklyn"
    if r.startswith("M"):
        return "Manhattan"
    if r.startswith("S"):
        return "Staten Island"
    return "Other"


def _service_dir(magnitude: float, change_type: str) -> str:
    """less service / more service, from the sign convention S3 uses."""
    if change_type == "headway_delta":
        return "less service" if magnitude > 0 else "more service"
    if change_type == "trip_count_delta":
        return "less service" if magnitude < 0 else "more service"
    return ""


def _summary(rec: dict, temporary: bool) -> str:
    """Plain-language phrase in the CHANGELOG.md style."""
    ct = rec["change_type"]
    d = rec.get("detail", {})
    route = d.get("route_name") or rec.get("route_id") or "?"
    window_note = " (planned work window)" if temporary else ""

    if ct == "headway_delta":
        period = str(d.get("service_period", "")).capitalize()
        win = _WINDOW_PRETTY.get(d.get("tod_window", ""), d.get("tod_window", ""))
        a = _num(d.get("from_headway_min"))
        b = _num(d.get("to_headway_min"))
        sd = _service_dir(float(rec.get("magnitude", 0)), ct)
        return f"{route}: {period} {win} headway {a} → {b} min — {sd}{window_note}"

    if ct == "trip_count_delta":
        a = _num(d.get("from_trips"))
        b = _num(d.get("to_trips"))
        sd = _service_dir(float(rec.get("magnitude", 0)), ct)
        return (
            f"{route}: daily scheduled trips {a} → {b} "
            f"({_signed_pct(d.get('pct'))}) — {sd}{window_note}"
        )

    if ct == "service_span_change":
        period = str(d.get("service_period", "")).capitalize()
        parts = []
        if d.get("d_first_min"):
            parts.append(f"first trip {_mins_human(d['d_first_min'])}")
        if d.get("d_last_min"):
            parts.append(f"last trip {_mins_human(d['d_last_min'])}")
        tail = ", ".join(parts) if parts else "span shifted"
        return (
            f"{route}: {period} service span "
            f"{d.get('from_first')}–{d.get('from_last')} → "
            f"{d.get('to_first')}–{d.get('to_last')} ({tail}){window_note}"
        )

    if ct in ("route_added", "route_removed"):
        verb = "added to" if ct == "route_added" else "removed from"
        return f"{route}: route {verb} the schedule{window_note}"

    if ct in ("stop_added", "stop_removed"):
        verb = "added" if ct == "stop_added" else "removed"
        return f"{route}: stop {d.get('stop_id', '')} {verb}{window_note}"

    if ct == "stop_relocated":
        return f"{route}: stop {d.get('stop_id', '')} moved {_num(d.get('meters'))} m{window_note}"

    if ct == "shape_change":
        n = d.get("n_trips") or d.get("count") or rec.get("magnitude")
        return f"{route}: {_num(n)} trip(s) changed routing (shape){window_note}"

    # generic fallback — never drop a record silently
    return f"{route}: {ct.replace('_', ' ')}{window_note}"


def _parse_ts(ts: str) -> datetime:
    """'20260721T225813Z' or '20260526_base' -> aware UTC datetime (best effort)."""
    core = ts.split("_")[0]  # strip seeded-baseline suffixes like '_base'
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            return datetime.strptime(core, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return datetime(1970, 1, 1, tzinfo=timezone.utc)


def _change_id(rec: dict) -> str:
    key = "|".join(
        [
            str(rec.get("feed")),
            str(rec.get("from_ts")),
            str(rec.get("to_ts")),
            str(rec.get("change_type")),
            str(rec.get("route_id")),
            json.dumps(rec.get("detail", {}), sort_keys=True),
        ]
    )
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


# --------------------------------------------------------------------------- #
# loading (mtime-cached so a fresh snapshot cycle is picked up automatically)
# --------------------------------------------------------------------------- #
def _deltas_signature() -> tuple:
    if not DELTAS_DIR.exists():
        return ()
    return tuple(
        sorted((p.name, p.stat().st_mtime_ns) for p in DELTAS_DIR.glob("*.jsonl"))
    )


@lru_cache(maxsize=8)
def _load_cached(_sig: tuple) -> list[dict]:
    return _load_all()


def _iter_records() -> Iterable[dict]:
    if not DELTAS_DIR.exists():
        return
    for path in sorted(DELTAS_DIR.glob("*.jsonl")):
        try:
            with path.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue


def _load_all() -> list[dict]:
    raw = list(_iter_records())

    # Persistence: a (feed, route, change_type + service signature) that recurs
    # across >1 distinct diff pair is treated as PERSISTED rather than planned.
    sig_pairs: dict[tuple, set] = {}
    for r in raw:
        d = r.get("detail", {})
        sig = (
            r.get("feed"),
            r.get("route_id"),
            r.get("change_type"),
            d.get("service_period"),
            d.get("tod_window"),
            d.get("direction"),
        )
        sig_pairs.setdefault(sig, set()).add((r.get("from_ts"), r.get("to_ts")))

    out: list[dict] = []
    for r in raw:
        feed = str(r.get("feed", ""))
        route_id = str(r.get("route_id", ""))
        ct = str(r.get("change_type", ""))
        d = r.get("detail", {})
        sig = (feed, route_id, ct, d.get("service_period"), d.get("tod_window"), d.get("direction"))
        recur = len(sig_pairs.get(sig, set()))

        is_proof = feed.startswith("proof") or "vs_base" in feed
        dated = feed == "gtfs_supplemented" or is_proof
        temporary = dated and recur < 2  # planned window until it recurs
        detected = _parse_ts(str(r.get("to_ts", "")))

        out.append(
            {
                "id": _change_id(r),
                "feed": feed,
                "route_id": route_id,
                "route_name": d.get("route_name") or route_id,
                "change_type": ct,
                "borough": _borough(feed, route_id),
                "summary": _summary(r, temporary),
                "classification": "temporary" if temporary else "persisted",
                "is_proof": is_proof,
                "service_direction": _service_dir(float(r.get("magnitude", 0) or 0), ct),
                "magnitude": r.get("magnitude"),
                "from_ts": r.get("from_ts"),
                "to_ts": r.get("to_ts"),
                "detected_at": detected.isoformat(),
                "detail": d,
            }
        )

    # newest first, then largest absolute magnitude
    out.sort(
        key=lambda c: (c["detected_at"], abs(float(c.get("magnitude", 0) or 0))),
        reverse=True,
    )
    return out


def load_changes() -> list[dict]:
    return _load_cached(_deltas_signature())


# --------------------------------------------------------------------------- #
# query / serialization helpers used by the API layer
# --------------------------------------------------------------------------- #
def _filter(
    changes: list[dict],
    *,
    feed: str | None = None,
    route: str | None = None,
    change_type: str | None = None,
    borough: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    include_proof: bool = False,
) -> list[dict]:
    def keep(c: dict) -> bool:
        if not include_proof and c["is_proof"]:
            return False
        if feed and c["feed"] != feed:
            return False
        if route and str(c["route_id"]).upper() != route.upper():
            return False
        if change_type and c["change_type"] != change_type:
            return False
        if borough and c["borough"] != borough:
            return False
        if date_from and c["detected_at"][:10] < date_from:
            return False
        if date_to and c["detected_at"][:10] > date_to:
            return False
        return True

    return [c for c in changes if keep(c)]


def query(
    *,
    page: int = 1,
    page_size: int = 50,
    feed: str | None = None,
    route: str | None = None,
    change_type: str | None = None,
    borough: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    include_proof: bool = False,
) -> dict:
    all_changes = load_changes()
    filtered = _filter(
        all_changes,
        feed=feed,
        route=route,
        change_type=change_type,
        borough=borough,
        date_from=date_from,
        date_to=date_to,
        include_proof=include_proof,
    )
    page = max(1, page)
    page_size = max(1, min(500, page_size))
    start = (page - 1) * page_size
    window = filtered[start : start + page_size]

    real = [c for c in all_changes if not c["is_proof"]]
    return {
        "total": len(filtered),
        "page": page,
        "page_size": page_size,
        "returned": len(window),
        "counts": {
            "detected": len(real),
            "proof_backfill": len(all_changes) - len(real),
            "temporary": sum(1 for c in real if c["classification"] == "temporary"),
            "persisted": sum(1 for c in real if c["classification"] == "persisted"),
        },
        "facets": _facets(all_changes),
        "detection_began": "2026-07-21",
        "changes": window,
    }


def _facets(changes: list[dict]) -> dict:
    real = [c for c in changes if not c["is_proof"]]
    def counts(field: str) -> dict:
        out: dict[str, int] = {}
        for c in real:
            out[c[field]] = out.get(c[field], 0) + 1
        return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))

    return {
        "feed": counts("feed"),
        "change_type": counts("change_type"),
        "borough": counts("borough"),
        "classification": counts("classification"),
    }


def machine_feed(limit: int = 200) -> dict:
    real = [c for c in load_changes() if not c["is_proof"]]
    return {
        "title": "nycvisualizer — NYC transit service changes",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "detection_began": "2026-07-21",
        "count": len(real[:limit]),
        "total_detected": len(real),
        "note": (
            "Supplemented-subway changes reflect the next ~7 days of planned "
            "service and are labelled 'temporary' until observed persisting "
            "across snapshots. History deepens over time."
        ),
        "changes": real[:limit],
    }


def _xml_escape(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def rss(route: str | None = None, limit: int = 200) -> str:
    changes = [c for c in load_changes() if not c["is_proof"]]
    if route:
        changes = [c for c in changes if str(c["route_id"]).upper() == route.upper()]
    changes = changes[:limit]

    scope = f" — route {route.upper()}" if route else ""
    channel_link = SITE_BASE + CHANGES_PAGE_PATH
    self_link = f"{SITE_BASE}/api/changes/rss" + (f"?route={_xml_escape(route)}" if route else "")
    build_date = format_datetime(datetime.now(timezone.utc))

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        "<channel>",
        f"<title>nycvisualizer NYC service changes{_xml_escape(scope)}</title>",
        f"<link>{_xml_escape(channel_link)}</link>",
        f'<atom:link href="{_xml_escape(self_link)}" rel="self" type="application/rss+xml" />',
        "<description>Detected changes in the published NYC transit schedule "
        "(headways, trip counts, service spans, routings). Supplemented-subway "
        "changes are planned/temporary until seen persisting across snapshots.</description>",
        "<language>en-us</language>",
        f"<lastBuildDate>{build_date}</lastBuildDate>",
        "<docs>https://www.rssboard.org/rss-specification</docs>",
    ]
    for c in changes:
        title = _xml_escape(c["summary"])
        guid = c["id"]
        link = f"{channel_link}#{guid}"
        pub = format_datetime(_parse_ts(str(c["to_ts"])))
        badge = "planned/temporary" if c["classification"] == "temporary" else "persisted"
        desc = (
            f"{c['summary']} "
            f"[{badge}; change type: {c['change_type']}; borough: {c['borough']}; "
            f"detected {c['detected_at'][:10]}]"
        )
        lines += [
            "<item>",
            f"<title>{title}</title>",
            f"<link>{_xml_escape(link)}</link>",
            f'<guid isPermaLink="false">{guid}</guid>',
            f"<pubDate>{pub}</pubDate>",
            f"<category>{_xml_escape(c['change_type'])}</category>",
            f"<description>{_xml_escape(desc)}</description>",
            "</item>",
        ]
    lines += ["</channel>", "</rss>"]
    return "\n".join(lines)
