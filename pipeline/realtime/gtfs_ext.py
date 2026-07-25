#!/usr/bin/env python3
"""GTFS-realtime vendor-extension decoding (NYCT / Mercury / OneBusAway).

WHY THIS EXISTS
---------------
Every MTA realtime feed we already download carries vendor extension fields that the
stock `gtfs_realtime_pb2` classes cannot see. They are not missing from the wire — they
are *unknown fields* on messages whose extension ranges are declared but whose extension
definitions are not compiled into our runtime. Verified on the live wire 2026-07-25:

    nyct%2Fgtfs-l      TripDescriptor #1001   19/19 entities  (trip_update AND vehicle)
                       StopTimeUpdate #1001  224/224 stop-time updates
    camsys/all-alerts  Alert          #1001  342/342 alerts
    gtfsrt.obanyc      VehiclePosition #1006  ~52% of bus vehicles (APC-equipped only)

BUILD-FREE BY DESIGN
--------------------
There is no protoc and no grpcio-tools on the box, and adding a codegen step to a
service that must not break is a bad trade. So the three `.proto` files are vendored
verbatim under `realtime/proto/` as the normative reference, and this module decodes
those exact messages directly from their wire bytes. The wire format for the fields we
read is trivially stable (varint / length-delimited), the field numbers are pinned by
the vendored protos, and every decode is individually fault-isolated: a malformed or
changed extension can only ever yield `None`, never an exception into the poll loop.

USAGE
-----
    from gtfs_ext import nyct_trip, nyct_stu, mercury_alert, oba_vehicle

    ext = nyct_trip(vehicle.trip)          # -> {"train_id","is_assigned","nyct_direction"}
    ext = nyct_stu(stop_time_update)       # -> {"scheduled_track","actual_track"}
    ext = mercury_alert(alert)             # -> {"alert_type","created_at",...}
    ext = oba_vehicle(vehicle)             # -> {"passenger_count","passenger_capacity"}

Every function returns a dict with ALL of its keys present, values `None` when the
extension is absent. That keeps the parquet schema stable whether or not a given
entity carries the extension — "absent" is recorded as NULL, never as a fabricated 0.
"""
from __future__ import annotations

from typing import Any

try:  # protobuf >= 4 exposes the unknown-field set through this module
    from google.protobuf.unknown_fields import UnknownFieldSet
except Exception:  # pragma: no cover - ancient protobuf; extensions simply stay NULL
    UnknownFieldSet = None  # type: ignore

# --- extension field numbers (see realtime/proto/*.proto) -------------------
EXT_NYCT_TRIP_DESCRIPTOR = 1001    # on TripDescriptor
EXT_NYCT_STOP_TIME_UPDATE = 1001   # on TripUpdate.StopTimeUpdate
EXT_MERCURY_ALERT = 1001           # on Alert
EXT_OBA_VEHICLE_POSITION = 1006    # on VehiclePosition

WIRE_VARINT = 0
WIRE_64BIT = 1
WIRE_LEN = 2
WIRE_32BIT = 5

# NyctTripDescriptor.Direction
NYCT_DIRECTION = {1: "N", 2: "E", 3: "S", 4: "W"}


# --------------------------------------------------------------------------- #
# minimal wire-format reader
# --------------------------------------------------------------------------- #
def _read_varint(buf: bytes, i: int) -> tuple[int, int]:
    val = 0
    shift = 0
    n = len(buf)
    while i < n:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not b & 0x80:
            return val, i
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")
    raise ValueError("truncated varint")


def _walk(buf: bytes):
    """Yield (field_number, wire_type, value) for one serialized message.

    `value` is an int for varint/fixed types and a bytes slice for length-delimited.
    """
    i, n = 0, len(buf)
    while i < n:
        key, i = _read_varint(buf, i)
        fno, wt = key >> 3, key & 7
        if wt == WIRE_VARINT:
            v, i = _read_varint(buf, i)
            yield fno, wt, v
        elif wt == WIRE_64BIT:
            yield fno, wt, buf[i:i + 8]
            i += 8
        elif wt == WIRE_LEN:
            ln, i = _read_varint(buf, i)
            if i + ln > n:
                raise ValueError("truncated length-delimited field")
            yield fno, wt, buf[i:i + ln]
            i += ln
        elif wt == WIRE_32BIT:
            yield fno, wt, buf[i:i + 4]
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wt}")


def _ext_blob(msg: Any, field_number: int) -> bytes | None:
    """Raw bytes of an unknown length-delimited extension field on `msg`, or None."""
    if UnknownFieldSet is None or msg is None:
        return None
    try:
        for f in UnknownFieldSet(msg):
            if f.field_number == field_number and f.wire_type == WIRE_LEN:
                return f.data
    except Exception:
        return None
    return None


def _utf8(b: bytes) -> str | None:
    try:
        s = b.decode("utf-8").strip()
    except Exception:
        return None
    return s or None


def _translated_first(buf: bytes) -> str | None:
    """First translation text out of a serialized gtfs-rt TranslatedString.

    TranslatedString { repeated Translation translation = 1; }
    Translation      { required string text = 1; optional string language = 2; }
    """
    try:
        for fno, wt, val in _walk(buf):
            if fno == 1 and wt == WIRE_LEN:
                for tfno, twt, tval in _walk(val):
                    if tfno == 1 and twt == WIRE_LEN:
                        return _utf8(tval)
    except Exception:
        return None
    return None


# --------------------------------------------------------------------------- #
# public decoders
# --------------------------------------------------------------------------- #
NYCT_TRIP_KEYS = ("train_id", "is_assigned", "nyct_direction")


def nyct_trip(trip_msg: Any) -> dict[str, Any]:
    """NyctTripDescriptor off a TripDescriptor (works on both vehicle.trip and
    trip_update.trip). `train_id` is the subway join key — NYCT never sets vehicle.id."""
    out: dict[str, Any] = {k: None for k in NYCT_TRIP_KEYS}
    blob = _ext_blob(trip_msg, EXT_NYCT_TRIP_DESCRIPTOR)
    if blob is None:
        return out
    try:
        for fno, wt, val in _walk(blob):
            if fno == 1 and wt == WIRE_LEN:
                out["train_id"] = _utf8(val)
            elif fno == 2 and wt == WIRE_VARINT:
                out["is_assigned"] = bool(val)
            elif fno == 3 and wt == WIRE_VARINT:
                out["nyct_direction"] = NYCT_DIRECTION.get(int(val))
    except Exception:
        pass
    return out


NYCT_STU_KEYS = ("scheduled_track", "actual_track")


def nyct_stu(stu_msg: Any) -> dict[str, Any]:
    """NyctStopTimeUpdate off a TripUpdate.StopTimeUpdate (platform assignment)."""
    out: dict[str, Any] = {k: None for k in NYCT_STU_KEYS}
    blob = _ext_blob(stu_msg, EXT_NYCT_STOP_TIME_UPDATE)
    if blob is None:
        return out
    try:
        for fno, wt, val in _walk(blob):
            if fno == 1 and wt == WIRE_LEN:
                out["scheduled_track"] = _utf8(val)
            elif fno == 2 and wt == WIRE_LEN:
                out["actual_track"] = _utf8(val)
    except Exception:
        pass
    return out


MERCURY_ALERT_KEYS = ("alert_type", "created_at", "updated_at",
                      "display_before_active", "human_readable_active_period")


def mercury_alert(alert_msg: Any) -> dict[str, Any]:
    """MercuryAlert off an Alert. `alert_type` is MTA's REAL alert taxonomy — the base
    GTFS-RT cause/effect fields are never set on the wire."""
    out: dict[str, Any] = {k: None for k in MERCURY_ALERT_KEYS}
    blob = _ext_blob(alert_msg, EXT_MERCURY_ALERT)
    if blob is None:
        return out
    try:
        for fno, wt, val in _walk(blob):
            if fno == 1 and wt == WIRE_VARINT:
                out["created_at"] = int(val)
            elif fno == 2 and wt == WIRE_VARINT:
                out["updated_at"] = int(val)
            elif fno == 3 and wt == WIRE_LEN:
                out["alert_type"] = _utf8(val)
            elif fno == 7 and wt == WIRE_VARINT:
                out["display_before_active"] = int(val)
            elif fno == 8 and wt == WIRE_LEN:
                out["human_readable_active_period"] = _translated_first(val)
    except Exception:
        pass
    return out


OBA_VEHICLE_KEYS = ("passenger_count", "passenger_capacity")


def oba_vehicle(vehicle_msg: Any) -> dict[str, Any]:
    """OneBusAwayVehiclePosition off a VehiclePosition — the real APC head-count that
    `occupancy_status` is only the 5-bucket rounding of."""
    out: dict[str, Any] = {k: None for k in OBA_VEHICLE_KEYS}
    blob = _ext_blob(vehicle_msg, EXT_OBA_VEHICLE_POSITION)
    if blob is None:
        return out
    try:
        for fno, wt, val in _walk(blob):
            if fno == 1 and wt == WIRE_VARINT:
                out["passenger_count"] = int(val)
            elif fno == 2 and wt == WIRE_VARINT:
                out["passenger_capacity"] = int(val)
    except Exception:
        pass
    return out


def alert_wire_fields(alert_msg: Any) -> set[str]:
    """Names of the Alert fields ACTUALLY present on the wire.

    Used to record `cause`/`effect` honestly: proto2 hands back 1/8 whether or not the
    agency set them, so the only truthful thing to archive is whether they were there.
    """
    try:
        return {fd.name for fd, _ in alert_msg.ListFields()}
    except Exception:
        return set()
