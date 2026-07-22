#!/usr/bin/env python3
"""
S3 GTFS snapshot engine (Jane / nycvisualizer NYC Platform).

Fetches the DYNAMIC GTFS static feeds (supplemented subway + 6 NYCT/MTA bus feeds),
computes a LOGICAL content hash, and stores a snapshot ONLY when that hash differs
from the latest already recorded for the feed:

    changes/gtfs_snapshots/<feed>/<UTC-ts>_<hash8>.zip
    changes/gtfs_snapshots/SNAPSHOT_INDEX.json   (feed -> [ {ts, hash, bytes, ...} ])

Disk discipline (D: is under pressure): dedup is by LOGICAL content hash (see
_common.content_hash), so the supplemented feed's hourly re-zip of an UNCHANGED
schedule is NOT stored again. Snapshots are ~5-20MB and kept only on a real change.

Seeding: the existing static pulls under data/raw/transit_static are recorded as the
BASELINE snapshots (hashed in place, referenced by relative path — the files are NOT
copied). Baseline entries carry "source":"baseline_static" and a "ref" path instead of
a stored "path".

Public-repo hygiene: no absolute workspace-root literals; root via NYCV_PIPELINE_ROOT.

Usage:
    python snapshot.py                # seed baselines (idempotent) + fetch live feeds
    python snapshot.py --seed-only    # only (re)seed baselines from disk, no network
    python snapshot.py --no-seed      # only fetch live feeds
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import requests

from _common import (
    INDEX_FILE, SNAP_DIR, STATIC_ROOT, content_hash, rel_to_platform,
)

S3 = "https://rrgtfsfeeds.s3.amazonaws.com/"
USER_AGENT = "nycvisualizer-jane-gtfs-snap/1.0 (civic data research; andenick@gmail.com)"
HTTP_TIMEOUT = 60

# Live feeds we actively re-fetch on the 6-hourly cadence.
#   feed_key -> (download url, baseline dir under transit_static, baseline primary file)
LIVE_FEEDS = {
    "gtfs_supplemented":       (S3 + "gtfs_supplemented.zip", "gtfs_subway_supplemented", "gtfs_supplemented.zip"),
    "gtfs_bus_bronx":          (S3 + "gtfs_bx.zip",           "gtfs_bus_bronx",           "gtfs_bx.zip"),
    "gtfs_bus_brooklyn":       (S3 + "gtfs_b.zip",            "gtfs_bus_brooklyn",        "gtfs_b.zip"),
    "gtfs_bus_manhattan":      (S3 + "gtfs_m.zip",            "gtfs_bus_manhattan",       "gtfs_m.zip"),
    "gtfs_bus_queens":         (S3 + "gtfs_q.zip",            "gtfs_bus_queens",          "gtfs_q.zip"),
    "gtfs_bus_staten_island":  (S3 + "gtfs_si.zip",           "gtfs_bus_staten_island",   "gtfs_si.zip"),
    "gtfs_bus_mta_bus_company":(S3 + "gtfs_busco.zip",        "gtfs_bus_mta_bus_company", "gtfs_busco.zip"),
}

# Static-only baselines (not re-fetched here, but recorded so their vintage is a
# first-class snapshot available for diffing — e.g. the base subway 20260526 vintage).
#   feed_key -> (baseline dir, baseline primary file)
STATIC_BASELINES = {
    "gtfs_subway_base": ("gtfs_subway", "gtfs_subway.zip"),
    "gtfs_ferry":       ("gtfs_ferry", "gtfs.zip"),
    "gtfs_lirr":        ("gtfs_lirr", "gtfslirr.zip"),
    "gtfs_mnr":         ("gtfs_mnr", "gtfsmnr.zip"),
}


def utc_now_ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def load_index() -> dict:
    if INDEX_FILE.exists():
        return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    return {"generated_by": "snapshot.py", "feeds": {}}


def save_index(idx: dict) -> None:
    idx["updated_at"] = utc_now_ts()
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(idx, indent=2), encoding="utf-8")


def latest_hash(idx: dict, feed: str) -> str | None:
    snaps = idx["feeds"].get(feed, {}).get("snapshots", [])
    return snaps[-1]["hash"] if snaps else None


def _feed_entry(idx: dict, feed: str, url: str | None) -> dict:
    fe = idx["feeds"].setdefault(feed, {"url": url, "snapshots": []})
    if url and not fe.get("url"):
        fe["url"] = url
    return fe


def _read_provenance(dirn: str) -> dict:
    p = STATIC_ROOT / dirn / "PROVENANCE.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _baseline_ts(prov: dict) -> str:
    """Prefer a versioned timestamp; fall back to retrieved_at; else epoch-ish."""
    fv = str(prov.get("feed_version", "") or "")
    # bus feeds: "gtfs_bx_20260611T155333Z" -> pull trailing token
    if "T" in fv and fv.endswith("Z"):
        tok = fv.split("_")[-1]
        if len(tok) >= 15 and tok.endswith("Z"):
            return tok
    if fv.isdigit() and len(fv) == 8:
        return f"{fv}T000000Z"
    ra = str(prov.get("retrieved_at", "") or "")
    if ra:
        return ra.replace("-", "").replace(":", "")
    return "00000000T000000Z"


def seed_baselines(idx: dict) -> list[str]:
    """Record each on-disk static GTFS zip as a baseline snapshot (referenced in place)."""
    notes = []
    all_baselines = {**{k: (v[1], v[2]) for k, v in LIVE_FEEDS.items()}, **STATIC_BASELINES}
    for feed, (dirn, primary) in sorted(all_baselines.items()):
        zpath = STATIC_ROOT / dirn / primary
        if not zpath.exists():
            notes.append(f"SKIP baseline {feed}: missing {zpath.name}")
            continue
        url = LIVE_FEEDS[feed][0] if feed in LIVE_FEEDS else None
        fe = _feed_entry(idx, feed, url)
        h = content_hash(zpath)
        # already seeded (any snapshot with this hash)?
        if any(s["hash"] == h for s in fe["snapshots"]):
            continue
        prov = _read_provenance(dirn)
        ts = _baseline_ts(prov)
        fe["snapshots"].append({
            "ts": ts,
            "hash": h,
            "hash8": h[:8],
            "bytes": zpath.stat().st_size,
            "source": "baseline_static",
            "ref": rel_to_platform(zpath),
            "feed_version": prov.get("feed_version", ""),
            "retrieved_at": prov.get("retrieved_at", ""),
        })
        fe["snapshots"].sort(key=lambda s: s["ts"])
        notes.append(f"SEEDED baseline {feed}: {ts} {h[:8]} ({zpath.stat().st_size:,} B)")
    return notes


def fetch_feed(feed: str, url: str) -> tuple[bytes, None] | tuple[None, str]:
    try:
        r = requests.get(url, timeout=HTTP_TIMEOUT, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        return r.content, None
    except Exception as e:  # transient network -> report, don't crash the cycle
        return None, f"{type(e).__name__}: {e}"


def snapshot_live(idx: dict) -> list[str]:
    notes = []
    for feed, (url, _dir, _pf) in LIVE_FEEDS.items():
        fe = _feed_entry(idx, feed, url)
        content, err = fetch_feed(feed, url)
        if err:
            notes.append(f"FETCH-FAIL {feed}: {err}")
            continue
        # write to a temp file so content_hash can read via zipfile
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)
        try:
            h = content_hash(tmp_path)
        except Exception as e:
            notes.append(f"HASH-FAIL {feed}: {type(e).__name__}: {e} (not a valid zip?)")
            tmp_path.unlink(missing_ok=True)
            continue
        prev = latest_hash(idx, feed)
        if h == prev:
            notes.append(f"NO-CHANGE {feed}: {h[:8]} (already latest; not stored)")
            tmp_path.unlink(missing_ok=True)
            continue
        # CHANGED (or first live) -> store
        ts = utc_now_ts()
        dest_dir = SNAP_DIR / feed
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{ts}_{h[:8]}.zip"
        dest.write_bytes(content)
        fe["snapshots"].append({
            "ts": ts,
            "hash": h,
            "hash8": h[:8],
            "bytes": len(content),
            "source": "live_fetch",
            "path": rel_to_platform(dest),
            "url": url,
        })
        fe["snapshots"].sort(key=lambda s: s["ts"])
        tag = "FIRST-LIVE" if prev is None else "CHANGED"
        notes.append(f"STORED {tag} {feed}: {ts} {h[:8]} ({len(content):,} B) -> {dest.name}")
        tmp_path.unlink(missing_ok=True)
    return notes


def main() -> int:
    ap = argparse.ArgumentParser(description="GTFS snapshot engine (content-hash dedup).")
    ap.add_argument("--seed-only", action="store_true", help="only seed baselines from disk")
    ap.add_argument("--no-seed", action="store_true", help="skip baseline seeding")
    args = ap.parse_args()

    idx = load_index()
    notes: list[str] = []
    if not args.no_seed:
        notes += seed_baselines(idx)
    if not args.seed_only:
        notes += snapshot_live(idx)
    save_index(idx)

    print("=== snapshot.py ===")
    for n in notes:
        print("  " + n)
    stored = sum(1 for n in notes if n.startswith(("STORED", "SEEDED")))
    print(f"--- {stored} snapshot record(s) written; index: {rel_to_platform(INDEX_FILE)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
