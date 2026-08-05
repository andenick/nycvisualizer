#!/usr/bin/env python3
"""
nycvisualizer NYC Platform — Realtime GTFS-RT / GBFS poller.

A single asyncio scheduler service (MASTER_PLAN B3). It polls every NYC realtime
transit feed on its own cadence, parses GTFS-RT protobuf / GBFS JSON, and appends
rows to hourly-partitioned Parquet under realtime/archive/<feed>/date=.../hour=.../.

HARD RULES (enforced here, see README):
  * MTA BusTime key: ALL bus feeds (vehiclePositions/tripUpdates/alerts) share ONE
    key and ONE serialized scheduler. No two bus HTTP calls are ever in flight or
    closer than MIN_BUS_GAP (31s) apart. A single floor violation can revoke the key.
  * Single-instance only: a localhost port bind + PID lockfile make double-launch
    impossible.
  * Disk guard: archiving stops (loudly) if D: free < DISK_FLOOR_GB.

Run:     python realtime/poller.py
Restart: touch realtime/poller.restart -- the next heartbeat force-flushes every buffer
         and exits 0 for the supervisor to relaunch (LOSSLESS; see README). Prefer this
         over killing the process, which discards up to FLUSH_SECONDS of buffered rows.
Stop:    stop the scheduled task / service manager entry that owns it (the PID is in
         POLLER_STATUS.json). The service is designed to run under a task scheduler
         (task "JaneNYCPoller") with an internal supervisor-free single-process loop.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests
import pyarrow as pa
import pyarrow.parquet as pq
from google.transit import gtfs_realtime_pb2

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gtfs_ext  # noqa: E402  (vendor-extension decoder; see realtime/proto/README.md)

# ------------------------------------------------------------------ paths / const
ROOT = Path(__file__).resolve().parent                     # .../realtime
PLATFORM = ROOT.parent                                     # .../NYCPlatform
ENV_FILE = PLATFORM / ".env"
ARCHIVE = ROOT / "archive"
LOGDIR = ROOT / "logs"
STATUS_FILE = ROOT / "POLLER_STATUS.json"
LOCKFILE = ROOT / "poller.lock"
RESTART_FILE = ROOT / "poller.restart"   # touch to request a lossless graceful restart

LOCK_PORT = 47654          # single-instance guard (localhost bind)
DISK_FLOOR_GB = 30.0       # stop archiving below this free space on D:
FLUSH_SECONDS = 300        # per-feed buffer flush cadence (~5 min)
FLUSH_MAX_ROWS = 200_000   # safety flush if a buffer grows past this
BUFFER_HARD_CAP = 1_000_000  # drop rows above this if archiving is disabled (anti-OOM)
STALE_SECONDS = 300        # header timestamp unchanged longer than this -> warn
HEARTBEAT_SECONDS = 15     # POLLER_STATUS.json write cadence
MIN_BUS_GAP = 31.0         # HARD floor between ANY two BusTime HTTP calls
HTTP_TIMEOUT = 25
BACKOFF_BASE = 2.0
BACKOFF_CAP = 300.0        # max backoff added on repeated 429/5xx
# Identifies us to the feed hosts on every request. Point it at the PROJECT, never at a
# personal address: this string is transmitted to MTA on every fetch and is published in
# the public repo. Matches the convention in changes/snapshot.py.
USER_AGENT = ("nycvisualizer-poller/1.0 (civic data research; "
              "https://github.com/andenick/nycvisualizer)")

# ------------------------------------------------------------------ env loading
def load_env(path: Path) -> dict:
    env = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env

ENV = load_env(ENV_FILE)
# archive root override (NYCV_ARCHIVE_ROOT in .env or process env) — lets the active
# archive live on a different drive than the code (D: contention immunization 2026-07-22)
_arch_override = ENV.get("NYCV_ARCHIVE_ROOT") or os.environ.get("NYCV_ARCHIVE_ROOT")
if _arch_override:
    ARCHIVE = Path(_arch_override)
BUS_KEY = ENV.get("MTA_BUSTIME_KEY", "")

# ------------------------------------------------------------------ feed catalog
BUS_BASE = "https://gtfsrt.prod.obanyc.com"
SUBWAY_BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds"
FERRY_BASE = "https://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx"
CITIBIKE_STATUS = "https://gbfs.citibikenyc.com/gbfs/en/station_status.json"

def bus_url(endpoint: str) -> str:
    return f"{BUS_BASE}/{endpoint}?key={BUS_KEY}"

# Each feed: name, url, interval_s, parser, group ('bus' serialized | 'other'),
#            fmt ('parquet' | 'jsonl')
FEEDS = [
    # --- BusTime (keyed, SERIALIZED, respects 30s floor) ---
    dict(name="bus_vehicle_positions", url=bus_url("vehiclePositions"), interval=31,
         parser="vehicle", group="bus", fmt="parquet"),
    dict(name="bus_trip_updates", url=bus_url("tripUpdates"), interval=62,
         parser="trip", group="bus", fmt="parquet"),
    dict(name="bus_alerts", url=bus_url("alerts"), interval=300,
         parser="alert", group="bus", fmt="jsonl"),
    # --- Subway / SIR line-group feeds (key-free) every 30s ---
    # parser="vehicle_trip": ONE fetch, BOTH entity kinds. Each NYCT payload is ~50%
    # TripUpdate entities (57 of 114 on the reference capture) and, until 2026-07-25,
    # every one of those subway arrival predictions was parsed away and discarded. The
    # trip rows are routed to a derived sink feed `<name>_trip_updates` (see
    # DERIVED_TRIP_FEEDS); NO extra HTTP request is made.
    dict(name="subway_gtfs", url=f"{SUBWAY_BASE}/nyct%2Fgtfs", interval=30,
         parser="vehicle_trip", group="other", fmt="parquet"),
    dict(name="subway_ace", url=f"{SUBWAY_BASE}/nyct%2Fgtfs-ace", interval=30,
         parser="vehicle_trip", group="other", fmt="parquet"),
    dict(name="subway_bdfm", url=f"{SUBWAY_BASE}/nyct%2Fgtfs-bdfm", interval=30,
         parser="vehicle_trip", group="other", fmt="parquet"),
    dict(name="subway_g", url=f"{SUBWAY_BASE}/nyct%2Fgtfs-g", interval=30,
         parser="vehicle_trip", group="other", fmt="parquet"),
    dict(name="subway_jz", url=f"{SUBWAY_BASE}/nyct%2Fgtfs-jz", interval=30,
         parser="vehicle_trip", group="other", fmt="parquet"),
    dict(name="subway_nqrw", url=f"{SUBWAY_BASE}/nyct%2Fgtfs-nqrw", interval=30,
         parser="vehicle_trip", group="other", fmt="parquet"),
    dict(name="subway_l", url=f"{SUBWAY_BASE}/nyct%2Fgtfs-l", interval=30,
         parser="vehicle_trip", group="other", fmt="parquet"),
    dict(name="subway_si", url=f"{SUBWAY_BASE}/nyct%2Fgtfs-si", interval=30,
         parser="vehicle_trip", group="other", fmt="parquet"),
    # --- Commuter rail every 60s ---
    dict(name="lirr", url=f"{SUBWAY_BASE}/lirr%2Fgtfs-lirr", interval=60,
         parser="vehicle", group="other", fmt="parquet"),
    dict(name="mnr", url=f"{SUBWAY_BASE}/mnr%2Fgtfs-mnr", interval=60,
         parser="vehicle", group="other", fmt="parquet"),
    # --- Service alerts every 5 min ---
    dict(name="subway_alerts", url=f"{SUBWAY_BASE}/camsys%2Fall-alerts", interval=300,
         parser="alert", group="other", fmt="jsonl"),
    # --- Citi Bike GBFS every 60s ---
    dict(name="citibike_station_status", url=CITIBIKE_STATUS, interval=60,
         parser="gbfs_station", group="other", fmt="parquet"),
    # --- NYC Ferry GTFS-RT every 60s ---
    dict(name="ferry_vehicle_positions", url=f"{FERRY_BASE}/vehicleposition", interval=60,
         parser="vehicle", group="other", fmt="parquet"),
    dict(name="ferry_trip_updates", url=f"{FERRY_BASE}/tripupdate", interval=60,
         parser="trip", group="other", fmt="parquet"),
]

# ------------------------------------------------------------------ derived sinks
# A "derived" feed is NEVER fetched. It is an archive sink for rows a parser extracts
# from a payload another feed already downloaded. group="derived" keeps it out of both
# schedulers (bus_scheduler_loop takes group=="bus", run() takes group=="other"), while
# maintenance_loop still flushes it and write_status still reports it.
def trip_sink_name(feed: str) -> str:
    return f"{feed}_trip_updates"

DERIVED_TRIP_FEEDS = [trip_sink_name(f["name"]) for f in FEEDS if f["parser"] == "vehicle_trip"]

FEEDS += [dict(name=n, url=None, interval=0, parser="derived", group="derived",
               fmt="parquet", source=n[:-len("_trip_updates")])
          for n in DERIVED_TRIP_FEEDS]

# ------------------------------------------------------------------ shared state
class FeedState:
    def __init__(self, cfg):
        self.cfg = cfg
        self.name = cfg["name"]
        self.buffer = []                 # list[dict] pending rows
        self.rows_archived = 0           # cumulative flushed rows
        self.rows_dropped = 0            # dropped due to disk guard
        self.error_count = 0
        self.last_success = None         # iso str
        self.last_status = None          # http code or 'ERR:<type>'
        self.last_header_ts = None       # last feed header timestamp
        self.last_header_change = None   # wall time header_ts last changed
        self.stale = False
        self.backoff_until = 0.0         # monotonic time to skip until
        self.backoff_streak = 0
        self.last_flush = time.monotonic()
        self.last_error_msg = None

STATE = {f["name"]: FeedState(f) for f in FEEDS}
STARTED_AT = datetime.now(timezone.utc).isoformat()
PID = os.getpid()
ARCHIVING_ENABLED = True
DISK_FREE_GB = None
BUS_LAST_CALL = 0.0   # monotonic time of last BusTime HTTP call (any bus feed)

def log(msg: str):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{stamp}] {msg}"
    print(line, flush=True)
    try:
        LOGDIR.mkdir(parents=True, exist_ok=True)
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with open(LOGDIR / f"poller-{day}.log", "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass

# ------------------------------------------------------------------ parsers
def _enum(v):
    """Protobuf enum -> int (or None)."""
    try:
        return int(v)
    except Exception:
        return None

def _trip_common(trip) -> dict:
    """Fields carried on a TripDescriptor, base + NYCT extension.

    start_date/start_time disambiguate a trip_id ACROSS SERVICE DAYS (a 25-hour-clock
    late trip vs today's). The NYCT extension supplies train_id — the only stable subway
    train identity, since VehiclePosition.vehicle.id is 100% NULL on the NYCT feeds.
    """
    out = dict(
        trip_id=(trip.trip_id or None),
        route_id=(trip.route_id or None),
        direction_id=(int(trip.direction_id) if trip.HasField("direction_id") else None),
        start_date=(trip.start_date or None),
        start_time=(trip.start_time or None),
        trip_sched_rel=(_enum(trip.schedule_relationship)
                        if trip.HasField("schedule_relationship") else None),
    )
    out.update(gtfs_ext.nyct_trip(trip))   # train_id, is_assigned, nyct_direction
    return out


def _vehicle_rows(fm, feed: str, poll_ts: int, hdr: int | None) -> list[dict]:
    rows = []
    for e in fm.entity:
        if not e.HasField("vehicle"):
            continue
        v = e.vehicle
        pos = v.position
        row = dict(
            feed=feed, poll_ts=poll_ts, header_ts=hdr,
            vehicle_id=(v.vehicle.id or None),
            lat=(pos.latitude if v.HasField("position") else None),
            lon=(pos.longitude if v.HasField("position") else None),
            bearing=(pos.bearing if v.HasField("position") and pos.HasField("bearing") else None),
            speed=(pos.speed if v.HasField("position") and pos.HasField("speed") else None),
            timestamp=(int(v.timestamp) if v.HasField("timestamp") else None),
            stop_id=(v.stop_id or None),
            current_stop_seq=(int(v.current_stop_sequence) if v.HasField("current_stop_sequence") else None),
            current_status=(_enum(v.current_status) if v.HasField("current_status") else None),
            occupancy_status=(_enum(v.occupancy_status) if v.HasField("occupancy_status") else None),
        )
        row.update(_trip_common(v.trip))
        # OneBusAway APC head-count — the real number `occupancy_status` rounds into
        # 5 buckets. NULL means "no APC on this vehicle", NEVER "empty".
        row.update(gtfs_ext.oba_vehicle(v))
        rows.append(row)
    return rows


def _trip_rows(fm, feed: str, poll_ts: int, hdr: int | None) -> list[dict]:
    rows = []
    for e in fm.entity:
        if not e.HasField("trip_update"):
            continue
        tu = e.trip_update
        common = _trip_common(tu.trip)
        vid = tu.vehicle.id or None
        # TRIP-LEVEL delay: MTA publishes schedule deviation directly here, at 100%
        # coverage on the bus tripUpdates feed. The PER-STOP stu.*.delay below is never
        # set. Reading only the per-stop one discarded the agency's own adherence number.
        trip_delay = int(tu.delay) if tu.HasField("delay") else None
        trip_ts = int(tu.timestamp) if tu.HasField("timestamp") else None
        base = dict(feed=feed, poll_ts=poll_ts, header_ts=hdr, vehicle_id=vid,
                    trip_delay=trip_delay, trip_ts=trip_ts, **common)
        if not tu.stop_time_update:
            rows.append(dict(
                base, stop_id=None, stop_seq=None,
                arrival_time=None, arrival_delay=None, departure_time=None,
                departure_delay=None, schedule_relationship=None,
                scheduled_track=None, actual_track=None,
            ))
            continue
        for stu in tu.stop_time_update:
            row = dict(
                base,
                stop_id=(stu.stop_id or None),
                stop_seq=(int(stu.stop_sequence) if stu.HasField("stop_sequence") else None),
                arrival_time=(int(stu.arrival.time) if stu.HasField("arrival") and stu.arrival.HasField("time") else None),
                arrival_delay=(int(stu.arrival.delay) if stu.HasField("arrival") and stu.arrival.HasField("delay") else None),
                departure_time=(int(stu.departure.time) if stu.HasField("departure") and stu.departure.HasField("time") else None),
                departure_delay=(int(stu.departure.delay) if stu.HasField("departure") and stu.departure.HasField("delay") else None),
                schedule_relationship=(_enum(stu.schedule_relationship) if stu.HasField("schedule_relationship") else None),
            )
            # NYCT platform assignment: scheduled != actual is a rerouting signal.
            row.update(gtfs_ext.nyct_stu(stu))
            rows.append(row)
    return rows


def parse_vehicle(content: bytes, feed: str, poll_ts: int):
    fm = gtfs_realtime_pb2.FeedMessage()
    fm.ParseFromString(content)
    hdr = int(fm.header.timestamp) if fm.header.HasField("timestamp") else None
    return _vehicle_rows(fm, feed, poll_ts, hdr), hdr


def parse_trip(content: bytes, feed: str, poll_ts: int):
    fm = gtfs_realtime_pb2.FeedMessage()
    fm.ParseFromString(content)
    hdr = int(fm.header.timestamp) if fm.header.HasField("timestamp") else None
    return _trip_rows(fm, feed, poll_ts, hdr), hdr


def parse_vehicle_trip(content: bytes, feed: str, poll_ts: int):
    """Parse BOTH entity kinds out of one payload (NYCT feeds ship ~50/50).

    Returns (vehicle_rows, hdr, {sink_feed: trip_rows}) — the third element routes the
    trip rows to their own archive feed without a second HTTP request.
    """
    fm = gtfs_realtime_pb2.FeedMessage()
    fm.ParseFromString(content)
    hdr = int(fm.header.timestamp) if fm.header.HasField("timestamp") else None
    sink = trip_sink_name(feed)
    return (_vehicle_rows(fm, feed, poll_ts, hdr), hdr,
            {sink: _trip_rows(fm, sink, poll_ts, hdr)})

def parse_alert(content: bytes, feed: str, poll_ts: int):
    """GTFS-RT alerts -> list of JSON dicts (written as JSON-lines)."""
    fm = gtfs_realtime_pb2.FeedMessage()
    fm.ParseFromString(content)
    hdr = int(fm.header.timestamp) if fm.header.HasField("timestamp") else None
    rows = []
    for e in fm.entity:
        if not e.HasField("alert"):
            continue
        a = e.alert
        def _tr(field):
            return [t.text for t in field.translation] if field else []
        informed = []
        for ie in a.informed_entity:
            informed.append(dict(
                agency_id=ie.agency_id or None, route_id=ie.route_id or None,
                route_type=(int(ie.route_type) if ie.HasField("route_type") else None),
                stop_id=ie.stop_id or None,
                trip_id=(ie.trip.trip_id or None) if ie.HasField("trip") else None,
            ))
        periods = [dict(start=(int(p.start) if p.HasField("start") else None),
                        end=(int(p.end) if p.HasField("end") else None))
                   for p in a.active_period]
        # cause / effect are NEVER SET on the wire by MTA. proto2 hands back 1
        # (UNKNOWN_CAUSE) and 8 (UNKNOWN_EFFECT) regardless, which is why a severity
        # model built on `effect` buckets 100% of alerts "low". Record whether the
        # agency actually sent them so no downstream consumer can mistake a proto
        # default for an agency value; the REAL taxonomy is mercury alert_type below.
        on_wire = gtfs_ext.alert_wire_fields(a)
        rows.append(dict(
            feed=feed, poll_ts=poll_ts, header_ts=hdr, alert_id=e.id,
            cause=_enum(a.cause), effect=_enum(a.effect),
            cause_on_wire=("cause" in on_wire), effect_on_wire=("effect" in on_wire),
            header_text=_tr(a.header_text), description_text=_tr(a.description_text),
            active_period=periods, informed_entity=informed,
            **gtfs_ext.mercury_alert(a),   # alert_type, created_at, updated_at,
                                           # display_before_active,
                                           # human_readable_active_period
        ))
    return rows, hdr

def parse_gbfs_station(content: bytes, feed: str, poll_ts: int):
    data = json.loads(content)
    stations = data.get("data", {}).get("stations", [])
    hdr = int(data.get("last_updated") or 0) or None
    rows = []
    for s in stations:
        rows.append(dict(
            feed=feed, poll_ts=poll_ts, header_ts=hdr,
            station_id=str(s.get("station_id")) if s.get("station_id") is not None else None,
            num_bikes_available=s.get("num_bikes_available"),
            num_ebikes_available=s.get("num_ebikes_available"),
            num_bikes_disabled=s.get("num_bikes_disabled"),
            num_docks_available=s.get("num_docks_available"),
            num_docks_disabled=s.get("num_docks_disabled"),
            is_installed=s.get("is_installed"),
            is_renting=s.get("is_renting"),
            is_returning=s.get("is_returning"),
            last_reported=s.get("last_reported"),
        ))
    return rows, hdr

PARSERS = {
    "vehicle": parse_vehicle,
    "trip": parse_trip,
    "vehicle_trip": parse_vehicle_trip,
    "alert": parse_alert,
    "gbfs_station": parse_gbfs_station,
    # "derived" feeds are archive sinks only — never fetched, never parsed.
}

# ------------------------------------------------------------------ archiving
def disk_free_gb(path="D:/") -> float:
    import shutil
    try:
        return shutil.disk_usage(path).free / 1e9
    except Exception:
        return 999.0

def partition_dir(feed: str, when: datetime) -> Path:
    d = ARCHIVE / feed / f"date={when.strftime('%Y-%m-%d')}" / f"hour={when.strftime('%H')}"
    d.mkdir(parents=True, exist_ok=True)
    return d

def flush_feed(st: FeedState, force=False):
    global ARCHIVING_ENABLED
    cfg = st.cfg
    if not st.buffer:
        st.last_flush = time.monotonic()
        return
    now = time.monotonic()
    due = force or (now - st.last_flush) >= FLUSH_SECONDS or len(st.buffer) >= FLUSH_MAX_ROWS
    if not due:
        return
    if not ARCHIVING_ENABLED:
        # disk guard active: drop to avoid unbounded memory
        if len(st.buffer) > BUFFER_HARD_CAP:
            st.rows_dropped += len(st.buffer)
            st.buffer.clear()
        st.last_flush = now
        return
    rows = st.buffer
    st.buffer = []
    st.last_flush = now
    when = datetime.now(timezone.utc)
    try:
        pdir = partition_dir(cfg["name"], when)
        fname = f"part-{when.strftime('%H%M%S')}-{uuid.uuid4().hex[:8]}"
        if cfg["fmt"] == "jsonl":
            path = pdir / f"{fname}.jsonl"
            with open(path, "w", encoding="utf-8") as fh:
                for r in rows:
                    fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        else:
            path = pdir / f"{fname}.parquet"
            table = pa.Table.from_pylist(rows)
            pq.write_table(table, path, compression="zstd")
        st.rows_archived += len(rows)
    except Exception as e:
        # re-buffer on write failure (bounded)
        st.last_error_msg = f"flush: {type(e).__name__}: {e}"
        log(f"WARN flush {cfg['name']} failed: {e}")
        if len(rows) < BUFFER_HARD_CAP:
            st.buffer[0:0] = rows

# ------------------------------------------------------------------ fetching
def _http_get(url: str) -> requests.Response:
    # gtfs-l endpoint intermittently drops TLS mid-handshake (SSL UNEXPECTED_EOF);
    # one immediate retry with Connection: close absorbs it (see README Known issues)
    try:
        return requests.get(url, timeout=HTTP_TIMEOUT, headers={"User-Agent": USER_AGENT})
    except requests.exceptions.SSLError:
        time.sleep(2)
        return requests.get(url, timeout=HTTP_TIMEOUT,
                            headers={"User-Agent": USER_AGENT, "Connection": "close"})

def poll_once(st: FeedState):
    """Blocking fetch+parse+buffer for one feed. Runs in a thread executor."""
    cfg = st.cfg
    poll_ts = int(time.time())
    try:
        r = _http_get(cfg["url"])
        st.last_status = r.status_code
        if r.status_code in (429,) or 500 <= r.status_code < 600:
            st.error_count += 1
            st.backoff_streak += 1
            delay = min(BACKOFF_CAP, BACKOFF_BASE ** st.backoff_streak)
            st.backoff_until = time.monotonic() + delay
            # BusTime 403/5xx: report exactly, do NOT hammer (>=60s)
            if cfg["group"] == "bus":
                st.backoff_until = time.monotonic() + max(60.0, delay)
            st.last_error_msg = f"HTTP {r.status_code}"
            log(f"WARN {cfg['name']} HTTP {r.status_code} -> backoff {delay:.0f}s "
                f"(streak {st.backoff_streak})")
            return
        if r.status_code == 403:
            st.error_count += 1
            st.last_error_msg = "HTTP 403"
            # BusTime key problem: back off hard, report, max 1 retry / 60s
            st.backoff_until = time.monotonic() + 60.0
            log(f"ERROR {cfg['name']} HTTP 403 (auth/key). Backing off 60s. "
                f"If this is a BusTime feed, the key may be invalid/revoked — REPORT.")
            return
        if r.status_code != 200:
            st.error_count += 1
            st.last_error_msg = f"HTTP {r.status_code}"
            st.backoff_until = time.monotonic() + 30.0
            log(f"WARN {cfg['name']} unexpected HTTP {r.status_code}")
            return
        parsed = PARSERS[cfg["parser"]](r.content, cfg["name"], poll_ts)
        # A parser may return (rows, hdr) or (rows, hdr, {sink_feed: rows}) when one
        # payload carries entities that belong in more than one archive feed.
        extra = {}
        if len(parsed) == 3:
            rows, hdr, extra = parsed
        else:
            rows, hdr = parsed
        for sink, srows in (extra or {}).items():
            sst = STATE.get(sink)
            if sst is None:
                continue
            sst.buffer.extend(srows)
            sst.last_success = datetime.now(timezone.utc).isoformat()
            sst.last_status = r.status_code
            sst.last_header_ts = hdr
        # stale-feed detection
        wall = time.monotonic()
        if hdr is not None:
            if st.last_header_ts is None or hdr != st.last_header_ts:
                st.last_header_change = wall
                st.stale = False
            elif st.last_header_change and (wall - st.last_header_change) > STALE_SECONDS:
                if not st.stale:
                    log(f"WARN {cfg['name']} STALE — header ts {hdr} unchanged "
                        f">{STALE_SECONDS}s")
                st.stale = True
            st.last_header_ts = hdr
        st.buffer.extend(rows)
        st.last_success = datetime.now(timezone.utc).isoformat()
        st.backoff_streak = 0
        st.backoff_until = 0.0
        st.last_error_msg = None
    except Exception as e:
        st.error_count += 1
        st.last_status = f"ERR:{type(e).__name__}"
        st.last_error_msg = str(e)[:200]
        st.backoff_streak += 1
        delay = min(BACKOFF_CAP, BACKOFF_BASE ** st.backoff_streak)
        if cfg["group"] == "bus":
            delay = max(60.0, delay)
        st.backoff_until = time.monotonic() + delay
        log(f"WARN {cfg['name']} fetch error {type(e).__name__}: {e} -> backoff {delay:.0f}s")

# ------------------------------------------------------------------ schedulers
async def other_feed_loop(st: FeedState, stagger: float):
    """Independent loop for a non-bus feed (different hosts, may run concurrently)."""
    await asyncio.sleep(stagger)
    loop = asyncio.get_running_loop()
    while True:
        start = time.monotonic()
        if start >= st.backoff_until:
            await loop.run_in_executor(None, poll_once, st)
        interval = st.cfg["interval"]
        elapsed = time.monotonic() - start
        await asyncio.sleep(max(1.0, interval - elapsed))

async def bus_scheduler_loop():
    """
    SINGLE serialized scheduler for ALL BusTime feeds. Guarantees:
      * only one bus HTTP call at a time (sequential),
      * >= MIN_BUS_GAP (31s) between ANY two bus calls (the 30s floor).
    Picks the earliest-due bus feed each iteration; if two are due at once, the gap
    enforcement serializes them (slightly stretching cadence — safety over exactness).
    """
    global BUS_LAST_CALL
    if not BUS_KEY:
        log("ERROR MTA_BUSTIME_KEY missing from .env — bus feeds DISABLED.")
        return
    loop = asyncio.get_running_loop()
    bus_feeds = [STATE[f["name"]] for f in FEEDS if f["group"] == "bus"]
    next_due = {st.name: 0.0 for st in bus_feeds}  # monotonic due times
    while True:
        now = time.monotonic()
        # choose eligible (past backoff) feed with earliest due time
        candidates = [(next_due[st.name], st) for st in bus_feeds if now >= st.backoff_until]
        if not candidates:
            await asyncio.sleep(1.0)
            continue
        due_time, st = min(candidates, key=lambda x: x[0])
        # wait until this feed is due AND the 31s global gap has elapsed
        gap_ready = BUS_LAST_CALL + MIN_BUS_GAP
        wait = max(due_time - now, gap_ready - now, 0.0)
        if wait > 0:
            await asyncio.sleep(min(wait, 5.0))
            continue
        BUS_LAST_CALL = time.monotonic()
        await loop.run_in_executor(None, poll_once, st)
        next_due[st.name] = time.monotonic() + st.cfg["interval"]

async def maintenance_loop():
    """Periodic flush, disk guard, heartbeat, graceful-restart check."""
    global ARCHIVING_ENABLED, DISK_FREE_GB
    while True:
        # GRACEFUL RESTART (added 2026-07-25, W6b). Every hard kill of this process
        # discards up to FLUSH_SECONDS (5 min) of buffered rows across 25 feeds, and a
        # code change cannot take effect without a restart. Touch realtime/poller.restart
        # and the next heartbeat (<=15 s) force-flushes every buffer and exits 0; the
        # supervisor relaunches with the new code and loses nothing but the seconds since
        # the flush. Use this instead of taskkill.
        try:
            if RESTART_FILE.exists():
                log("GRACEFUL RESTART requested (realtime/poller.restart) — "
                    "force-flushing all buffers before exit.")
                for st in STATE.values():
                    try:
                        flush_feed(st, force=True)
                    except Exception as e:
                        log(f"WARN restart flush {st.name}: {e}")
                write_status()
                try:
                    RESTART_FILE.unlink()
                except Exception:
                    pass
                log(f"GRACEFUL RESTART: flushed "
                    f"{sum(s.rows_archived for s in STATE.values())} cumulative rows; "
                    f"exiting 0 for supervisor relaunch.")
                os._exit(0)
        except Exception as e:
            log(f"WARN restart-check: {e}")
        DISK_FREE_GB = disk_free_gb(ARCHIVE.anchor or "D:/")
        if DISK_FREE_GB < DISK_FLOOR_GB:
            if ARCHIVING_ENABLED:
                log(f"!!! DISK GUARD TRIPPED — D: {DISK_FREE_GB:.1f} GB < {DISK_FLOOR_GB} GB. "
                    f"ARCHIVING SUSPENDED. Polling continues; buffers will be dropped above cap.")
            ARCHIVING_ENABLED = False
        else:
            if not ARCHIVING_ENABLED:
                log(f"Disk recovered ({DISK_FREE_GB:.1f} GB) — archiving RESUMED.")
            ARCHIVING_ENABLED = True
        for st in STATE.values():
            try:
                flush_feed(st)
            except Exception as e:
                log(f"WARN maintenance flush {st.name}: {e}")
        write_status()
        await asyncio.sleep(HEARTBEAT_SECONDS)

def write_status():
    feeds = {}
    for st in STATE.values():
        feeds[st.name] = dict(
            interval=st.cfg["interval"], group=st.cfg["group"], parser=st.cfg["parser"],
            last_success=st.last_success, last_status=st.last_status,
            error_count=st.error_count, rows_archived=st.rows_archived,
            rows_dropped=st.rows_dropped, buffer_size=len(st.buffer),
            last_header_ts=st.last_header_ts, stale=st.stale,
            backoff_active=(time.monotonic() < st.backoff_until),
            last_error=st.last_error_msg,
        )
    doc = dict(
        service="JaneNYCPoller", pid=PID, started_at=STARTED_AT,
        updated_at=datetime.now(timezone.utc).isoformat(),
        archiving_enabled=ARCHIVING_ENABLED,
        disk_free_gb=(round(DISK_FREE_GB, 1) if DISK_FREE_GB is not None else None),
        disk_floor_gb=DISK_FLOOR_GB,
        bus_key_present=bool(BUS_KEY),
        total_rows_archived=sum(s.rows_archived for s in STATE.values()),
        feeds=feeds,
    )
    tmp = STATUS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    os.replace(tmp, STATUS_FILE)

# ------------------------------------------------------------------ single-instance
def acquire_single_instance():
    """Bind a localhost port to guarantee only one poller runs. Returns the socket
    (kept open for process lifetime). Exits if another instance holds it."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", LOCK_PORT))
        s.listen(1)
    except OSError:
        existing = None
        try:
            existing = json.loads(LOCKFILE.read_text()).get("pid")
        except Exception:
            pass
        log(f"ANOTHER INSTANCE IS RUNNING (port {LOCK_PORT} bound; pid={existing}). Exiting.")
        sys.exit(3)
    LOCKFILE.write_text(json.dumps(dict(pid=PID, started_at=STARTED_AT, port=LOCK_PORT)),
                        encoding="utf-8")
    return s

# ------------------------------------------------------------------ main
async def run():
    tasks = [asyncio.create_task(bus_scheduler_loop()),
             asyncio.create_task(maintenance_loop())]
    # stagger non-bus feeds so 8 subway feeds don't all fire simultaneously
    stagger = 0.0
    for f in FEEDS:
        if f["group"] == "other":
            tasks.append(asyncio.create_task(other_feed_loop(STATE[f["name"]], stagger)))
            stagger += 2.0
    await asyncio.gather(*tasks)

def main():
    lock_sock = acquire_single_instance()
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    log(f"JaneNYCPoller starting — pid={PID}, {len(FEEDS)} feeds, "
        f"bus_key={'present' if BUS_KEY else 'MISSING'}, archive={ARCHIVE}")
    write_status()
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log("KeyboardInterrupt — flushing buffers and exiting.")
        for st in STATE.values():
            flush_feed(st, force=True)
        write_status()
    except Exception:
        log("FATAL:\n" + traceback.format_exc())
        raise
    finally:
        try:
            lock_sock.close()
        except Exception:
            pass

if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    main()
