#!/usr/bin/env python3
"""
S3 orchestrator: snapshot all live feeds, then diff each NEW snapshot against its
immediate predecessor for the same feed. Idempotent — a (from_ts -> to_ts) pair is
diffed once; re-running with no new snapshots is a no-op (beyond re-seeding baselines,
which is itself idempotent).

Resolves snapshot zips to concrete paths: live snapshots have a "path"; baseline
snapshots have a "ref" into data/raw/transit_static (referenced in place, never copied).

Public-repo hygiene: no absolute workspace-root literals; root via NYCV_PIPELINE_ROOT.

Usage:
    python run_diffs.py                 # seed + snapshot + diff new pairs
    python run_diffs.py --no-fetch      # diff-only over whatever snapshots exist
    python run_diffs.py --all-pairs     # (re)diff every consecutive pair, not just new
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import snapshot as snap
import gtfs_diff as gd
from _common import DELTA_DIR, PLATFORM, INDEX_FILE


def _resolve(entry: dict) -> Path | None:
    rel = entry.get("path") or entry.get("ref")
    if not rel:
        return None
    p = (PLATFORM / rel)
    return p if p.exists() else None


def _pair_done(feed: str, from_ts: str, to_ts: str) -> bool:
    return (DELTA_DIR / f"{feed}__{from_ts}__to__{to_ts}.jsonl").exists()


def run(fetch: bool = True, all_pairs: bool = False) -> int:
    idx = snap.load_index()
    if fetch:
        notes = snap.seed_baselines(idx)
        notes += snap.snapshot_live(idx)
        snap.save_index(idx)
        print("=== snapshot phase ===")
        for n in notes:
            print("  " + n)
    else:
        snap.seed_baselines(idx)
        snap.save_index(idx)

    print("=== diff phase ===")
    total_new = 0
    for feed, fe in sorted(idx["feeds"].items()):
        snaps = fe.get("snapshots", [])
        if len(snaps) < 2:
            continue
        # consecutive pairs
        pairs = list(zip(snaps[:-1], snaps[1:]))
        if not all_pairs:
            # only pairs whose 'to' is a newly stored live snapshot (i.e. not yet diffed)
            pairs = [(a, b) for a, b in pairs if not _pair_done(feed, a["ts"], b["ts"])]
        for a, b in pairs:
            pa, pb = _resolve(a), _resolve(b)
            if not pa or not pb:
                print(f"  SKIP {feed} {a['ts']}->{b['ts']}: snapshot file missing on disk")
                continue
            if _pair_done(feed, a["ts"], b["ts"]) and not all_pairs:
                continue
            deltas = gd.diff(feed, pa, pb, a["ts"], b["ts"])
            gd.write_outputs(feed, a["ts"], b["ts"], deltas)
            total_new += 1
            print(f"  DIFFED {feed} {a['ts']} -> {b['ts']}: {len(deltas)} delta(s)")
    print(f"--- {total_new} new diff(s) written. index: {INDEX_FILE.relative_to(PLATFORM)}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Snapshot all feeds + diff new snapshots.")
    ap.add_argument("--no-fetch", action="store_true", help="skip network; diff existing snapshots")
    ap.add_argument("--all-pairs", action="store_true", help="re-diff every consecutive pair")
    args = ap.parse_args()
    return run(fetch=not args.no_fetch, all_pairs=args.all_pairs)


if __name__ == "__main__":
    sys.exit(main())
