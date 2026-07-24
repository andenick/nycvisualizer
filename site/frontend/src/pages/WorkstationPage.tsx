// Planner Workstation (C3 — the ANTFARM_V3 UNIFIED flagship): ONE multi-route +
// multi-line analytical monitoring tool for a professional transit planner.
//
//   /workstation   (work.nycvisualizer.com) — mixed BUS-route + SUBWAY-line planner
//
// Replaces the two former single-mode workstations (/workstation/bus + /workstation/
// subway, hosts buses./subways.). Bus routes and subway lines are FREELY MIXABLE in one
// selection (e.g. the Bx12 and the D together); the map renders every selected population
// at once — bus stops + subway stations as colored dots (NO connecting lines; route-lines
// toggle default OFF), live buses + subway track-worms via the SAME VehicleFlowLayer "ant
// farm" motion model, each selection in its own colour (buses: validated colourblind-safe
// palette; subway lines: official MTA bullet colour — so the two populations are always
// visually distinct). Full-window immersive-chrome pattern (floating strip + corner ⓘ
// overlay + legend chip + honest clock). Shareable URL state (?routes=BX12,B44&lines=D,7).
//
// The left panel is ONE scrollable multi-select with two sections — Bus routes (borough-
// grouped, Bronx-first, select-all per borough, search) and Subway lines (official-bullet
// checkboxes, group select-alls). The right rail is the unified "easy to find data" table:
// one row per selection — buses show active-now · observed vs scheduled headway · bunching ·
// on-route position quality; subway lines show trains-active · active alerts (NO fabricated
// headway). Sortable, with a contract-compliant CSV of the MIXED selection, dossier links
// (full page load), and a per-row expandable detail drawer that reuses /api/obs/dossier
// headline fields (buses) / active alerts (lines) — no new data claims.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBasemap, bboxParam, NYC_CENTER, NYC_BOUNDS, MAP_MAX_ZOOM, type BasemapInfo } from "../lib/basemap";
import { RouteShapeCache } from "../lib/shapeCache";
import { trackMapError } from "../lib/beacon";
import {
  getVehicles,
  getObsRoutes,
  getRouteShape,
  getAdherence,
  getSubway,
  getStations,
  getAlerts,
  getDossier,
  streamVehicles,
  streamSubway,
  type Vehicle,
  type ObsRoute,
  type RouteShape,
  type VehiclesResponse,
  type SubwayResponse,
  type StationInfo,
  type AlertItem,
  type DossierResponse,
} from "../lib/api";
import { subwayColor, subwayTextColor, subwayLabel } from "../lib/subwayColors";
import { BOROUGH_GROUP_ORDER } from "../lib/boroughs";
import { assignColors, DISTINCT_CAP } from "../lib/palette";
import { VehicleFlowLayer } from "../components/VehicleFlowLayer";
import MapLegend, { Swatch } from "../components/MapLegend";

const APEX = "https://nycvisualizer.com";
const AUTHOR = { name: "nickanderson.us", url: "https://nickanderson.us" };

// Site links carried in the floating top strip (within-family SPA links).
const STRIP_LINKS: { label: string; to: string }[] = [
  { label: "Transit Map", to: "/bus" },
  { label: "Observatory", to: "/observatory" },
  { label: "Ops Wall", to: "/ops" },
  { label: "Data", to: "/data" },
];

// ---- borough grouping (mirrors the immersive page; boroughs.ts is the order SoT) ----
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

// ---- subway line groups (numbered / lettered / shuttle+SIR — simple, by judgment) ----
const SUBWAY_GROUPS: { label: string; lines: string[] }[] = [
  { label: "Numbered", lines: ["1", "2", "3", "4", "5", "6", "7"] },
  { label: "Lettered", lines: ["A", "C", "E", "B", "D", "F", "M", "G", "J", "Z", "L", "N", "Q", "R", "W"] },
  { label: "Shuttle & SIR", lines: ["S", "SIR"] },
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

function fmtClock(epoch: number | null): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtAge(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// ---- theme (mirror arcanum-chrome.js setTheme; same as the immersive page) ----
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
    /* storage blocked */
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

// ---- URL state (routes= AND lines= are independent, both ordered) ----
interface InitState {
  center: [number, number] | null;
  zoom: number | null;
  routes: string[]; // bus route ids, IN ORDER (drives palette colour assignment)
  lines: string[]; // subway line keys, IN ORDER
}
function parseUrlState(): InitState {
  const out: InitState = { center: null, zoom: null, routes: [], lines: [] };
  try {
    const p = new URLSearchParams(window.location.search);
    const ll = p.get("ll");
    if (ll) {
      const [a, b] = ll.split(",").map(Number);
      if (isFinite(a) && isFinite(b)) out.center = [a, b];
    }
    const z = p.get("z");
    if (z && isFinite(Number(z))) out.zoom = Number(z);
    const rawRoutes = p.get("routes");
    if (rawRoutes) {
      const seen = new Set<string>();
      for (const tok of rawRoutes.split(",")) {
        const k = tok.trim();
        if (k && !seen.has(k)) {
          seen.add(k);
          out.routes.push(k);
        }
      }
    }
    const rawLines = p.get("lines");
    if (rawLines) {
      const seen = new Set<string>();
      for (const tok of rawLines.split(",")) {
        const k = lineKey(tok.trim());
        if (k && !seen.has(k)) {
          seen.add(k);
          out.lines.push(k);
        }
      }
    }
  } catch {
    /* non-browser env */
  }
  return out;
}

// ---- right-rail row model (unified: kind discriminates bus vs subway) ----
interface RailRow {
  kind: "bus" | "subway";
  rowKey: string; // "b:"+route  |  "s:"+line  (namespaced so a route id can't collide with a line key)
  id: string; // route_id (bus) | line key (subway)
  color: string;
  label: string;
  sub: string; // long name (bus) / line group (subway)
  live: number; // active vehicles now
  medHw: number | null; // observed median headway (min)   [bus]
  bunch: number | null; // bunching index                   [bus]
  schedHw: number | null; // scheduled headway (min)         [bus]
  adherence: number | null; // on-route % (position quality) [bus]
  alerts: number | null; // active alerts                     [subway]
  prelim: boolean;
  dossierHref: string; // full page load (main-family dossier / immersive subway)
}
type SortKey = "label" | "kind" | "live" | "medHw" | "bunch" | "schedHw" | "adherence" | "alerts";

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Mixed-selection CSV: ONE table, a `kind` column + the union of bus & subway fields.
 *  Correct content-type (text/csv;charset=utf-8) per DOWNLOAD_AND_FORMATS (no JSON). */
function downloadCsv(rows: RailRow[], asOf: number | null) {
  const stamp =
    `# NYC Visualizer - Planner Workstation selection (mixed bus routes + subway lines)\n` +
    `# generated ${new Date().toISOString()} | data as of ${fmtClock(asOf)}\n`;
  const header = [
    "kind",
    "id",
    "name",
    "group",
    "active_now",
    "observed_median_headway_min",
    "scheduled_headway_min",
    "bunching_index",
    "on_route_pct",
    "active_alerts",
    "preliminary",
  ];
  const line = (r: RailRow) =>
    [
      r.kind,
      r.label,
      r.kind === "bus" ? r.sub : "",
      r.kind === "subway" ? r.sub : "",
      r.live,
      r.medHw ?? "",
      r.schedHw ?? "",
      r.bunch ?? "",
      r.adherence ?? "",
      r.alerts ?? "",
      r.prelim,
    ];
  const body = rows.map((r) => line(r).map(csvEscape).join(",")).join("\n");
  const blob = new Blob([stamp + header.join(",") + "\n" + body + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "planner_workstation_selection.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function WorkstationPage() {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const flow = useRef<VehicleFlowLayer | null>(null);
  const stopsLayer = useRef<L.LayerGroup | null>(null); // bus stops + subway stations
  const linesLayer = useRef<L.LayerGroup | null>(null); // optional bus route lines

  const init = useRef<InitState>(parseUrlState());

  // TWO ordered selections; order within each drives its colour assignment.
  const [selRoutes, setSelRoutes] = useState<string[]>(init.current.routes);
  const [selLines, setSelLines] = useState<string[]>(init.current.lines);
  const selRoutesRef = useRef(selRoutes);
  selRoutesRef.current = selRoutes;
  const selLinesRef = useRef(selLines);
  selLinesRef.current = selLines;
  const routeSet = useMemo(() => new Set(selRoutes), [selRoutes]);
  const lineSet = useMemo(() => new Set(selLines), [selLines]);
  const totalSelected = selRoutes.length + selLines.length;

  // bus route → palette colour (order-stable); subway lines keep their official colour.
  const routeColor = useMemo(() => assignColors(selRoutes), [selRoutes]);
  const routeColorRef = useRef(routeColor);
  routeColorRef.current = routeColor;
  // engine colour callback for BUSES ONLY (setTrains uses subwayColor internally).
  const colorForBus = (routeId: string | null): string => {
    if (!routeId) return "#6b7280";
    return routeColorRef.current.get(routeId) ?? "#6b7280";
  };
  const colorForBusRef = useRef(colorForBus);
  colorForBusRef.current = colorForBus;

  // data catalogs
  const [routes, setRoutes] = useState<ObsRoute[]>([]); // bus
  const [adherence, setAdherence] = useState<Map<string, number>>(new Map()); // bus route→pct
  const stationsAll = useRef<StationInfo[] | null>(null); // subway
  const [alerts, setAlerts] = useState<AlertItem[]>([]); // subway
  const shapeCache = useRef<Map<string, RouteShape>>(new Map()); // bus route→shape

  // live snapshots
  const latestVehicles = useRef<Vehicle[]>([]);
  const latestTrains = useRef<SubwayResponse["trains"]>([]);
  const [liveBus, setLiveBus] = useState<Map<string, number>>(new Map());
  const [liveTrain, setLiveTrain] = useState<Map<string, number>>(new Map());

  // ui
  const [panelOpen, setPanelOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [showLines, setShowLines] = useState(false); // bus route-line overlay, default OFF
  const [sortKey, setSortKey] = useState<SortKey>("live");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [infoOpen, setInfoOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null); // open drawer rowKey
  const [, forceThemeTick] = useState(0);

  // per-row dossier drawer cache (bus only; reuses /api/obs/dossier headline fields)
  const dossierCache = useRef<Map<string, DossierResponse>>(new Map());
  const [dossierTick, setDossierTick] = useState(0);
  const dossierLoading = useRef<Set<string>>(new Set());

  // status
  const [asOf, setAsOf] = useState<number | null>(null); // freshest of the two feeds
  const busAsOf = useRef<number | null>(null);
  const trainAsOf = useRef<number | null>(null);
  const [source, setSource] = useState<string>("none");
  const [stale, setStale] = useState(false);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perf, setPerf] = useState<{ ms: number; fps: number } | null>(null);

  // now-ticker for the honest clock
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  const refreshAsOf = () => {
    const b = busAsOf.current;
    const t = trainAsOf.current;
    setAsOf(b == null ? t : t == null ? b : Math.max(b, t));
  };

  // ---- one-time page setup: theme, title, canonical, body-scroll lock ----
  useEffect(() => {
    applySavedTheme();
    const prevTitle = document.title;
    const prevOverflow = document.body.style.overflow;
    document.title = "Planner Workstation — NYC Visualizer";
    document.body.style.overflow = "hidden";
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = APEX + "/workstation";
    document.head.appendChild(canonical);
    return () => {
      document.title = prevTitle;
      document.body.style.overflow = prevOverflow;
      canonical.remove();
    };
  }, []);

  // ---- shareable URL state (routes= + lines= + ll/z) ----
  const writeUrl = useRef(() => {
    const m = map.current;
    const p = new URLSearchParams();
    if (m) {
      const c = m.getCenter();
      p.set("ll", `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`);
      p.set("z", String(m.getZoom()));
    }
    if (selRoutesRef.current.length) p.set("routes", selRoutesRef.current.join(","));
    if (selLinesRef.current.length) p.set("lines", selLinesRef.current.join(","));
    window.history.replaceState(null, "", window.location.pathname + (p.toString() ? "?" + p.toString() : ""));
  });
  useEffect(() => {
    writeUrl.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRoutes, selLines]);

  // ---- map init ----
  useEffect(() => {
    if (map.current || !mapRef.current) return;
    let m: L.Map;
    try {
      m = L.map(mapRef.current, {
        center: init.current.center ?? NYC_CENTER,
        zoom: init.current.zoom ?? 12,
        minZoom: 9,
        maxZoom: MAP_MAX_ZOOM,
        maxBounds: NYC_BOUNDS,
        maxBoundsViscosity: 0.6,
        zoomControl: true,
      });
    } catch (e) {
      trackMapError("init:" + (e instanceof Error ? e.message : String(e)));
      setErr("The map failed to initialize.");
      return;
    }
    m.zoomControl.setPosition("bottomleft");
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
    linesLayer.current = L.layerGroup().addTo(m);
    stopsLayer.current = L.layerGroup().addTo(m);
    const fl = new VehicleFlowLayer({ busPopup: popupHtml, trainPopup: trainPopupHtml });
    fl.addTo(m);
    fl.setVisibility(true, true); // UNIFIED: both populations render at once
    fl.setTrails(false); // planner clarity: trails off by default on the workstation
    fl.setShapeSource(new RouteShapeCache());
    flow.current = fl;
    if (new URLSearchParams(window.location.search).has("perf")) {
      const w = window as unknown as Record<string, unknown>;
      w.__nycvFlow = fl;
      w.__nycvMap = m;
    }
    m.on("moveend", () => writeUrl.current());
    map.current = m;
    requestAnimationFrame(() => m.invalidateSize());
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- catalogs (both, always) ----
  useEffect(() => {
    getObsRoutes()
      .then((d) => setRoutes(d.routes))
      .catch(() => setErr("Could not load the route list."));
    getAdherence()
      .then((d) => {
        const m = new Map<string, number>();
        for (const r of d.routes ?? []) m.set(r.route_id, r.adherence_pct);
        setAdherence(m);
      })
      .catch(() => {
        /* adherence is additive; a failure just shows "—" */
      });
    getAlerts()
      .then((d) => setAlerts(d.alerts))
      .catch(() => {
        /* alerts additive */
      });
  }, []);

  // ---- BUS render ----
  const renderBuses = (data: VehiclesResponse) => {
    busAsOf.current = data.as_of;
    refreshAsOf();
    setSource(data.source);
    setStale(data.stale);
    setErr(null);
    latestVehicles.current = data.vehicles;
    const fl = flow.current;
    if (!fl) return;
    const sel = new Set(selRoutesRef.current);
    const filtered = sel.size ? data.vehicles.filter((v) => v.route_id && sel.has(v.route_id)) : [];
    fl.setBuses(filtered, "", colorForBusRef.current);
    const counts = new Map<string, number>();
    for (const v of filtered) if (v.route_id) counts.set(v.route_id, (counts.get(v.route_id) ?? 0) + 1);
    setLiveBus(counts);
  };

  // ---- SUBWAY render ----
  const renderTrains = (data: SubwayResponse) => {
    trainAsOf.current = data.as_of;
    refreshAsOf();
    setErr(null);
    latestTrains.current = data.trains;
    const fl = flow.current;
    if (!fl) return;
    const sel = new Set(selLinesRef.current);
    const filtered = sel.size ? data.trains.filter((t) => sel.has(lineKey(t.route_id))) : [];
    fl.setTrains(filtered);
    const counts = new Map<string, number>();
    for (const t of filtered) {
      const k = lineKey(t.route_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    setLiveTrain(counts);
  };

  // ---- BUS live feed ----
  useEffect(() => {
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
  }, []);

  // ---- SUBWAY live feed ----
  useEffect(() => {
    let cancelled = false;
    const pull = () =>
      getSubway(map.current ? bboxParam(map.current) : undefined)
        .then((d) => !cancelled && renderTrains(d))
        .catch(() => !cancelled && setErr("Live subway feed unavailable."));
    pull();
    const unsub = streamSubway((d) => !cancelled && renderTrains(d), () => {});
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
  }, []);

  // ---- honest frame-time readout ----
  useEffect(() => {
    const t = setInterval(() => {
      const s = flow.current?.getStats();
      if (s) setPerf({ ms: s.emaFrameMs, fps: s.fps });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- re-filter the live layers immediately when either selection changes ----
  useEffect(() => {
    renderBuses({
      as_of: busAsOf.current,
      source: source as VehiclesResponse["source"],
      count: 0,
      stale,
      vehicles: latestVehicles.current,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRoutes]);
  useEffect(() => {
    const fl = flow.current;
    if (!fl) return;
    const sel = new Set(selLines);
    const filtered = sel.size ? latestTrains.current.filter((t) => sel.has(lineKey(t.route_id))) : [];
    fl.setTrains(filtered);
    const counts = new Map<string, number>();
    for (const t of filtered) {
      const k = lineKey(t.route_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    setLiveTrain(counts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selLines]);

  // ---- BUS geometry: colored stop dots (+ optional route lines) per selected route ----
  useEffect(() => {
    const sl = stopsLayer.current;
    const ll = linesLayer.current;
    if (!sl || !ll) return;
    let cancelled = false;
    const need = selRoutes.filter((r) => !shapeCache.current.has(r));
    Promise.all(
      need.map((r) =>
        getRouteShape(r)
          .then((s) => shapeCache.current.set(r, s))
          .catch(() => {}),
      ),
    ).then(() => {
      if (cancelled) return;
      ll.clearLayers();
      // NOTE: bus geometry owns stopsLayer sub-clearing via a keyed rebuild below; to keep
      // bus + subway station dots independent, we redraw the WHOLE stops layer from both
      // selections here and in the subway effect. Cheapest correct approach: clear + redraw
      // both populations whenever either changes (selections are small).
      redrawStops();
      if (showLines) {
        for (const r of selRoutesRef.current) {
          const s = shapeCache.current.get(r);
          if (!s) continue;
          const color = routeColorRef.current.get(r) ?? "#2563eb";
          for (const linePts of s.polylines) L.polyline(linePts, { color, weight: 2, opacity: 0.4 }).addTo(ll);
        }
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRoutes, showLines]);

  // ---- SUBWAY geometry: ensure stations loaded, then redraw both populations ----
  useEffect(() => {
    if (!stationsAll.current) {
      getStations()
        .then((sts) => {
          stationsAll.current = sts;
          redrawStops();
        })
        .catch(() => {});
    } else {
      redrawStops();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selLines]);

  // Redraw the unified stops layer: bus stop dots (palette) + subway station dots (official).
  const redrawStops = () => {
    const sl = stopsLayer.current;
    if (!sl) return;
    sl.clearLayers();
    // bus stops
    for (const r of selRoutesRef.current) {
      const s = shapeCache.current.get(r);
      if (!s) continue;
      const color = routeColorRef.current.get(r) ?? "#2563eb";
      for (const stop of s.stops) {
        L.circleMarker([stop.lat, stop.lon], {
          radius: 3,
          weight: 1,
          color,
          fillColor: color,
          fillOpacity: 0.9,
        })
          .bindPopup(`<strong>${stop.stop_name}</strong><br/>Route ${r} · stop ${stop.stop_id}`)
          .addTo(sl);
      }
    }
    // subway stations (colour by the FIRST selected line the station serves)
    const stations = stationsAll.current;
    const order = selLinesRef.current;
    if (stations && order.length) {
      for (const st of stations) {
        const match = order.find((k) => st.routes.some((r) => lineKey(r) === k));
        if (!match) continue;
        const color = subwayColor(match);
        L.circleMarker([st.lat, st.lon], {
          radius: 3,
          weight: 1.2,
          color,
          fillColor: color,
          fillOpacity: 0.9,
        })
          .bindPopup(`<strong>${st.name}</strong><br/><span style="opacity:.75">${st.routes.join(" · ")}</span>`)
          .addTo(sl);
      }
    }
  };

  // ---------------------------------------------------------------- selection ops
  const toggleRoute = (id: string) =>
    setSelRoutes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleLine = (id: string) =>
    setSelLines((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const clearAll = () => {
    setSelRoutes([]);
    setSelLines([]);
  };
  const selectRouteGroup = (ids: string[], on: boolean) =>
    setSelRoutes((prev) => {
      if (on) {
        const set = new Set(prev);
        return [...prev, ...ids.filter((i) => !set.has(i))];
      }
      const rm = new Set(ids);
      return prev.filter((x) => !rm.has(x));
    });
  const selectLineGroup = (ids: string[], on: boolean) =>
    setSelLines((prev) => {
      if (on) {
        const set = new Set(prev);
        return [...prev, ...ids.filter((i) => !set.has(i))];
      }
      const rm = new Set(ids);
      return prev.filter((x) => !rm.has(x));
    });

  // ---------------------------------------------------------------- left-panel data
  const busGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const by: Record<string, ObsRoute[]> = {};
    for (const r of routes) {
      if (q && !(r.short_name.toLowerCase().includes(q) || r.long_name.toLowerCase().includes(q))) continue;
      (by[routeGroup(r.route_id)] ??= []).push(r);
    }
    for (const g in by) by[g].sort((a, b) => a.short_name.localeCompare(b.short_name, undefined, { numeric: true }));
    return BOROUGH_GROUP_ORDER.filter((g) => by[g]?.length).map((g) => [g, by[g]] as [string, ObsRoute[]]);
  }, [routes, search]);

  // ---------------------------------------------------------------- right-rail rows (mixed)
  const rows: RailRow[] = useMemo(() => {
    const out: RailRow[] = [];
    const byId = new Map(routes.map((r) => [r.route_id, r]));
    for (const id of selRoutes) {
      const r = byId.get(id);
      const s = r?.stats ?? null;
      out.push({
        kind: "bus",
        rowKey: "b:" + id,
        id,
        color: routeColor.get(id) ?? "#2563eb",
        label: r?.short_name ?? id,
        sub: r?.long_name ?? "",
        live: liveBus.get(id) ?? 0,
        medHw: s?.median_headway_min ?? null,
        bunch: s?.bunching_index ?? null,
        schedHw: s?.sched_median_headway_min ?? null,
        adherence: adherence.get(id) ?? null,
        alerts: null,
        prelim: !!s?.preliminary,
        dossierHref: APEX + "/observatory/" + encodeURIComponent(id),
      });
    }
    for (const id of selLines) {
      const nAlerts = alerts.filter((a) => a.routes.some((r) => lineKey(r) === id)).length;
      const grp = SUBWAY_GROUPS.find((g) => g.lines.includes(id))?.label ?? "";
      out.push({
        kind: "subway",
        rowKey: "s:" + id,
        id,
        color: subwayColor(id),
        label: subwayLabel(id),
        sub: grp,
        live: liveTrain.get(id) ?? 0,
        medHw: null,
        bunch: null,
        schedHw: null,
        adherence: null,
        alerts: nAlerts,
        prelim: false,
        dossierHref: APEX + "/live/subway?line=" + encodeURIComponent(id),
      });
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (r: RailRow): number | string => {
      switch (sortKey) {
        case "label":
          return r.label;
        case "kind":
          return r.kind;
        case "live":
          return r.live;
        case "medHw":
          return r.medHw ?? -1;
        case "bunch":
          return r.bunch ?? -1;
        case "schedHw":
          return r.schedHw ?? -1;
        case "adherence":
          return r.adherence ?? -1;
        case "alerts":
          return r.alerts ?? -1;
      }
    };
    out.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === "string" || typeof vb === "string")
        return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
      return (va - vb) * dir;
    });
    return out;
  }, [selRoutes, selLines, routes, adherence, alerts, liveBus, liveTrain, routeColor, sortKey, sortDir]);

  const sortBy = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "label" || k === "kind" ? "asc" : "desc");
    }
  };
  const sortCaret = (k: SortKey) => (sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  // ---- per-row detail drawer ----
  const toggleExpand = (r: RailRow) => {
    const key = r.rowKey;
    setExpanded((cur) => (cur === key ? null : key));
    if (r.kind === "bus" && !dossierCache.current.has(r.id) && !dossierLoading.current.has(r.id)) {
      dossierLoading.current.add(r.id);
      getDossier(r.id)
        .then((d) => dossierCache.current.set(r.id, d))
        .catch(() => {})
        .finally(() => {
          dossierLoading.current.delete(r.id);
          setDossierTick((t) => t + 1);
        });
    }
  };

  const dark = currentDark();
  const asOfCls = err ? "error" : stale ? "stale" : "";
  const overCap = selRoutes.length > DISTINCT_CAP;
  const busCount = [...liveBus.values()].reduce((a, b) => a + b, 0);
  const trainCount = [...liveTrain.values()].reduce((a, b) => a + b, 0);

  return (
    <div className={"imm-root ws-root ws-unified" + (dark ? " imm-dark" : "")}>
      <div className="imm-map" ref={mapRef} />

      {/* ---- floating top strip ---- */}
      <div className="imm-strip">
        <div className="imm-strip-inner">
          <div className="imm-strip-left">
            <a className="imm-mark" href="/" aria-label="NYC Visualizer — home">
              <svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true">
                <path d="M16 3 4 27h5l2.4-5h9.2l2.4 5h5L16 3Zm-2.7 14L16 11l2.7 6h-5.4Z" fill="currentColor" />
                <circle cx="16" cy="25.5" r="1.6" fill="currentColor" />
              </svg>
              <span className="imm-mark-txt">Planner Workstation</span>
            </a>
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

      {/* ---- LEFT: unified multi-select panel (two sections; bottom-sheet at ≤390px) ---- */}
      <div className={"ws-panel" + (panelOpen ? " open" : "")}>
        <div className="ws-panel-head">
          <button
            type="button"
            className="ws-panel-toggle"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            {panelOpen ? "◀" : "▶"}
          </button>
          <span className="ws-panel-title">Routes &amp; lines</span>
          <span className="ws-count-chip">{totalSelected} selected</span>
          {totalSelected > 0 && (
            <button type="button" className="ws-clear" onClick={clearAll}>
              Clear all
            </button>
          )}
        </div>

        {panelOpen && (
          <div className="ws-panel-body">
            {overCap && (
              <div className="ws-warn">
                {selRoutes.length} bus routes selected — palette colours repeat past {DISTINCT_CAP}; the extra
                routes reuse a hue with a lightness shift.
              </div>
            )}

            {/* ===== SECTION 1: Bus routes ===== */}
            <div className="ws-section">
              <div className="ws-sec-title">
                Bus routes
                <span className="ws-sec-n">{selRoutes.length} selected</span>
              </div>
              <input
                className="ws-search"
                type="search"
                placeholder="Filter routes…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Filter routes"
              />
              <div className="ws-groups">
                {busGroups.map(([g, rs]) => {
                  const ids = rs.map((r) => r.route_id);
                  const allOn = ids.every((i) => routeSet.has(i));
                  return (
                    <div className="ws-group" key={g}>
                      <div className="ws-group-head">
                        <label className="ws-selall">
                          <input
                            type="checkbox"
                            checked={allOn}
                            onChange={(e) => selectRouteGroup(ids, e.target.checked)}
                          />
                          All {boroughLabel(g)} routes
                        </label>
                        <span className="ws-group-n">{rs.length}</span>
                      </div>
                      <div className="ws-checks">
                        {rs.map((r) => {
                          const on = routeSet.has(r.route_id);
                          const c = routeColor.get(r.route_id);
                          return (
                            <label className={"ws-check" + (on ? " on" : "")} key={r.route_id} title={r.long_name}>
                              <input type="checkbox" checked={on} onChange={() => toggleRoute(r.route_id)} />
                              <span
                                className="ws-dot"
                                style={{ background: on && c ? c : "transparent", borderColor: on && c ? c : undefined }}
                              />
                              {r.short_name}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {!busGroups.length && <div className="nyc-note ws-empty">No routes match “{search}”.</div>}
              </div>
              <label className="ws-lines-toggle">
                <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} />
                Show bus route lines <span className="ws-hint">(off = stops + buses only)</span>
              </label>
            </div>

            {/* ===== SECTION 2: Subway lines ===== */}
            <div className="ws-section">
              <div className="ws-sec-title">
                Subway lines
                <span className="ws-sec-n">{selLines.length} selected</span>
              </div>
              <div className="ws-groups">
                {SUBWAY_GROUPS.map((g) => {
                  const allOn = g.lines.every((i) => lineSet.has(i));
                  return (
                    <div className="ws-group" key={g.label}>
                      <div className="ws-group-head">
                        <label className="ws-selall">
                          <input
                            type="checkbox"
                            checked={allOn}
                            onChange={(e) => selectLineGroup(g.lines, e.target.checked)}
                          />
                          All {g.label.toLowerCase()}
                        </label>
                      </div>
                      <div className="ws-bullets">
                        {g.lines.map((k) => {
                          const on = lineSet.has(k);
                          return (
                            <button
                              key={k}
                              type="button"
                              className={"ws-bullet" + (on ? " on" : "")}
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
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ---- RIGHT: unified "easy to find data" rail ---- */}
      <div className="ws-rail">
        <div className="ws-rail-head">
          <span className="ws-rail-title">Selection data</span>
          {rows.length > 0 && (
            <button
              type="button"
              className="ws-dl"
              onClick={() => downloadCsv(rows, asOf)}
              title="Download the current mixed selection's stats (CSV)"
            >
              ↓ CSV
            </button>
          )}
        </div>
        {rows.length === 0 ? (
          <div className="ws-rail-empty nyc-note">
            Select bus routes and/or subway lines at left — they mix freely. Each selection gets a row here with
            its live count, headways &amp; bunching (buses) or alerts (lines).
          </div>
        ) : (
          <div className="ws-table-wrap">
            <table className="ws-table ws-table-unified">
              <thead>
                <tr>
                  <th className="ws-th-l" onClick={() => sortBy("label")}>
                    Route / line{sortCaret("label")}
                  </th>
                  <th onClick={() => sortBy("live")} title="Active vehicles reporting now">
                    Now{sortCaret("live")}
                  </th>
                  <th onClick={() => sortBy("medHw")} title="Observed median headway today, min (buses only)">
                    Hw{sortCaret("medHw")}
                  </th>
                  <th onClick={() => sortBy("schedHw")} title="Scheduled median headway, min (buses only)">
                    Sched{sortCaret("schedHw")}
                  </th>
                  <th onClick={() => sortBy("bunch")} title="Bunching index — share of headways ≤ ¼ scheduled (buses only)">
                    Bunch{sortCaret("bunch")}
                  </th>
                  <th onClick={() => sortBy("adherence")} title="Share of GPS pings on-route — position quality (buses only)">
                    On-rt{sortCaret("adherence")}
                  </th>
                  <th onClick={() => sortBy("alerts")} title="Active service alerts (subway lines only)">
                    Alerts{sortCaret("alerts")}
                  </th>
                  <th className="ws-th-r">Info</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const open = expanded === r.rowKey;
                  return (
                    <Fragment key={r.rowKey}>
                      <tr className={open ? "ws-row-open" : ""}>
                        <td className="ws-td-l">
                          <span className="ws-row-dot" style={{ background: r.color }} />
                          <span className={"ws-kind ws-kind-" + r.kind} title={r.kind === "bus" ? "Bus route" : "Subway line"}>
                            {r.kind === "bus" ? "B" : "Ⓢ"}
                          </span>
                          <strong>{r.label}</strong>
                          {r.prelim && <span className="ws-prelim" title="Preliminary — archive under 14-day depth">P</span>}
                        </td>
                        <td className="ws-num">{r.live}</td>
                        <td className="ws-num">{r.medHw != null ? r.medHw : "—"}</td>
                        <td className="ws-num">{r.schedHw != null ? r.schedHw : "—"}</td>
                        <td className="ws-num">{r.bunch != null ? r.bunch.toFixed(2) : "—"}</td>
                        <td className="ws-num">{r.adherence != null ? r.adherence.toFixed(1) + "%" : "—"}</td>
                        <td className="ws-num">{r.alerts != null ? r.alerts : "—"}</td>
                        <td className="ws-td-r">
                          <button
                            type="button"
                            className="ws-expand"
                            aria-expanded={open}
                            aria-label={open ? "Hide detail" : "Show detail"}
                            onClick={() => toggleExpand(r)}
                          >
                            {open ? "▾" : "▸"}
                          </button>
                          <a href={r.dossierHref}>{r.kind === "bus" ? "Dossier" : "Live"}</a>
                        </td>
                      </tr>
                      {open && (
                        <tr className="ws-drawer-row">
                          <td colSpan={8}>{renderDrawer(r)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <div className="ws-rail-caveat nyc-note">
              “On-rt” = share of GPS pings within 100 ft of the route shape — a position-quality signal (GPS noise
              floor; terminals excluded), not a schedule-adherence guarantee. Subway lines carry no observed
              headway (positions are estimated between stations); their reliability signal is active alerts.
            </div>
          </div>
        )}
      </div>

      {/* ---- live count + as-of (top-center) ---- */}
      <div className={"imm-asof ws-asof " + asOfCls} aria-live="polite">
        <span className="dot" />
        {err ? (
          err
        ) : (
          <>
            <strong>{busCount.toLocaleString()}</strong> buses · <strong>{trainCount.toLocaleString()}</strong> trains
            <span className="imm-asof-sep"> · </span>
            {selRoutes.length} routes + {selLines.length} lines
            <span className="imm-asof-sep"> · </span>
            {fmtClock(asOf)}
          </>
        )}
      </div>

      {/* ---- corner ⓘ overlay ---- */}
      <div className={"imm-info" + (infoOpen ? " open" : "")}>
        <button
          type="button"
          className="imm-info-btn"
          aria-expanded={infoOpen}
          aria-label={infoOpen ? "Close info" : "About this workstation, links & attribution"}
          onClick={() => setInfoOpen((v) => !v)}
        >
          {infoOpen ? "✕" : "ⓘ"}
        </button>
        {infoOpen && (
          <div className="imm-info-panel" role="dialog" aria-label="Workstation info, links and attribution">
            <div className="imm-info-title">Planner Workstation</div>
            <p className="imm-info-honesty">
              One monitoring board: select any mix of bus routes and subway lines and watch their live buses and
              track-worms at true scale — buses each in a distinct colourblind-safe colour, lines in their official
              MTA colour — with the numbers a planner reaches for in the right rail. Reports arrive ~31 s apart from
              the MTA feed; between them each bus is modeled from its route’s recorded behavior (glided along its
              shape) and each train is estimated along the track, never fabricated.
            </p>
            <div className="imm-info-stamp">
              Data as of {fmtClock(asOf)} · source {source}
              {stale ? " (stale)" : ""}
              {perf ? ` · ${perf.ms.toFixed(1)} ms/frame @ ${perf.fps} fps` : ""}
            </div>
            {basemap && <div className="imm-info-attr">{basemap.vintageNote} · {basemap.attribution}</div>}
            <div className="imm-info-anchors">
              <span>
                Built by Nick Anderson — <a href={AUTHOR.url}>{AUTHOR.name}</a>
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
            <p className="imm-info-realdata">Real data only.</p>
          </div>
        )}
      </div>

      {/* ---- honest clock ---- */}
      <div className={"imm-clock ws-clock " + asOfCls} title="Time since the freshest live snapshot">
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

      {/* ---- unified legend ---- */}
      <MapLegend
        className="maplegend--imm ws-legend"
        items={[
          <span>
            Each selected <strong>bus route</strong> gets a distinct colourblind-safe colour — its stops (dots, no
            connecting lines) and its live buses share it.
          </span>,
          <span>
            <Swatch color="#4e79a7" />
            <Swatch color="#f28e2b" />
            <Swatch color="#59a14f" /> two routes = two visibly distinct populations.
          </span>,
          <span>
            Selected <strong>subway lines</strong> keep their official MTA colour — stations as dots, live trains as
            track-worms — so bus + subway populations are always distinct.
          </span>,
          <span>
            Reports arrive ~31&nbsp;s apart · between them motion is <em>modeled</em> (buses glide along their
            shape; trains estimate along the track), never fabricated.
          </span>,
        ]}
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

  // ---- per-row detail drawer body (reuses existing endpoints; no new data claims) ----
  function renderDrawer(r: RailRow) {
    void dossierTick; // re-render when a dossier lands
    if (r.kind === "subway") {
      const lineAlerts = alerts.filter((a) => a.routes.some((x) => lineKey(x) === r.id));
      return (
        <div className="ws-drawer">
          <div className="ws-drawer-grid">
            <div className="ws-drawer-stat">
              <span className="ws-drawer-k">Trains active now</span>
              <span className="ws-drawer-v">{r.live}</span>
            </div>
            <div className="ws-drawer-stat">
              <span className="ws-drawer-k">Line group</span>
              <span className="ws-drawer-v">{r.sub || "—"}</span>
            </div>
            <div className="ws-drawer-stat">
              <span className="ws-drawer-k">Active alerts</span>
              <span className="ws-drawer-v">{r.alerts ?? 0}</span>
            </div>
          </div>
          {lineAlerts.length > 0 && (
            <ul className="ws-drawer-alerts">
              {lineAlerts.slice(0, 4).map((a) => (
                <li key={a.id}>{a.header}</li>
              ))}
              {lineAlerts.length > 4 && <li className="ws-drawer-more">+{lineAlerts.length - 4} more</li>}
            </ul>
          )}
          <div className="ws-drawer-foot">
            <a href={r.dossierHref}>Open the {r.label} live map →</a>
          </div>
        </div>
      );
    }
    // bus: /api/obs/dossier headline fields
    const d = dossierCache.current.get(r.id);
    if (!d) {
      return <div className="ws-drawer ws-drawer-loading nyc-note">Loading route dossier…</div>;
    }
    const rel = d.reliability_summary;
    const peak = d.route_peak_speed;
    const slow = d.slowest_segments?.[0];
    const ride = (d.ridership_by_hour ?? []).reduce(
      (best, h) => ((h.total_boardings ?? 0) > (best.total_boardings ?? 0) ? h : best),
      { hod: -1, total_boardings: 0 } as { hod: number; total_boardings: number | null },
    );
    return (
      <div className="ws-drawer">
        <div className="ws-drawer-name">{d.meta.long_name}{d.meta.sbs ? " · SBS" : ""}</div>
        <div className="ws-drawer-grid">
          <div className="ws-drawer-stat">
            <span className="ws-drawer-k">Observed median headway</span>
            <span className="ws-drawer-v">{rel?.median_headway_min != null ? rel.median_headway_min + " min" : "—"}</span>
          </div>
          <div className="ws-drawer-stat">
            <span className="ws-drawer-k">Scheduled headway</span>
            <span className="ws-drawer-v">
              {rel?.sched_median_headway_s != null ? (rel.sched_median_headway_s / 60).toFixed(1) + " min" : "—"}
            </span>
          </div>
          <div className="ws-drawer-stat">
            <span className="ws-drawer-k">Bunching index</span>
            <span className="ws-drawer-v">{rel?.bunching_index != null ? rel.bunching_index.toFixed(2) : "—"}</span>
          </div>
          <div className="ws-drawer-stat">
            <span className="ws-drawer-k">Median deviation</span>
            <span className="ws-drawer-v">
              {rel?.median_deviation_s != null ? Math.round(rel.median_deviation_s) + " s" : "—"}
            </span>
          </div>
          <div className="ws-drawer-stat">
            <span className="ws-drawer-k">Peak weighted speed</span>
            <span className="ws-drawer-v">{peak?.wt_speed_mph != null ? peak.wt_speed_mph.toFixed(1) + " mph" : "—"}</span>
          </div>
          <div className="ws-drawer-stat">
            <span className="ws-drawer-k">Busiest hour</span>
            <span className="ws-drawer-v">
              {ride.hod >= 0 && ride.total_boardings
                ? `${String(ride.hod).padStart(2, "0")}:00 · ${Math.round(ride.total_boardings).toLocaleString()}`
                : "—"}
            </span>
          </div>
          {d.sai_stats?.median_composite_sai != null && (
            <div className="ws-drawer-stat">
              <span className="ws-drawer-k">Median stop accessibility (SAI)</span>
              <span className="ws-drawer-v">{d.sai_stats.median_composite_sai.toFixed(1)}</span>
            </div>
          )}
          {d.ace?.ace_enabled && (
            <div className="ws-drawer-stat">
              <span className="ws-drawer-k">ACE violations (total)</span>
              <span className="ws-drawer-v">{d.ace.violations_total.toLocaleString()}</span>
            </div>
          )}
        </div>
        {slow && (
          <div className="ws-drawer-slow nyc-note">
            Slowest segment: {slow.from_stop} → {slow.to_stop} · {slow.wt_speed_mph.toFixed(1)} mph
          </div>
        )}
        {rel?.preliminary && (
          <div className="ws-drawer-slow nyc-note">Preliminary — archive under 14-day depth.</div>
        )}
        <div className="ws-drawer-foot">
          <a href={r.dossierHref}>Open the full {r.label} dossier →</a>
        </div>
      </div>
    );
  }
}

// ---- popups (mirror the immersive page) ----
function popupHtml(v: Vehicle): string {
  const t = v.timestamp
    ? new Date(v.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  return (
    `<div style="min-width:150px">` +
    `<strong>Route ${v.route_id ?? "?"}</strong><br/>` +
    `Vehicle <code>${v.vehicle_id}</code><br/>` +
    `Next stop: ${v.stop_id ?? "—"}<br/>` +
    `Reported: ${t}` +
    `</div>`
  );
}
function trainPopupHtml(t: import("../lib/api").SubwayTrain): string {
  const clock = t.timestamp
    ? new Date(t.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const est = t.positional_basis === "interpolated";
  const bullet = `<span style="display:inline-flex;width:16px;height:16px;border-radius:50%;background:${subwayColor(
    t.route_id,
  )};color:${subwayTextColor(t.route_id)};font:700 9px/16px system-ui;justify-content:center;vertical-align:middle">${subwayLabel(
    t.route_id,
  )}</span>`;
  return (
    `<div style="min-width:170px">` +
    `${bullet} <strong>${subwayLabel(t.route_id)} train</strong><br/>` +
    `${t.stop_name ? "Toward " + t.stop_name : ""}<br/>` +
    `Reported: ${clock}${est ? " · <em>estimated</em>" : ""}` +
    `</div>`
  );
}
