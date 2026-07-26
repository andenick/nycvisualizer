import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  addBasemap,
  bboxParam,
  NYC_CENTER,
  NYC_BOUNDS,
  MAP_MAX_ZOOM,
  type BasemapInfo,
} from "../lib/basemap";
import { RouteShapeCache } from "../lib/shapeCache";
import { trackMapError } from "../lib/beacon";
import { perfVisible } from "../lib/devFlags";
import {
  getVehicles,
  getRoutes,
  getRouteShape,
  getRibbon,
  getAlerts,
  getSubway,
  getStations,
  getStationArrivals,
  streamVehicles,
  streamSubway,
  type Vehicle,
  type RouteInfo,
  type VehiclesResponse,
  type SubwayResponse,
  type SubwayTrain,
  type AlertItem,
} from "../lib/api";
import { subwayColor, subwayTextColor, subwayLabel } from "../lib/subwayColors";
import { VehicleFlowLayer, type FlowSelection } from "./VehicleFlowLayer";
import MapLegend, { Swatch, Bullet } from "./MapLegend";
import MapThemePicker from "./MapThemePicker";
import HouseNumberToggle from "./HouseNumberToggle";
import {
  BOROUGH_GROUP_ORDER,
  BOROUGH_LEGEND,
  BOROUGH_LEGEND_NOTE,
  GROUP_COLORS,
  GROUP_COLOR_FALLBACK,
  boroughLabel,
  routeGroup,
} from "../lib/boroughs";
import FlowControls, { type FollowInfo, type FocusInfo } from "./FlowControls";

// Collapse express/shuttle subway variants onto their trunk (for focus-dim on a line).
function lineKey(route: string | null): string {
  if (!route) return "";
  const up = route.toUpperCase();
  if (up === "6X") return "6";
  if (up === "7X") return "7";
  if (up === "FX") return "F";
  if (up === "GS" || up === "FS") return "S";
  if (up === "SI") return "SIR";
  return up;
}

// Representative trunk bullets for the "official line colors" legend row.
const TRUNK_LINES = ["1", "4", "7", "A", "B", "G", "J", "L", "N", "S"];

// (W2, 2026-07-24) GROUP_COLORS / routeGroup / boroughLabel were declared here AND in
// ImmersiveMapPage.tsx AND in WorkstationPage.tsx. They now live in lib/boroughs.ts,
// which already called itself the single source of truth for borough grouping.

function fmtClock(epoch: number | null): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const STATION_MIN_ZOOM = 13;

// Q1.3: reliability-ribbon diverging color (speed percentile within the route).
function ribbonSpeedColor(pct: number): string {
  const lerp = (a: string, b: string, t: number) => {
    const p = (c: string) => [1, 3, 5].map((j) => parseInt(c.slice(j, j + 2), 16));
    const pa = p(a), pb = p(b);
    const m = pa.map((x, i) => Math.round(x + (pb[i] - x) * t));
    return `rgb(${m[0]},${m[1]},${m[2]})`;
  };
  const p = Math.max(0, Math.min(1, pct));
  return p < 0.5 ? lerp("#c1272d", "#cfcfcf", p / 0.5) : lerp("#cfcfcf", "#1a6fb5", (p - 0.5) / 0.5);
}

export default function BusMap() {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const flow = useRef<VehicleFlowLayer | null>(null);
  const stationLayer = useRef<L.LayerGroup | null>(null);
  const shapeLayer = useRef<L.LayerGroup | null>(null);
  const focusLayer = useRef<L.LayerGroup | null>(null);
  const selectedShape = useRef<[number, number][][] | null>(null);
  const stationsLoaded = useRef(false);

  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [routeQ, setRouteQ] = useState(""); // W7: free-text narrowing of the 345-route list
  const [showBuses, setShowBuses] = useState(true);
  const [showSubway, setShowSubway] = useState(true);
  // W2 (2026-07-24) — /bus had NO borough branch at all: it always used the GTFS
  // route_color and reached GROUP_COLORS only through a `!== "#ffffff"` fallback that,
  // measured over the full 345-route GTFS universe, NEVER FIRES (0 routes have a
  // white/blank colour). So GROUP_COLORS was dead code on this surface while the legend
  // claimed "Buses by borough". Borough is now a real, and the DEFAULT, encoding.
  const [colorMode, setColorMode] = useState<"route" | "borough">("borough");
  const [asOf, setAsOf] = useState<number | null>(null);
  const [source, setSource] = useState<VehiclesResponse["source"]>("none");
  const [stale, setStale] = useState(false);
  const [count, setCount] = useState(0);
  const [subAsOf, setSubAsOf] = useState<number | null>(null);
  const [subStale, setSubStale] = useState(false);
  const [subCount, setSubCount] = useState(0);
  const [subSource, setSubSource] = useState<SubwayResponse["source"]>("none");
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false); // Q0.3: drawer collapsed by default
  const [alertsDismissed, setAlertsDismissed] = useState(false);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perf, setPerf] = useState<{ ms: number; units: number; fps: number; tickJump: boolean } | null>(null);
  // F4: follow mode · focus dim · motion trails (default OFF on /bus — shared with more layers)
  const [follow, setFollow] = useState<FollowInfo | null>(null);
  const [focus, setFocus] = useState<(FocusInfo & { key: string; routeId: string | null }) | null>(null);
  const [trails, setTrails] = useState(false);
  const followingRef = useRef(false);
  const followIdRef = useRef<string | null>(null);
  const followSelRef = useRef<FlowSelection | null>(null);
  const focusRef = useRef<typeof focus>(null);
  focusRef.current = focus;
  const stopFollowRef = useRef(() => {});
  const onFollowRef = useRef<(s: FlowSelection) => void>(() => {});
  const onFocusRef = useRef<(s: FlowSelection) => void>(() => {});
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const showBusesRef = useRef(showBuses);
  showBusesRef.current = showBuses;
  const showSubwayRef = useRef(showSubway);
  showSubwayRef.current = showSubway;

  const routeColorByShort = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of routes) if (r.color) m.set(r.short_name, "#" + r.color.replace(/^#/, ""));
    return m;
  }, [routes]);

  const colorModeRef = useRef(colorMode);
  colorModeRef.current = colorMode;

  const colorFor = (routeId: string | null): string => {
    if (!routeId) return GROUP_COLOR_FALLBACK;
    if (colorModeRef.current === "borough") {
      return GROUP_COLORS[routeGroup(routeId)] ?? GROUP_COLOR_FALLBACK;
    }
    const c = routeColorByShort.get(routeId);
    // 0 of 345 routes carry a white/blank route_color, so this guard has never fired in
    // production. Kept for feed changes, not because it is load-bearing.
    if (c && c.toLowerCase() !== "#ffffff") return c;
    return GROUP_COLORS[routeGroup(routeId)] ?? GROUP_COLOR_FALLBACK;
  };
  const colorForRef = useRef(colorFor);
  colorForRef.current = colorFor;

  // ---- F4 handlers (refs so the once-constructed layer calls latest) ----
  const stopFollow = () => {
    followingRef.current = false;
    followIdRef.current = null;
    followSelRef.current = null;
    setFollow(null);
  };
  stopFollowRef.current = stopFollow;
  const applyFocus = (sel: FlowSelection) => {
    const key = sel.kind === "train" ? lineKey(sel.routeId) : sel.routeId ?? "";
    setFocus({ label: sel.label, kind: sel.kind, key, routeId: sel.routeId });
  };
  const clearFocus = () => setFocus(null);
  onFollowRef.current = (sel: FlowSelection) => {
    followingRef.current = true;
    followIdRef.current = sel.id;
    followSelRef.current = sel;
    setFollow({ label: sel.label, sub: sel.sub });
  };
  onFocusRef.current = (sel: FlowSelection) => applyFocus(sel);
  const toggleTrails = (on: boolean) => {
    setTrails(on);
    flow.current?.setTrails(on);
  };

  // ---- map init ----
  useEffect(() => {
    if (map.current || !mapRef.current) return;
    let m: L.Map;
    try {
      m = L.map(mapRef.current, {
        center: NYC_CENTER,
        zoom: 11,
        minZoom: 9,
        maxZoom: MAP_MAX_ZOOM, // W6.1: z15 basemap data over-zoomed to 19 keeps roads visible
        maxBounds: NYC_BOUNDS,
        maxBoundsViscosity: 0.6,
        zoomControl: true,
      });
      // F5: reliability guard — auto-engage raster fallback on a broken basemap and
      // beacon the degradation (guard-triggered fallback + zero-painted-tiles).
      setBasemap(
        addBasemap(m, {
          page: window.location.pathname,
          onFallback: (info, reason) => {
            setBasemap(info);
            trackMapError("fallback:" + reason);
          },
          onZeroTiles: (detail) => trackMapError("zero_tiles:" + detail),
        }),
      );
    } catch (e) {
      // F5: caught map-init error → beacon (kind=map_error, detail=init:*).
      trackMapError("init:" + (e instanceof Error ? e.message : String(e)));
      setErr("The map failed to initialize.");
      return;
    }
    stationLayer.current = L.layerGroup();
    shapeLayer.current = L.layerGroup().addTo(m);
    focusLayer.current = L.layerGroup().addTo(m);
    // The animated true-scale vehicle canvas sits ABOVE the route shape/ribbon.
    const fl = new VehicleFlowLayer({
      busPopup: popupHtml,
      trainPopup: trainPopupHtml,
      onFollow: (s) => onFollowRef.current(s),
      onFocus: (s) => onFocusRef.current(s),
    });
    fl.addTo(m);
    fl.setShapeSource(new RouteShapeCache()); // W1: lazy per-route shape geometry for glide
    flow.current = fl; // trails default OFF on /bus (no setTrails)
    if (new URLSearchParams(window.location.search).has("perf")) {
      const w = window as unknown as Record<string, unknown>;
      w.__nycvFlow = fl;
      w.__nycvMap = m;
    }
    m.on("click", () => stopFollowRef.current()); // tap map stops follow
    const syncStations = () => {
      if (!stationLayer.current) return;
      const want = showSubwayRef.current && m.getZoom() >= STATION_MIN_ZOOM;
      const has = m.hasLayer(stationLayer.current);
      if (want && !has) m.addLayer(stationLayer.current);
      if (!want && has) m.removeLayer(stationLayer.current);
    };
    m.on("zoomend", syncStations);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // ---- route catalog + alerts ----
  useEffect(() => {
    getRoutes().then(setRoutes).catch(() => setErr("Could not load route list."));
    getAlerts()
      .then((a) => setAlerts(a.alerts.slice(0, 30)))
      .catch(() => setAlerts([]));
    const aTimer = setInterval(() => {
      getAlerts().then((a) => setAlerts(a.alerts.slice(0, 30))).catch(() => {});
    }, 60000);
    return () => clearInterval(aTimer);
  }, []);

  // ---- render one BUS snapshot -> feed the animated flow layer ----
  const render = (data: VehiclesResponse) => {
    setAsOf(data.as_of);
    setSource(data.source);
    setStale(data.stale);
    setErr(null);
    const fl = flow.current;
    if (!fl) return;
    const sel = selectedRef.current;
    fl.setBuses(data.vehicles, sel, colorFor);
    const shown = showBusesRef.current
      ? sel
        ? data.vehicles.filter((v) => v.route_id === sel).length
        : data.vehicles.length
      : 0;
    setCount(shown);
  };

  // ---- render one SUBWAY snapshot -> feed the animated flow layer ----
  const renderSubway = (data: SubwayResponse) => {
    setSubAsOf(data.as_of);
    setSubStale(data.stale);
    setSubSource(data.source);
    const fl = flow.current;
    if (!fl) return;
    fl.setTrains(data.trains);
    setSubCount(showSubwayRef.current ? data.trains.length : 0);
  };

  // ---- live BUS feed: SSE + poll safety net (F5: bbox-slimmed polls) ----
  useEffect(() => {
    let cancelled = false;
    // F5/F3: poll the viewport only (SSE stays full-payload). fetch-on-moveend so
    // buses entering the viewport on a pan/zoom appear without waiting for the tick.
    const pull = () =>
      getVehicles(map.current ? bboxParam(map.current) : undefined)
        .then((d) => !cancelled && render(d))
        .catch(() => !cancelled && setErr("Live bus feed unavailable."));
    pull();
    const unsub = streamVehicles(
      (d) => !cancelled && render(d),
      () => {},
    );
    const poll = setInterval(pull, 30000);
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    const onMove = () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(pull, 400); // debounce settle
    };
    map.current?.on("moveend", onMove);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(poll);
      if (moveTimer) clearTimeout(moveTimer);
      map.current?.off("moveend", onMove);
    };
    // NOTE: intentionally NOT keyed on showBuses — visibility is handled by
    // setVisibility(); re-subscribing the SSE on every toggle was the ERR_ABORTED
    // console churn. Only routeColorByShort (loads once) legitimately re-keys it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeColorByShort]);

  // ---- live SUBWAY feed: SSE + poll safety net (F5: bbox-slimmed polls) ----
  useEffect(() => {
    let cancelled = false;
    const pull = () =>
      getSubway(map.current ? bboxParam(map.current) : undefined)
        .then((d) => !cancelled && renderSubway(d))
        .catch(() => {});
    pull();
    const unsub = streamSubway(
      (d) => !cancelled && renderSubway(d),
      () => {},
    );
    const poll = setInterval(pull, 30000);
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    const onMove = () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(pull, 400);
    };
    map.current?.on("moveend", onMove);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(poll);
      if (moveTimer) clearTimeout(moveTimer);
      map.current?.off("moveend", onMove);
    };
    // NOTE: not keyed on showSubway (visibility handled by setVisibility); keeping
    // the subway SSE alive across toggles avoids needless reconnect/ERR_ABORTED.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- flow-layer visibility + honest frame-time readout ----
  useEffect(() => {
    flow.current?.setVisibility(showBuses, showSubway);
    if (!showBuses) setCount(0);
    if (!showSubway) setSubCount(0);
  }, [showBuses, showSubway]);

  useEffect(() => {
    const t = setInterval(() => {
      const s = flow.current?.getStats();
      if (s) setPerf({ ms: s.emaFrameMs, units: s.units, fps: s.fps, tickJump: s.tickJump });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- F4 follow: ease the camera to the tracked unit (bus or subway worm) ----
  useEffect(() => {
    if (!follow) return;
    const m = map.current;
    const fl = flow.current;
    if (!m || !fl) return;
    const id = followIdRef.current;
    const tick = () => {
      if (!id) return;
      const ll = fl.getDisplayLatLng(id);
      if (!ll) {
        stopFollowRef.current();
        return;
      }
      const target = L.latLng(ll[0], ll[1]);
      const cp = m.latLngToContainerPoint(target);
      const cc = m.getSize().divideBy(2);
      if (cp.distanceTo(cc) > 12) m.panTo(target, { animate: true, duration: 0.45, easeLinearity: 0.5 });
    };
    tick();
    const iv = setInterval(tick, 350);
    return () => clearInterval(iv);
  }, [follow]);

  // ---- ESC releases follow ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stopFollowRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- F4 focus dim: predicate to the layer + (bus) overlay the route shape ----
  useEffect(() => {
    const fl = flow.current;
    const fx = focusLayer.current;
    if (!fl) return;
    fx?.clearLayers();
    if (!focus) {
      fl.setFocus(null);
      return;
    }
    if (focus.kind === "train") {
      const key = focus.key;
      fl.setFocus((k, rid) => k === "train" && lineKey(rid) === key); // dim-only
    } else {
      const rid = focus.routeId;
      fl.setFocus((k, r) => k === "bus" && r === rid);
      if (rid && fx) {
        getRouteShape(rid)
          .then((s) => {
            if (focusRef.current?.routeId !== rid) return;
            const color = colorForRef.current(rid);
            for (const line of s.polylines) L.polyline(line, { color, weight: 3, opacity: 0.7 }).addTo(fx);
          })
          .catch(() => {});
      }
    }
  }, [focus]);

  // ---- station markers (tap -> live arrivals board), zoom-gated ----
  useEffect(() => {
    const m = map.current;
    const layer = stationLayer.current;
    if (!m || !layer) return;
    if (showSubway && !stationsLoaded.current) {
      stationsLoaded.current = true;
      getStations()
        .then((sts) => {
          for (const s of sts) {
            const mk = L.circleMarker([s.lat, s.lon], {
              radius: 2.5,
              weight: 1.5,
              color: "#1f2937",
              fillColor: "#ffffff",
              fillOpacity: 0.85,
            });
            mk.bindPopup(
              `<strong>${s.name}</strong><br/><span style="opacity:.75">${s.routes.join(
                " · ",
              )}</span><br/><em>Loading arrivals…</em>`,
            );
            mk.on("popupopen", () => {
              getStationArrivals(s.id)
                .then((a) => {
                  const rows = a.arrivals
                    .slice(0, 8)
                    .map((x) => {
                      const eta =
                        x.eta_seconds < 45 ? "due" : `${Math.round(x.eta_seconds / 60)} min`;
                      const dir = x.direction ? ` (${x.direction})` : "";
                      return `<tr><td style="padding-right:8px"><strong>${x.route ?? "?"}</strong>${dir}</td><td>${eta}</td></tr>`;
                    })
                    .join("");
                  mk.setPopupContent(
                    `<strong>${s.name}</strong><br/><span style="opacity:.75">${s.routes.join(
                      " · ",
                    )}</span>` +
                      (rows
                        ? `<table style="margin-top:4px">${rows}</table>`
                        : "<br/><em>No upcoming arrivals reported.</em>"),
                  );
                })
                .catch(() =>
                  mk.setPopupContent(`<strong>${s.name}</strong><br/><em>Arrivals unavailable.</em>`),
                );
            });
            mk.addTo(layer);
          }
        })
        .catch(() => {});
    }
    // sync visibility now (zoom handler covers future zooms)
    const want = showSubway && m.getZoom() >= STATION_MIN_ZOOM;
    const has = m.hasLayer(layer);
    if (want && !has) m.addLayer(layer);
    if (!want && has) m.removeLayer(layer);
  }, [showSubway]);

  // ---- W2: re-color buses immediately on colorMode change ----
  useEffect(() => {
    getVehicles().then(render).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorMode]);

  // ---- route shape overlay + re-filter on selection change ----
  useEffect(() => {
    const sl = shapeLayer.current;
    if (!sl) return;
    sl.clearLayers();
    selectedShape.current = null; // straight-glide until the shape loads
    getVehicles().then(render).catch(() => {});
    if (!selected) return;
    getRouteShape(selected)
      .then((s) => {
        if (selectedRef.current !== selected) return;
        // hand the polylines to the flow layer so THIS route's buses snap+glide
        // along the shape (no corner-cutting on the featured route)
        selectedShape.current = s.polylines;
        getVehicles().then(render).catch(() => {});
        const color = colorFor(selected);
        // Q1.3: the shape becomes a quiet base; the reliability ribbon (segment
        // speeds) overlays it as the hero when segment data exists.
        for (const line of s.polylines) {
          L.polyline(line, { color, weight: 2, opacity: 0.4 }).addTo(sl);
        }
        getRibbon(selected)
          .then((rb) => {
            if (selectedRef.current !== selected) return; // selection moved on
            for (const seg of rb.segments) {
              L.polyline(
                seg.coords.map((c) => [c[0], c[1]] as [number, number]),
                { color: ribbonSpeedColor(seg.speed_pctile), weight: 5, opacity: 0.9, lineCap: "round" },
              )
                .bindPopup(
                  `<strong>${seg.from_stop} → ${seg.to_stop}</strong><br/>` +
                    // W7 honesty #3: wt_speed_mph arrives as an unrounded API float
                    // (e.g. 6.283333333333333 mph). Round to the precision a segment
                    // speed can carry.
                    `<strong>${seg.wt_speed_mph.toFixed(1)} mph</strong> · faster than ${Math.round(
                      seg.speed_pctile * 100,
                    )}% of ${selected}'s segments`,
                )
                .addTo(sl);
            }
          })
          .catch(() => {
            /* no ribbon data — the quiet shape line already drawn stands in */
          });
        for (const stop of s.stops) {
          L.circleMarker([stop.lat, stop.lon], {
            radius: 3,
            weight: 1,
            color,
            fillColor: "#ffffff",
            fillOpacity: 1,
          })
            .bindPopup(`<strong>${stop.stop_name}</strong><br/>Stop ${stop.stop_id}`)
            .addTo(sl);
        }
        if (map.current && s.polylines.length) {
          const all = s.polylines.flat();
          map.current.fitBounds(L.latLngBounds(all as L.LatLngExpression[]).pad(0.1));
        }
      })
      .catch(() => setErr(`No shape for route ${selected}.`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // W7 controls: free-text narrowing over the 345-route list (route number OR long
  // name), grouped by borough exactly as before. The currently-selected route is always
  // kept in the list even if it no longer matches, so typing never silently drops the
  // selection out of the control that is showing it.
  const matched = useMemo(() => {
    const q = routeQ.trim().toLowerCase();
    if (!q) return routes;
    return routes.filter(
      (r) =>
        r.route_id === selected ||
        r.short_name.toLowerCase().includes(q) ||
        r.long_name.toLowerCase().includes(q),
    );
  }, [routes, routeQ, selected]);
  const matchCount = matched.length;

  const grouped = useMemo(() => {
    const by: Record<string, RouteInfo[]> = {};
    for (const r of matched) {
      const g = routeGroup(r.route_id);
      (by[g] ??= []).push(r);
    }
    const order = BOROUGH_GROUP_ORDER;
    return Object.entries(by).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [matched]);

  const asOfCls = err ? "error" : stale || (showSubway && subStale) ? "stale" : "";
  const stampParts: string[] = [];
  if (showBuses)
    stampParts.push(
      `buses ${fmtClock(asOf)} (${source === "archive" ? "archive" : source}${stale ? ", stale" : ""})`,
    );
  if (showSubway)
    stampParts.push(`trains ${fmtClock(subAsOf)} (${subSource}${subStale ? ", partly stale" : ""})`);

  const trailsToggle = (
    <label className="mlg-toggle">
      <input type="checkbox" checked={trails} onChange={(e) => toggleTrails(e.target.checked)} />
      Motion trails <span className="mlg-toggle-hint">(~20 s fading tail)</span>
    </label>
  );

  return (
    <div className="nyc-map-wrap">
      <div className="nyc-map" ref={mapRef} />

      <FlowControls
        follow={follow}
        onStopFollow={stopFollow}
        onFocusFromFollow={() => followSelRef.current && applyFocus(followSelRef.current)}
        focus={focus ? { label: focus.label, kind: focus.kind } : null}
        onClearFocus={clearFocus}
      />

      <div className="nyc-map-controls">
        <div className="row" style={{ display: "flex", gap: "0.9rem" }}>
          <label style={{ fontWeight: 600, display: "flex", gap: "0.3rem", alignItems: "center", marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={showBuses}
              onChange={(e) => setShowBuses(e.target.checked)}
              style={{ width: "auto" }}
            />
            Buses
          </label>
          <label style={{ fontWeight: 600, display: "flex", gap: "0.3rem", alignItems: "center", marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={showSubway}
              onChange={(e) => setShowSubway(e.target.checked)}
              style={{ width: "auto" }}
            />
            Subway
          </label>
        </div>
        {/* W7 controls: this was a bare 345-item <select>. A native select has no search,
            so finding the Bx41 meant scrolling a list a third of a thousand long — on a
            phone, a full-screen wheel. A one-line filter narrows the list as you type
            (route number OR name), the borough optgroups are kept, and the count in the
            first option always tells you how many are currently listed. */}
        {showBuses && (
          <div className="row">
            <label htmlFor="routeQ">Find a bus route</label>
            <input
              id="routeQ"
              type="search"
              placeholder="Type a route or street — e.g. Bx41, Utica"
              value={routeQ}
              onChange={(e) => setRouteQ(e.target.value)}
              autoComplete="off"
            />
            <select
              id="routeSel"
              aria-label="Bus route"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">
                {routeQ.trim()
                  ? `All ${matchCount} matching route${matchCount === 1 ? "" : "s"}`
                  : `All routes (${routes.length})`}
              </option>
              {grouped.map(([g, rs]) => (
                <optgroup key={g} label={boroughLabel(g)}>
                  {rs.map((r) => (
                    <option key={r.route_id} value={r.route_id}>
                      {r.short_name} — {r.long_name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {routeQ.trim() && matchCount === 0 && (
              <div className="muted">No route matches “{routeQ.trim()}”.</div>
            )}
          </div>
        )}
        {showBuses && (
          <div className="row">
            {/* W2: borough first — it is the default encoding on this surface too. */}
            <label id="busColorLbl">Color buses by</label>
            <div className="imm-colortoggle" role="group" aria-labelledby="busColorLbl">
              <button
                type="button"
                className={colorMode === "borough" ? "on" : ""}
                onClick={() => setColorMode("borough")}
                title="Colour each bus by its route's home borough"
              >
                Borough
              </button>
              <button
                type="button"
                className={colorMode === "route" ? "on" : ""}
                onClick={() => setColorMode("route")}
                title="Colour each bus by its official GTFS route_color (MTA service type)"
              >
                Route color
              </button>
            </div>
          </div>
        )}
        <div className="muted">
          {showBuses ? `${count.toLocaleString()} bus${count === 1 ? "" : "es"}` : ""}
          {showBuses && showSubway ? " · " : ""}
          {showSubway ? `${subCount.toLocaleString()} train${subCount === 1 ? "" : "s"}` : ""}
          {selected && showBuses ? ` · route ${selected}` : ""}
          {/* W5 P2: the frame-time readout ("12.3 ms/frame (tick-jump)") was public.
              It is engineering telemetry — a planner reads it as a fault report. Gated
              behind ?perf / dev builds; the perf harness still gets it. */}
          {perf && perfVisible() ? ` · ${perf.ms.toFixed(1)} ms/frame${perf.tickJump ? " (tick-jump)" : ""}` : ""}
        </div>
        {showSubway && <div className="muted">Zoom in to tap stations for live arrivals.</div>}
      </div>

      {alerts.length > 0 && !alertsDismissed && (
        <div className="nyc-alerts-wrap">
          {/* Q0.3: single collapsed pill (top-right) expands to a scrollable
              drawer; sits top-right so it never covers the top-left filter
              control, and collapses to one line at 390px. */}
          <button
            type="button"
            className="nyc-alert-pill"
            aria-expanded={alertsOpen}
            onClick={() => setAlertsOpen((v) => !v)}
          >
            <span aria-hidden="true">⚠</span> {alerts.length} service alert{alerts.length === 1 ? "" : "s"}
            <span className="nyc-alert-caret" aria-hidden="true">{alertsOpen ? "▴" : "▾"}</span>
          </button>
          {alertsOpen && (
            <div className="nyc-alert-drawer" aria-label="Service alerts">
              <div className="nyc-alert-drawer-head">
                <span>Service alerts</span>
                <button
                  type="button"
                  className="nyc-alert-close"
                  aria-label="Dismiss service alerts"
                  onClick={() => setAlertsDismissed(true)}
                >
                  ✕
                </button>
              </div>
              {alerts.map((a) => (
                <div className="nyc-alert" key={a.id}>
                  <strong>{a.routes.length ? a.routes.slice(0, 4).join(", ") + ": " : ""}</strong>
                  {a.header}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={"nyc-asof " + asOfCls} aria-live="polite">
        <span className="dot" />
        {err ? err : stampParts.length ? `as of ${stampParts.join(" · ")}` : "—"}
      </div>

      <MapLegend
        defaultOpen
        items={[
          <span>
            <strong>Vehicles drawn true-to-scale</strong> — a bus&nbsp;≈&nbsp;12&nbsp;m, a
            train&nbsp;≈&nbsp;160&nbsp;m; zoom in.
          </span>,
          showBuses &&
            (colorMode === "borough" ? (
              <span>
                Buses by home borough:{" "}
                {BOROUGH_LEGEND.map((b) => (
                  <span key={b.g} className="mlg-pair">
                    <Swatch color={b.color} />
                    {b.short}{" "}
                  </span>
                ))}
                <br />
                <span className="mlg-note">{BOROUGH_LEGEND_NOTE}</span>
              </span>
            ) : (
              <span>
                Buses take their official GTFS route color — which encodes MTA{" "}
                <em>service type</em> (local / limited / SBS / express), not the route: only 7
                distinct values exist across all 345 routes.
              </span>
            )),
          showSubway && (
            <span>
              Subway — official line colors:{" "}
              {TRUNK_LINES.map((k) => (
                <Bullet key={k} label={subwayLabel(k)} bg={subwayColor(k)} fg={subwayTextColor(k)} />
              ))}
            </span>
          ),
          /* W7 honesty #1 (2026-07-24): this said movement was "modeled from each
              route's recorded behavior", and the immersive ⓘ panel went further and
              named "per-segment speeds we've logged since July". NO SUCH MODEL EXISTS.
              flow/core.ts carries ONE speed per vehicle — the speed that vehicle itself
              last reported — and advances it along the route shape for up to STALE_S
              (40 s), after which it eases to a stop rather than inventing motion.
              Per-segment learned profiles are unstarted backlog. The copy now describes
              the engine that is actually running. */
          <span>
            Reports arrive ~31&nbsp;s apart. Between them a bus keeps moving at{" "}
            <em>the speed it last reported</em>, along its own route shape, for up to about
            40&nbsp;s &mdash; then it eases to a stop rather than guessing
            {showSubway ? "; trains are placed along the track between the stations they report" : ""}.
          </span>,
          <span>
            State: <Swatch color="#3b82f6" />solid observed ·{" "}
            <Swatch color="#3b82f6" faded />faded estimated
            {showSubway && (
              <>
                {" · "}
                <Swatch color="#6b7280" shape="ring" />ring docked at stop
              </>
            )}
          </span>,
          trailsToggle,
        ]}
        details={[
          showBuses && selected ? (
            <span>
              {selected} segment speed: <Swatch color="#c1272d" shape="line" />slow{" "}
              <Swatch color="#cfcfcf" shape="line" />on-pace <Swatch color="#1a6fb5" shape="line" />
              fast
            </span>
          ) : null,
          <MapThemePicker id="busMapTheme" />,
          <HouseNumberToggle id="busHouseNums" />,
        ]}
        stamps={
          <>
            {basemap && (
              <div>
                {basemap.vintageNote} · {basemap.attribution}
              </div>
            )}
            <div>Live positions served via this site's backend.</div>
          </>
        }
      />
    </div>
  );
}

function popupHtml(v: Vehicle): string {
  const t = v.timestamp
    ? new Date(v.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  return (
    `<div style="min-width:150px">` +
    `<strong>Route ${v.route_id ?? "?"}</strong><br/>` +
    `Vehicle <code>${v.vehicle_id}</code><br/>` +
    `Next stop: ${v.stop_id ?? "—"}<br/>` +
    `Bearing: ${v.bearing != null ? Math.round(v.bearing) + "°" : "—"}<br/>` +
    `Reported: ${t}` +
    `</div>`
  );
}

function trainPopupHtml(t: SubwayTrain): string {
  const clock = t.timestamp
    ? new Date(t.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const est = t.positional_basis === "interpolated";
  let statusLine: string;
  if (t.status === "at_station") statusLine = `At ${t.stop_name}`;
  else if (t.status === "approaching") statusLine = `Approaching ${t.stop_name} — estimated position`;
  else
    statusLine = t.prev_stop_name
      ? `En route ${t.prev_stop_name} → ${t.stop_name} — estimated position`
      : `En route to ${t.stop_name} — estimated position`;
  const bullet = `<span style="display:inline-flex;width:16px;height:16px;border-radius:50%;background:${subwayColor(
    t.route_id,
  )};color:${subwayTextColor(t.route_id)};font:700 9px/16px system-ui;justify-content:center;vertical-align:middle">${subwayLabel(
    t.route_id,
  )}</span>`;
  return (
    `<div style="min-width:170px">` +
    `${bullet} <strong>${subwayLabel(t.route_id)} train</strong><br/>` +
    `${statusLine}<br/>` +
    `Trip <code>${t.trip_id}</code><br/>` +
    `Reported: ${clock}${est ? " · <em>estimated</em>" : ""}` +
    `</div>`
  );
}
