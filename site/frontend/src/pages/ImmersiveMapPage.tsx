// Immersive ant-farm map (I1) — full-window live map with floating chrome.
//
// Two modes share this one host, each mounted on its own route:
//   /live/bus    → ant-farm buses only  (route filter + borough/route color)
//   /live/subway → track-worms only     (line filter chips + station dots)
//
// The map canvas fills 100dvw × 100dvh (safe-area-inset padded) with NO page
// scroll and NO standard header/footer — a floating translucent top strip carries
// the links back into the rest of the site, and a corner "ⓘ" overlay carries the
// MANDATED dual anchors (heterodata.org + nickanderson.us), attribution, the
// data-honesty stamp, and a theme toggle (D4/D9 compliance without page chrome).
//
// The live renderer is the SAME VehicleFlowLayer "ant farm" that powers /bus — it
// is imported and REUSED here, not forked. This page only re-scopes it to one mode
// and wraps it in the immersive chrome + shareable URL state.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBasemap, bboxParam, NYC_CENTER, NYC_BOUNDS, MAP_MAX_ZOOM, type BasemapInfo } from "../lib/basemap";
import { RouteShapeCache } from "../lib/shapeCache";
import { trackMapError } from "../lib/beacon";
import {
  getVehicles,
  getRoutes,
  getRouteShape,
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
} from "../lib/api";
import { subwayColor, subwayTextColor, subwayLabel } from "../lib/subwayColors";
import { BOROUGH_GROUP_ORDER } from "../lib/boroughs";
import { VehicleFlowLayer, type FlowSelection } from "../components/VehicleFlowLayer";
import MapLegend, { Swatch, Bullet } from "../components/MapLegend";
import FlowControls, { type FollowInfo, type FocusInfo } from "../components/FlowControls";

// Representative trunk bullets for the subway "official line colors" legend row.
const TRUNK_LINES = ["1", "4", "7", "A", "B", "G", "J", "L", "N", "S"];

export type ImmersiveMode = "buses" | "subway";

// Stable borough fallback palette (mirrors /bus — trivial constants, not the
// renderer logic). Colorblind-aware, brand-neutral.
const GROUP_COLORS: Record<string, string> = {
  M: "#2563eb",
  B: "#16a34a",
  Q: "#d97706",
  Bx: "#dc2626",
  S: "#7c3aed",
  X: "#0891b2",
  SIM: "#0891b2",
};
function routeGroup(routeId: string): string {
  const up = routeId.toUpperCase();
  if (up.startsWith("BX")) return "Bx";
  if (up.startsWith("SIM")) return "SIM";
  if (up.startsWith("X")) return "X";
  const c = up.charAt(0);
  return "MBQS".includes(c) ? c : "M";
}
function boroughLabel(g: string): string {
  return (
    { M: "Manhattan", B: "Brooklyn", Q: "Queens", Bx: "Bronx", S: "Staten Island", SIM: "SI Express", X: "Express" }[g] ??
    g
  );
}

// Subway line chips in official running order; express/shuttle variants collapse
// onto their trunk chip via lineKey() so selecting "6" also keeps the "6X" express.
const SUBWAY_LINES = [
  "1", "2", "3", "4", "5", "6", "7",
  "A", "C", "E", "B", "D", "F", "M",
  "G", "J", "Z", "L", "N", "Q", "R", "W", "S", "SIR",
];
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

const STATION_MIN_ZOOM = 13;

function fmtClock(epoch: number | null): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// "updated mm:ss ago" for the always-visible honest clock (F4).
function fmtAge(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// ---- theme (kit-compatible): mirror arcanum-chrome.js setTheme ----
function currentDark(): boolean {
  const t = typeof document !== "undefined" ? document.documentElement.getAttribute("data-theme") : null;
  if (t === "dark") return true;
  if (t === "light") return false;
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}
function applySavedTheme() {
  try {
    const s = localStorage.getItem("ark-theme");
    if (s === "dark" || s === "light") document.documentElement.setAttribute("data-theme", s);
  } catch {
    /* storage blocked — fall back to OS preference */
  }
}
function setTheme(mode: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", mode);
  try {
    localStorage.setItem("ark-theme", mode);
  } catch {
    /* ignore */
  }
  document.dispatchEvent(new CustomEvent("ark:themechange", { detail: { theme: mode } }));
}

const HUB = { name: "heterodata.org", url: "https://heterodata.org" };
const AUTHOR = { name: "nickanderson.us", url: "https://nickanderson.us" };
const APEX = "https://nycvisualizer.com";

// Site links carried in the floating top strip (the user's "links at the top").
const STRIP_LINKS: { label: string; to: string }[] = [
  { label: "Transit Map", to: "/bus" },
  { label: "Observatory", to: "/observatory" },
  { label: "Ops Wall", to: "/ops" },
  { label: "Sidewalks", to: "/sidewalks" },
  { label: "Renter's Map", to: "/renters" },
  { label: "Data", to: "/data" },
];

interface InitState {
  center: [number, number] | null;
  zoom: number | null;
  route: string;
  lines: Set<string>;
}
function parseUrlState(): InitState {
  const out: InitState = { center: null, zoom: null, route: "", lines: new Set() };
  try {
    const p = new URLSearchParams(window.location.search);
    const ll = p.get("ll");
    if (ll) {
      const [a, b] = ll.split(",").map(Number);
      if (isFinite(a) && isFinite(b)) out.center = [a, b];
    }
    const z = p.get("z");
    if (z && isFinite(Number(z))) out.zoom = Number(z);
    out.route = p.get("route") ?? "";
    const line = p.get("line");
    if (line) for (const k of line.split(",")) if (k) out.lines.add(k.toUpperCase());
  } catch {
    /* non-browser env */
  }
  return out;
}

export default function ImmersiveMapPage({ mode }: { mode: ImmersiveMode }) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const flow = useRef<VehicleFlowLayer | null>(null);
  const stationLayer = useRef<L.LayerGroup | null>(null);
  const shapeLayer = useRef<L.LayerGroup | null>(null);
  const focusLayer = useRef<L.LayerGroup | null>(null);
  const selectedShape = useRef<[number, number][][] | null>(null);
  const stationsLoaded = useRef(false);

  const init = useRef<InitState>(parseUrlState());

  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [selected, setSelected] = useState<string>(mode === "buses" ? init.current.route : "");
  const [colorMode, setColorMode] = useState<"route" | "borough">("route");
  const [lines, setLines] = useState<Set<string>>(mode === "subway" ? init.current.lines : new Set());

  const [asOf, setAsOf] = useState<number | null>(null);
  const [source, setSource] = useState<string>("none");
  const [stale, setStale] = useState(false);
  const [count, setCount] = useState(0);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perf, setPerf] = useState<{ ms: number; fps: number; tickJump: boolean; predErrFt: number | null } | null>(null);

  // chrome ui
  const [idle, setIdle] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [, forceThemeTick] = useState(0);

  // F4: follow mode · focus dim · motion trails · honest clock
  const [follow, setFollow] = useState<FollowInfo | null>(null);
  const [focus, setFocus] = useState<(FocusInfo & { key: string; routeId: string | null }) | null>(null);
  const [trails, setTrails] = useState(true); // immersive /live/* default ON
  const followingRef = useRef(false);
  const followIdRef = useRef<string | null>(null);
  const followSelRef = useRef<FlowSelection | null>(null);
  const focusRef = useRef<typeof focus>(null);
  focusRef.current = focus;
  const stopFollowRef = useRef(() => {});
  const onFollowRef = useRef<(s: FlowSelection) => void>(() => {});
  const onFocusRef = useRef<(s: FlowSelection) => void>(() => {});

  // now-ticker for the always-visible honest clock ("updated mm:ss ago")
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const colorModeRef = useRef(colorMode);
  colorModeRef.current = colorMode;
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const routeColorByShort = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of routes) if (r.color) m.set(r.short_name, "#" + r.color.replace(/^#/, ""));
    return m;
  }, [routes]);

  const colorFor = (routeId: string | null): string => {
    if (!routeId) return "#6b7280";
    if (colorModeRef.current === "borough") return GROUP_COLORS[routeGroup(routeId)] ?? "#2563eb";
    const c = routeColorByShort.get(routeId);
    if (c && c.toLowerCase() !== "#ffffff") return c;
    return GROUP_COLORS[routeGroup(routeId)] ?? "#2563eb";
  };
  const colorForRef = useRef(colorFor);
  colorForRef.current = colorFor;

  // ---- F4 handlers (kept in refs so the once-constructed layer calls latest) ----
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

  // ---- one-time page setup: theme, title, canonical, body-scroll lock ----
  useEffect(() => {
    applySavedTheme();
    const prevTitle = document.title;
    const prevOverflow = document.body.style.overflow;
    document.title =
      mode === "buses" ? "Live Bus Ant Farm — NYC Visualizer" : "Live Subway — NYC Visualizer";
    document.body.style.overflow = "hidden";
    // canonical → apex path (subdomains are additive; avoid duplicate-content)
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = APEX + (mode === "buses" ? "/live/bus" : "/live/subway");
    document.head.appendChild(canonical);
    return () => {
      document.title = prevTitle;
      document.body.style.overflow = prevOverflow;
      canonical.remove();
    };
  }, [mode]);

  // ---- idle-fade: strip fades to a grab-tab after ~5s; any input wakes it ----
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), 5000);
    };
    wake();
    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener("pointermove", wake, opts);
    window.addEventListener("pointerdown", wake, opts);
    window.addEventListener("touchstart", wake, opts);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("touchstart", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  // ---- write shareable URL state (debounced on moveend + filter changes) ----
  const writeUrl = useRef(() => {
    const m = map.current;
    if (!m) return;
    if (followingRef.current) return; // don't spam history while the camera tracks
    const c = m.getCenter();
    const p = new URLSearchParams();
    p.set("ll", `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`);
    p.set("z", String(m.getZoom()));
    if (mode === "buses" && selectedRef.current) p.set("route", selectedRef.current);
    if (mode === "subway" && linesRef.current.size) p.set("line", [...linesRef.current].join(","));
    window.history.replaceState(null, "", window.location.pathname + "?" + p.toString());
  });

  // ---- map init ----
  useEffect(() => {
    if (map.current || !mapRef.current) return;
    let m: L.Map;
    try {
      m = L.map(mapRef.current, {
        center: init.current.center ?? NYC_CENTER,
        zoom: init.current.zoom ?? 12,
        minZoom: 9,
        maxZoom: MAP_MAX_ZOOM, // W6.1: z15 basemap data over-zoomed to 19 keeps roads visible
        maxBounds: NYC_BOUNDS,
        maxBoundsViscosity: 0.6,
        zoomControl: true,
      });
    } catch (e) {
      // F5: caught map-init error → beacon (kind=map_error, detail=init:*).
      trackMapError("init:" + (e instanceof Error ? e.message : String(e)));
      setErr("The map failed to initialize.");
      return;
    }
    m.zoomControl.setPosition("bottomleft");
    // F5: reliability guard — raster fallback auto-engage + degradation beacon.
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
    stationLayer.current = L.layerGroup();
    shapeLayer.current = L.layerGroup().addTo(m);
    focusLayer.current = L.layerGroup().addTo(m);
    const fl = new VehicleFlowLayer({
      busPopup: popupHtml,
      trainPopup: trainPopupHtml,
      onFollow: (s) => onFollowRef.current(s),
      onFocus: (s) => onFocusRef.current(s),
    });
    fl.addTo(m);
    fl.setVisibility(mode === "buses", mode === "subway");
    fl.setTrails(true); // immersive /live/* default ON
    fl.setShapeSource(new RouteShapeCache()); // W1: lazy per-route shape geometry for glide
    flow.current = fl;
    // opt-in perf harness hook (headless frame-time measurement only)
    if (new URLSearchParams(window.location.search).has("perf")) {
      const w = window as unknown as Record<string, unknown>;
      w.__nycvFlow = fl;
      w.__nycvMap = m;
    }
    // tap the map (empty) stops follow mode (the pill's other exit is ESC)
    m.on("click", () => stopFollowRef.current());
    const syncStations = () => {
      if (!stationLayer.current || mode !== "subway") return;
      const want = m.getZoom() >= STATION_MIN_ZOOM;
      const has = m.hasLayer(stationLayer.current);
      if (want && !has) m.addLayer(stationLayer.current);
      if (!want && has) m.removeLayer(stationLayer.current);
    };
    m.on("zoomend", syncStations);
    m.on("moveend", () => writeUrl.current());
    map.current = m;
    // Leaflet reads container size at init; the flex/fixed layout is already
    // sized, but invalidate once on the next frame to be safe on mobile chrome.
    requestAnimationFrame(() => m.invalidateSize());
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- BUS mode: route catalog ----
  useEffect(() => {
    if (mode !== "buses") return;
    getRoutes().then(setRoutes).catch(() => setErr("Could not load route list."));
  }, [mode]);

  // ---- BUS render ----
  const renderBuses = (data: VehiclesResponse) => {
    setAsOf(data.as_of);
    setSource(data.source);
    setStale(data.stale);
    setErr(null);
    const fl = flow.current;
    if (!fl) return;
    const sel = selectedRef.current;
    fl.setBuses(data.vehicles, sel, colorForRef.current);
    setCount(sel ? data.vehicles.filter((v) => v.route_id === sel).length : data.vehicles.length);
  };

  // ---- SUBWAY render (line-filtered client-side) ----
  const renderSubway = (data: SubwayResponse) => {
    setAsOf(data.as_of);
    setSource(data.source);
    setStale(data.stale);
    const fl = flow.current;
    if (!fl) return;
    const sel = linesRef.current;
    const trains = sel.size ? data.trains.filter((t) => sel.has(lineKey(t.route_id))) : data.trains;
    fl.setTrains(trains);
    setCount(trains.length);
  };

  // ---- BUS live feed (F5: bbox-slimmed polls + fetch-on-moveend) ----
  useEffect(() => {
    if (mode !== "buses") return;
    let cancelled = false;
    const pull = () =>
      getVehicles(map.current ? bboxParam(map.current) : undefined)
        .then((d) => !cancelled && renderBuses(d))
        .catch(() => !cancelled && setErr("Live bus feed unavailable."));
    pull();
    const unsub = streamVehicles((d) => !cancelled && renderBuses(d), () => {});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, routeColorByShort]);

  // ---- SUBWAY live feed (F5: bbox-slimmed polls + fetch-on-moveend) ----
  useEffect(() => {
    if (mode !== "subway") return;
    let cancelled = false;
    const pull = () =>
      getSubway(map.current ? bboxParam(map.current) : undefined)
        .then((d) => !cancelled && renderSubway(d))
        .catch(() => !cancelled && setErr("Live subway feed unavailable."));
    pull();
    const unsub = streamSubway((d) => !cancelled && renderSubway(d), () => {});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ---- honest frame-time readout ----
  useEffect(() => {
    const t = setInterval(() => {
      const s = flow.current?.getStats();
      if (s) setPerf({ ms: s.emaFrameMs, fps: s.fps, tickJump: s.tickJump, predErrFt: s.predErr.medianFt });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- F4 follow: ease the camera to the tracked unit, keep zoom ----
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
        stopFollowRef.current(); // vehicle gone → release + dismiss pill
        return;
      }
      const target = L.latLng(ll[0], ll[1]);
      // only pan when the unit has drifted off-center (avoids constant micro-pans)
      const cp = m.latLngToContainerPoint(target);
      const cc = m.getSize().divideBy(2);
      if (cp.distanceTo(cc) > 12) {
        m.panTo(target, { animate: true, duration: 0.45, easeLinearity: 0.5 });
      }
    };
    tick();
    const iv = setInterval(tick, 350);
    return () => clearInterval(iv);
  }, [follow]);

  // ---- ESC releases follow mode ----
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
      fl.setFocus((k, rid) => k === "train" && lineKey(rid) === key); // dim-only (line shape not cheap)
    } else {
      const rid = focus.routeId;
      fl.setFocus((k, r) => k === "bus" && r === rid);
      if (rid && fx) {
        getRouteShape(rid)
          .then((s) => {
            if (focusRef.current?.routeId !== rid) return; // focus moved on
            const color = colorForRef.current(rid);
            for (const line of s.polylines) {
              L.polyline(line, { color, weight: 3, opacity: 0.7 }).addTo(fx);
            }
          })
          .catch(() => {});
      }
    }
  }, [focus]);

  // ---- re-color buses immediately on colorMode change ----
  useEffect(() => {
    if (mode !== "buses") return;
    getVehicles().then(renderBuses).catch(() => {});
    writeUrl.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorMode]);

  // ---- re-filter subway immediately on line-chip change ----
  useEffect(() => {
    if (mode !== "subway") return;
    getSubway().then(renderSubway).catch(() => {});
    writeUrl.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  // ---- SUBWAY station markers (zoom-gated, tap → live arrivals) ----
  useEffect(() => {
    if (mode !== "subway") return;
    const m = map.current;
    const layer = stationLayer.current;
    if (!m || !layer || stationsLoaded.current) return;
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
                    const eta = x.eta_seconds < 45 ? "due" : `${Math.round(x.eta_seconds / 60)} min`;
                    const dir = x.direction ? ` (${x.direction})` : "";
                    return `<tr><td style="padding-right:8px"><strong>${x.route ?? "?"}</strong>${dir}</td><td>${eta}</td></tr>`;
                  })
                  .join("");
                mk.setPopupContent(
                  `<strong>${s.name}</strong><br/><span style="opacity:.75">${s.routes.join(" · ")}</span>` +
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
        const want = m.getZoom() >= STATION_MIN_ZOOM;
        if (want && !m.hasLayer(layer)) m.addLayer(layer);
      })
      .catch(() => {});
  }, [mode]);

  // ---- BUS route shape overlay (shape-snapped glide for the filtered route) ----
  useEffect(() => {
    if (mode !== "buses") return;
    const sl = shapeLayer.current;
    if (!sl) return;
    sl.clearLayers();
    selectedShape.current = null;
    getVehicles().then(renderBuses).catch(() => {});
    writeUrl.current();
    if (!selected) return;
    getRouteShape(selected)
      .then((s) => {
        if (selectedRef.current !== selected) return;
        selectedShape.current = s.polylines;
        getVehicles().then(renderBuses).catch(() => {});
        const color = colorFor(selected);
        for (const line of s.polylines) {
          L.polyline(line, { color, weight: 2.5, opacity: 0.5 }).addTo(sl);
        }
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
          map.current.fitBounds(L.latLngBounds(all as L.LatLngExpression[]).pad(0.15));
        }
      })
      .catch(() => setErr(`No shape for route ${selected}.`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const grouped = useMemo(() => {
    const by: Record<string, RouteInfo[]> = {};
    for (const r of routes) (by[routeGroup(r.route_id)] ??= []).push(r);
    const order = BOROUGH_GROUP_ORDER;
    return Object.entries(by).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [routes]);

  const toggleLine = (k: string) =>
    setLines((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const dark = currentDark();
  const asOfCls = err ? "error" : stale ? "stale" : "";
  const trailsToggle = (
    <label className="mlg-toggle">
      <input type="checkbox" checked={trails} onChange={(e) => toggleTrails(e.target.checked)} />
      Motion trails <span className="mlg-toggle-hint">(~20 s fading tail)</span>
    </label>
  );

  return (
    <div className={"imm-root" + (dark ? " imm-dark" : "")} data-mode={mode}>
      <div className="imm-map" ref={mapRef} />

      {/* ---- floating top strip (auto-fades to a grab-tab when idle) ---- */}
      <div className={"imm-strip" + (idle && !navOpen ? " imm-strip--idle" : "")}>
        <div className="imm-strip-grabtab" aria-hidden="true" onMouseEnter={() => setIdle(false)} />
        <div className="imm-strip-inner">
          <div className="imm-strip-left">
            <a className="imm-mark" href={HUB.url} aria-label="Heterodata hub — heterodata.org">
              <svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true">
                <path d="M16 3 4 27h5l2.4-5h9.2l2.4 5h5L16 3Zm-2.7 14L16 11l2.7 6h-5.4Z" fill="currentColor" />
                <circle cx="16" cy="25.5" r="1.6" fill="currentColor" />
              </svg>
              <span className="imm-mark-txt">NYC Visualizer</span>
            </a>
            {/* Bus↔Subway is a FULL page load (plain <a>, not an SPA <Link>): the two
                immersive families each own a Leaflet map + live feeds; an in-SPA route
                swap leaves a half-torn map and degrades/freezes. A real navigation gives
                each family a fresh document + clean map init. Within-family links (the
                site sections below) stay SPA. */}
            <div className="imm-modeswitch" role="group" aria-label="Immersive mode">
              <a className={"imm-mode" + (mode === "buses" ? " on" : "")} href="/live/bus">
                Buses
              </a>
              <a className={"imm-mode" + (mode === "subway" ? " on" : "")} href="/live/subway">
                Subway
              </a>
            </div>
          </div>

          <nav className={"imm-links" + (navOpen ? " open" : "")} aria-label="Site sections">
            {STRIP_LINKS.map((l) => (
              <Link key={l.to} to={l.to} className="imm-link" onClick={() => setNavOpen(false)}>
                {l.label}
              </Link>
            ))}
          </nav>

          <button
            type="button"
            className="imm-menu-btn"
            aria-expanded={navOpen}
            aria-label="Menu"
            onClick={() => setNavOpen((v) => !v)}
          >
            {navOpen ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {/* ---- mode-scoped filter controls (top-left) ---- */}
      <div className="imm-filter">
        {mode === "buses" ? (
          <>
            <label htmlFor="immRoute" className="imm-filter-label">
              Route
            </label>
            <select
              id="immRoute"
              className="imm-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">All routes ({routes.length})</option>
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
            <div className="imm-colortoggle" role="group" aria-label="Color buses by">
              <button
                type="button"
                className={colorMode === "route" ? "on" : ""}
                onClick={() => setColorMode("route")}
              >
                Route color
              </button>
              <button
                type="button"
                className={colorMode === "borough" ? "on" : ""}
                onClick={() => setColorMode("borough")}
              >
                Borough
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="imm-filter-label imm-filter-label--chips">
              Lines {lines.size ? `(${lines.size})` : "(all)"}
              {lines.size > 0 && (
                <button type="button" className="imm-chip-clear" onClick={() => setLines(new Set())}>
                  clear
                </button>
              )}
            </div>
            <div className="imm-linechips">
              {SUBWAY_LINES.map((k) => {
                const on = lines.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    className={"imm-bullet" + (on ? " on" : "")}
                    style={{ background: subwayColor(k), color: subwayTextColor(k) }}
                    aria-pressed={on}
                    aria-label={`Line ${subwayLabel(k)}`}
                    onClick={() => toggleLine(k)}
                  >
                    {subwayLabel(k)}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ---- live count + as-of (top-right) ---- */}
      <div className={"imm-asof " + asOfCls} aria-live="polite">
        <span className="dot" />
        {err ? (
          err
        ) : (
          <>
            <strong>{count.toLocaleString()}</strong> {mode === "buses" ? "buses" : "trains"}
            <span className="imm-asof-sep">·</span>
            as of {fmtClock(asOf)} ({source}
            {stale ? ", stale" : ""})
          </>
        )}
      </div>

      {/* ---- corner ⓘ overlay: dual anchors + attribution + honesty + theme ---- */}
      <div className={"imm-info" + (infoOpen ? " open" : "")}>
        <button
          type="button"
          className="imm-info-btn"
          aria-expanded={infoOpen}
          aria-label={infoOpen ? "Close info" : "About this map, links & attribution"}
          onClick={() => setInfoOpen((v) => !v)}
        >
          {infoOpen ? "✕" : "ⓘ"}
        </button>
        {infoOpen && (
          <div className="imm-info-panel" role="dialog" aria-label="Map info, links and attribution">
            <div className="imm-info-title">
              {mode === "buses" ? "Live Bus Ant Farm" : "Live Subway"}
            </div>
            <p className="imm-info-honesty">
              {mode === "buses"
                ? "Every MTA bus, refreshed ~30s from the GTFS-RT feed via our server-side poller. Buses carry GPS; shapes are drawn at true scale. "
                : "Trains report by station; between stations a train's position is an honest estimate interpolated along the track (shown faded). "}
              Positions between reports are estimated (glided) — no easing gimmicks.
            </p>
            <div className="imm-info-stamp">
              Data as of {fmtClock(asOf)} · source {source}
              {stale ? " (stale)" : ""}
              {perf ? ` · ${perf.ms.toFixed(1)} ms/frame @ ${perf.fps} fps${perf.tickJump ? " (tick-jump)" : ""}` : ""}
              {perf?.predErrFt != null ? ` · ~${perf.predErrFt} ft median between-tick prediction error` : ""}
            </div>
            {basemap && <div className="imm-info-attr">{basemap.vintageNote} · {basemap.attribution}</div>}
            <div className="imm-info-anchors">
              <span>
                Hub: <a href={HUB.url}>{HUB.name}</a>
              </span>
              <span>
                Architect: <a href={AUTHOR.url}>{AUTHOR.name}</a>
              </span>
            </div>
            <div className="imm-info-foot">
              <a href={APEX + "/data"}>Data &amp; methodology</a>
              <button
                type="button"
                className="imm-theme-toggle"
                onClick={() => {
                  setTheme(currentDark() ? "light" : "dark");
                  forceThemeTick((t) => t + 1);
                }}
              >
                {dark ? "☀ Light" : "☾ Dark"}
              </button>
            </div>
            <p className="imm-info-realdata">Real data only — Heterodata, an Arcanum Research project.</p>
          </div>
        )}
      </div>

      {/* ---- F4 follow pill / focus chip (only while active) ---- */}
      <FlowControls
        follow={follow}
        onStopFollow={stopFollow}
        onFocusFromFollow={() => followSelRef.current && applyFocus(followSelRef.current)}
        focus={focus ? { label: focus.label, kind: focus.kind } : null}
        onClearFocus={clearFocus}
      />

      {/* ---- F4 honest clock: always-visible, glanceable "updated mm:ss ago" ---- */}
      <div className={"imm-clock " + asOfCls} title="Time since the freshest live snapshot">
        <span className="imm-clock-dot" aria-hidden="true" />
        {asOf ? (
          <>
            live<span className="imm-clock-sep"> · </span>
            <span className="imm-clock-age">updated {fmtAge(Math.max(0, Math.round(nowSec - asOf)))} ago</span>
          </>
        ) : (
          "connecting…"
        )}
      </div>

      {/* ---- shared MapLegend (collapsed by default on immersive) ---- */}
      <MapLegend
        className="maplegend--imm"
        items={
          mode === "buses"
            ? [
                <span>
                  <strong>Buses drawn true-to-scale</strong> — a bus&nbsp;≈&nbsp;12&nbsp;m; zoom in.
                </span>,
                colorMode === "borough" ? (
                  <span>
                    By borough: <Swatch color="#dc2626" />Bx <Swatch color="#16a34a" />Bklyn{" "}
                    <Swatch color="#2563eb" />Man <Swatch color="#d97706" />Qns <Swatch color="#7c3aed" />
                    SI <Swatch color="#0891b2" />Exp
                  </span>
                ) : (
                  <span>Each bus takes its official route color (borough colors when unfiltered).</span>
                ),
                <span>
                  Positions update ~30&nbsp;s · movement between updates is <em>estimated</em>.
                </span>,
                <span>
                  State: <Swatch color="#3b82f6" />solid observed (GPS) ·{" "}
                  <Swatch color="#3b82f6" faded />faded estimated
                </span>,
                trailsToggle,
              ]
            : [
                <span>
                  <strong>Trains drawn true-to-scale</strong> — a train&nbsp;≈&nbsp;160&nbsp;m; zoom in.
                </span>,
                <span>
                  Official line colors:{" "}
                  {TRUNK_LINES.map((k) => (
                    <Bullet key={k} label={subwayLabel(k)} bg={subwayColor(k)} fg={subwayTextColor(k)} />
                  ))}
                </span>,
                <span>
                  Positions update ~30&nbsp;s · movement between updates is <em>estimated</em>.
                </span>,
                <span>
                  State: <Swatch color="#3b82f6" />solid observed ·{" "}
                  <Swatch color="#3b82f6" faded />faded estimated ·{" "}
                  <Swatch color="#6b7280" shape="ring" />ring docked at stop
                </span>,
                trailsToggle,
              ]
        }
        stamps={
          <>
            <div>
              Data as of {fmtClock(asOf)} · source {source}
              {stale ? " (stale)" : ""}
            </div>
            {basemap && <div>{basemap.vintageNote} · {basemap.attribution}</div>}
          </>
        }
      />
    </div>
  );
}

// ---- popups (mirror /bus so hit-testing feels identical) ----
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
