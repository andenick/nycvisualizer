#!/usr/bin/env python3
"""
S3 GTFS snapshot + diff engine — shared helpers.

Public-repo hygiene: NO absolute workspace-root literals. The pipeline root is resolved
from the NYCV_PIPELINE_ROOT env var (the convention the poller/derive/build scripts
use), falling back to the NYCPlatform dir two levels above this file
(changes/_common.py -> changes -> NYCPlatform).
"""
from __future__ import annotations

import hashlib
import io
import os
import zipfile
from pathlib import Path


def platform_root() -> Path:
    """Resolve the NYCPlatform root (env-parameterized, repo-portable)."""
    env = os.environ.get("NYCV_PIPELINE_ROOT")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[1]


PLATFORM = platform_root()
CHANGES_DIR = PLATFORM / "changes"
SNAP_DIR = CHANGES_DIR / "gtfs_snapshots"
INDEX_FILE = SNAP_DIR / "SNAPSHOT_INDEX.json"
DELTA_DIR = CHANGES_DIR / "deltas"
CHANGELOG = CHANGES_DIR / "CHANGELOG.md"
STATIC_ROOT = PLATFORM / "data" / "raw" / "transit_static"

# GTFS member files that carry SCHEDULE content. The logical content hash is computed
# over these (sorted, normalized) so that hourly re-zips of an identical schedule
# (different zip container bytes / member mtimes) dedup to the SAME hash and are NOT
# stored again — mandatory under D: disk pressure.
_SCHEDULE_MEMBERS = (
    "agency.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt",
    "calendar.txt", "calendar_dates.txt", "shapes.txt", "transfers.txt", "feed_info.txt",
    "frequencies.txt", "fare_attributes.txt", "fare_rules.txt",
)


def content_hash(zip_path: Path) -> str:
    """
    sha256 over the LOGICAL GTFS content: for each schedule member present, hash
    name + a newline-normalized copy of its bytes, in sorted order. Ignores zip
    container metadata (member timestamps, compression, ordering) so identical
    schedules dedup even when re-zipped.
    """
    h = hashlib.sha256()
    with zipfile.ZipFile(zip_path) as z:
        names = sorted(n for n in z.namelist() if os.path.basename(n).lower() in _SCHEDULE_MEMBERS)
        if not names:  # not a recognizable GTFS zip -> fall back to raw byte hash
            return _raw_hash(zip_path)
        for n in names:
            data = z.read(n)
            # normalize line endings so CRLF/LF churn doesn't force a false-positive snapshot
            data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            h.update(os.path.basename(n).lower().encode("utf-8"))
            h.update(b"\0")
            h.update(hashlib.sha256(data).digest())
    return h.hexdigest()


def _raw_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rel_to_platform(p: Path) -> str:
    """Portable POSIX-style path relative to the platform root (for the index)."""
    try:
        return p.resolve().relative_to(PLATFORM).as_posix()
    except ValueError:
        return p.as_posix()
