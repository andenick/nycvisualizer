# Vendored GTFS-realtime vendor extensions

These three `.proto` files are **vendored verbatim** as the normative reference for the
extension field numbers hard-coded in `realtime/gtfs_ext.py`. They are **not compiled** —
there is no `protoc` and no `grpcio-tools` on the box, and adding a codegen step to a
service that must not break is a bad trade. `gtfs_ext.py` decodes these messages directly
off the unknown-field wire bytes, fault-isolated so a malformed or changed extension can
only ever yield `None`.

| File | Extends | Field # | Source |
|---|---|---|---|
| `nyct-subway.proto` | `TripDescriptor`, `TripUpdate.StopTimeUpdate` | 1001 | MTA NYCT Subway GTFS-RT extensions |
| `gtfs-realtime-MERCURY.proto` | `Alert` | 1001 | MTA / Camsys Mercury alert extensions |
| `gtfs-realtime-OneBusAway.proto` | `VehiclePosition` | 1006 | OneBusAway (MTA BusTime runs OBA) |

## Wire evidence — captured 2026-07-25, live, read-only

Field numbers and types below were verified against the actual feeds, not assumed.

### NyctTripDescriptor (`nyct%2Fgtfs-l`, 19/19 entities carried it)

```
trip_update.trip #1001 = b'\n\x0f0L 2342+RPY/8AV\x10\x01\x18\x01'
                            ^f1 len15 train_id      ^f2=1  ^f3=1 (NORTH)
vehicle.trip     #1001 = b'\n\x0f0L 2350 8AV/RPY\x10\x01\x18\x03'
                                                          ^f3=3 (SOUTH)
```

→ `train_id="0L 2342+RPY/8AV"`, `is_assigned=True`, `nyct_direction="N"`.

### NyctStopTimeUpdate (`nyct%2Fgtfs-l`, 224/224 stop-time updates)

```
stop_time_update #1001 = b'\n\x012\x12\x012'
                            ^f1 "2"  ^f2 "2"
```

→ `scheduled_track="2"`, `actual_track="2"`.

### MercuryAlert (`camsys%2Fall-alerts`, 342/342 alerts)

```
alert #1001 = b'\x08\xf4\xd5\x90\xd3\x06\x10\xed\xdf\x90\xd3\x06\x1a\rStops Skipped8\x00'
                 ^f1 created_at         ^f2 updated_at        ^f3 alert_type  ^f7=0
alert #1001 = b'\x08\x8b\xc1\x89\xd3\x06\x10\x8b\xc1\x89\xd3\x06\x1a\x10Special Schedule'
              + b'8\x90\x1cB+\n)\n#Jul 31, Friday, 10:00 AM to 3:00 PM\x12\x02en'
                 ^f7=3600  ^f8 TranslatedString{Translation{text, language="en"}}
```

→ `alert_type="Special Schedule"`, `display_before_active=3600`,
`human_readable_active_period="Jul 31, Friday, 10:00 AM to 3:00 PM"`.

### OneBusAwayVehiclePosition (`gtfsrt.prod.obanyc.com/vehiclePositions`)

```
vehicle #1006 = b'\x08\x04\x10P'   ->  passenger_count=4,  passenger_capacity=80
vehicle #1006 = b'\x08\x14\x10P'   ->  passenger_count=20, passenger_capacity=80
```

Corroborated against SIRI on the same fleet (`EstimatedPassengerCapacity: 80`,
`EstimatedPassengerCount: 37/33/19/9`).

## The cause/effect finding

`Alert.cause` and `Alert.effect` are **never set on the wire** by MTA. Verified by listing
the populated fields of live alerts: only `active_period`, `informed_entity`, `header_text`,
`description_text` are present. proto2 hands back `cause=1 (UNKNOWN_CAUSE)` and
`effect=8 (UNKNOWN_EFFECT)` regardless, which is why any severity model built on `effect`
buckets **100% of alerts as "low"**. The real taxonomy is `MercuryAlert.alert_type`, and it
is the same vocabulary MTA renders on its own Service Status board.

## Re-verifying

`realtime/test_gtfs_ext.py` decodes the pinned byte sequences above offline (no network),
and with `--live` re-runs the census against the key-free NYCT feeds. It never touches a
BusTime endpoint, so it cannot violate the 30 s BusTime floor.
