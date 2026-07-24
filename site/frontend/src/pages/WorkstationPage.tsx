// Planner Workstation (W3) — the ANTFARM_V3 flagship: a multi-route / multi-line
// analytical monitoring tool for a professional transit planner.
//
//   /workstation/bus     (buses.nycvisualizer.com)  — multi-ROUTE bus planner
//   /workstation/subway  (subways.nycvisualizer.com) — multi-LINE subway planner
//
// Full-window immersive-chrome pattern (floating strip + corner ⓘ overlay + legend
// chip), REUSING the same VehicleFlowLayer "ant farm" motion model as /bus and
// /live/* — re-scoped to a filtered population per selected route/line, each in a
// distinct colourblind-safe colour. NO cross-family SPA links: any hop to the
// bus↔subway immersive family, or to a route dossier, is a full page load (plain
// <a href>) so each Leaflet family boots clean. Shareable URL state (?routes= / ?lines=).
//
// The left panel is the multi-select (borough-grouped route checkboxes / official
// line bullets); the right rail is the "easy to find data" table (active vehicles ·
// observed headway · bunching · scheduled headway · adherence / alerts · dossier link),
// sortable, with a contract-compliant CSV download of the current selection's stats.

import { useEffect, useMemo, useRef, useState } from "react";
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
  streamVehicles,
  streamSubway,
  type Vehicle,
  type ObsRoute,
  type RouteShape,
  type VehiclesResponse,
  type SubwayResponse,
  type StationInfo,
  type AlertItem,
} from "../lib/api";
import { subwayColor, subwayTextColor, subwayLabel } from "../lib/subwayColors";
import { BOROUGH_GROUP_ORDER } from "../lib/boroughs";
import { assignColors, DISTINCT_CAP } from "../lib/palette";
import { VehicleFlowLayer } from "../components/VehicleFlowLayer";
import MapLegend, { Swatch } from "../components/MapLegend";

export type WorkstationMode = "bus" | "subway";

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

// ---- URL state ----
interface InitState {
  center: [number, number] | null;
  zoom: number | null;
  ids: string[]; // routes (bus) or line keys (subway), IN ORDER (drives colour assignment)
}
function parseUrlState(mode: WorkstationMode): InitState {
  const out: InitState = { center: null, zoom: null, ids: [] };
  try {
    const p = new URLSearchParams(window.location.search);
    const ll = p.get("ll");
    if (ll) {
      const [a, b] = ll.split(",").map(Number);
      if (isFinite(a) && isFinite(b)) out.center = [a, b];
    }
    const z = p.get("z");
    if (z && isFinite(Number(z))) out.zoom = Number(z);
    const raw = p.get(mode === "bus" ? "routes" : "lines");
    if (raw) {
      const seen = new Set<string>();
      for (const tok of raw.split(",")) {
        const k = mode === "bus" ? tok.trim() : lineKey(tok.trim());
        if (k && !seen.has(k)) {
          seen.add(k);
          out.ids.push(k);
        }
      }
    }
  } catch {
    /* non-browser env */
  }
  return out;
}

// ---- right-rail row model ----
interface RailRow {
  id: string;
  color: string;
  label: string;
  sub: string; // long name / line group
  live: number; // active vehicles now
  medHw: number | null; // observed median headway (min)  [bus]
  bunch: number | null; // bunching index                  [bus]
  schedHw: number | null; // scheduled headway (min)        [bus]
  adherence: number | null; // on-route % (position quality) [bus]
  alerts: number | null; // active alerts                    [subway]
  prelim: boolean;
  dossierHref: string; // full page load (cross-family / main-family)
}
type SortKey = "label" | "live" | "medHw" | "bunch" | "schedHw" | "adherence" | "alerts";

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename: string, rows: RailRow[], mode: WorkstationMode, asOf: number | null) {
  const stamp = `# NYC Visualizer - ${mode === "bus" ? "Bus" : "Subway"} planner workstation selection\n` +
    `# generated ${new Date().toISOString()} | data as of ${fmtClock(asOf)}\n`;
  let header: string[];
  let line: (r: RailRow) => unknown[];
  if (mode === "bus") {
    header = ["route", "long_name", "active_buses_now", "observed_median_headway_min", "bunching_index",
      "scheduled_headway_min", "on_route_pct", "preliminary"];
    line = (r) => [r.label, r.sub, r.live, r.medHw ?? "", r.bunch ?? "", r.schedHw ?? "", r.adherence ?? "", r.prelim];
  } else {
    header = ["line", "group", "trains_active_now", "active_alerts", "preliminary"];
    line = (r) => [r.label, r.sub, r.live, r.alerts ?? "", r.prelim];
  }
  const body = rows.map((r) => line(r).map(csvEscape).join(",")).join("\n");
  const blob = new Blob([stamp + header.join(",") + "\n" + body + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function WorkstationPage({ mode }: { mode: WorkstationMode }) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const flow = useRef<VehicleFlowLayer | null>(null);
  const stopsLayer = useRef<L.LayerGroup | null>(null);
  const linesLayer = useRef<L.LayerGroup | null>(null);

  const init = useRef<InitState>(parseUrlState(mode));

  // selection order matters (drives distinct colours); keep as an ordered array.
  const [selected, setSelected] = useState<string[]>(init.current.ids);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // colour per selected id (bus = palette; subway = official line colour).
  const colorById = useMemo(() => {
    if (mode === "subway") {
      const m = new Map<string, string>();
      for (const k of selected) m.set(k, subwayColor(k));
      return m;
    }
    return assignColors(selected);
  }, [selected, mode]);
  const colorByIdRef = useRef(colorById);
  colorByIdRef.current = colorById;
  const colorFor = (routeId: string | null): string => {
    if (!routeId) return "#6b7280";
    const key = mode === "subway" ? lineKey(routeId) : routeId;
    return colorByIdRef.current.get(key) ?? subwayColor(routeId);
  };
  const colorForRef = useRef(colorFor);
  colorForRef.current = colorFor;

  // data catalogs
  const [routes, setRoutes] = useState<ObsRoute[]>([]); // bus
  const [adherence, setAdherence] = useState<Map<string, number>>(new Map()); // bus route→pct
  const stationsAll = useRef<StationInfo[] | null>(null); // subway
  const [alerts, setAlerts] = useState<AlertItem[]>([]); // subway
  const shapeCache = useRef<Map<string, RouteShape>>(new Map()); // bus route→shape

  // live snapshots
  const latestVehicles = useRef<Vehicle[]>([]);
  const [liveCounts, setLiveCounts] = useState<Map<string, number>>(new Map());

  // ui
  const [panelOpen, setPanelOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [showLines, setShowLines] = useState(false); // bus route-line overlay, default OFF
  const [sortKey, setSortKey] = useState<SortKey>("live");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [infoOpen, setInfoOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [, forceThemeTick] = useState(0);

  // status
  const [asOf, setAsOf] = useState<number | null>(null);
  const [source, setSource] = useState<string>("none");
  const [stale, setStale] = useState(false);
  const [count, setCount] = useState(0);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perf, setPerf] = useState<{ ms: number; fps: number } | null>(null);

  // now-ticker for the honest clock
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- one-time page setup: theme, title, canonical, body-scroll lock ----
  useEffect(() => {
    applySavedTheme();
    const prevTitle = document.title;
    const prevOverflow = document.body.style.overflow;
    document.title =
      mode === "bus"
        ? "Bus Planner Workstation — NYC Visualizer"
        : "Subway Planner Workstation — NYC Visualizer";
    document.body.style.overflow = "hidden";
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = APEX + (mode === "bus" ? "/workstation/bus" : "/workstation/subway");
    document.head.appendChild(canonical);
    return () => {
      document.title = prevTitle;
      document.body.style.overflow = prevOverflow;
      canonical.remove();
    };
  }, [mode]);

  // ---- shareable URL state ----
  const writeUrl = useRef(() => {
    const m = map.current;
    const p = new URLSearchParams();
    if (m) {
      const c = m.getCenter();
      p.set("ll", `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`);
      p.set("z", String(m.getZoom()));
    }
    const ids = selectedRef.current;
    if (ids.length) p.set(mode === "bus" ? "routes" : "lines", ids.join(","));
    window.history.replaceState(null, "", window.location.pathname + (p.toString() ? "?" + p.toString() : ""));
  });
  useEffect(() => {
    writeUrl.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

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
    fl.setVisibility(mode === "bus", mode === "subway");
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

  // ---- catalogs ----
  useEffect(() => {
    if (mode === "bus") {
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
    } else {
      getAlerts()
        .then((d) => setAlerts(d.alerts))
        .catch(() => {
          /* alerts additive */
        });
    }
  }, [mode]);

  // ---- BUS render ----
  const renderBuses = (data: VehiclesResponse) => {
    setAsOf(data.as_of);
    setSource(data.source);
    setStale(data.stale);
    setErr(null);
    latestVehicles.current = data.vehicles;
    const fl = flow.current;
    if (!fl) return;
    const sel = new Set(selectedRef.current);
    const filtered = sel.size ? data.vehicles.filter((v) => v.route_id && sel.has(v.route_id)) : [];
    fl.setBuses(filtered, "", colorForRef.current);
    const counts = new Map<string, number>();
    for (const v of filtered) if (v.route_id) counts.set(v.route_id, (counts.get(v.route_id) ?? 0) + 1);
    setLiveCounts(counts);
    setCount(filtered.length);
  };

  // ---- SUBWAY render ----
  const renderTrains = (data: SubwayResponse) => {
    setAsOf(data.as_of);
    setSource(data.source);
    setStale(data.stale);
    setErr(null);
    const fl = flow.current;
    if (!fl) return;
    const sel = new Set(selectedRef.current);
    const filtered = sel.size ? data.trains.filter((t) => sel.has(lineKey(t.route_id))) : [];
    fl.setTrains(filtered);
    const counts = new Map<string, number>();
    for (const t of filtered) {
      const k = lineKey(t.route_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    setLiveCounts(counts);
    setCount(filtered.length);
  };

  // ---- BUS live feed ----
  useEffect(() => {
    if (mode !== "bus") return;
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
  }, [mode]);

  // ---- SUBWAY live feed ----
  useEffect(() => {
    if (mode !== "subway") return;
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
  }, [mode]);

  // ---- honest frame-time readout ----
  useEffect(() => {
    const t = setInterval(() => {
      const s = flow.current?.getStats();
      if (s) setPerf({ ms: s.emaFrameMs, fps: s.fps });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- re-filter the live layer immediately when the selection changes ----
  useEffect(() => {
    if (mode === "bus") renderBuses({ as_of: asOf, source: source as VehiclesResponse["source"], count: 0, stale, vehicles: latestVehicles.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // ---- BUS geometry: colored stop dots (+ optional route lines) per selected route ----
  useEffect(() => {
    if (mode !== "bus") return;
    const sl = stopsLayer.current;
    const ll = linesLayer.current;
    if (!sl || !ll) return;
    let cancelled = false;
    const need = selected.filter((r) => !shapeCache.current.has(r));
    Promise.all(
      need.map((r) =>
        getRouteShape(r)
          .then((s) => shapeCache.current.set(r, s))
          .catch(() => {}),
      ),
    ).then(() => {
      if (cancelled) return;
      sl.clearLayers();
      ll.clearLayers();
      for (const r of selectedRef.current) {
        const s = shapeCache.current.get(r);
        if (!s) continue;
        const color = colorByIdRef.current.get(r) ?? "#2563eb";
        if (showLines) for (const line of s.polylines) L.polyline(line, { color, weight: 2, opacity: 0.4 }).addTo(ll);
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
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, showLines, mode]);

  // ---- SUBWAY geometry: line-colored station dots of the selected lines ----
  useEffect(() => {
    if (mode !== "subway") return;
    const sl = stopsLayer.current;
    if (!sl) return;
    let cancelled = false;
    const draw = (stations: StationInfo[]) => {
      if (cancelled) return;
      sl.clearLayers();
      const order = selectedRef.current;
      const sel = new Set(order);
      if (!sel.size) return;
      for (const st of stations) {
        // colour the dot by the FIRST selected line the station serves
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
    };
    if (stationsAll.current) draw(stationsAll.current);
    else
      getStations()
        .then((sts) => {
          stationsAll.current = sts;
          draw(sts);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, mode]);

  // ---------------------------------------------------------------- selection ops
  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const clearAll = () => setSelected([]);
  const selectGroup = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      if (on) {
        const set = new Set(prev);
        const add = ids.filter((i) => !set.has(i));
        return [...prev, ...add];
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

  // ---------------------------------------------------------------- right-rail rows
  const rows: RailRow[] = useMemo(() => {
    const out: RailRow[] = [];
    if (mode === "bus") {
      const byId = new Map(routes.map((r) => [r.route_id, r]));
      for (const id of selected) {
        const r = byId.get(id);
        const s = r?.stats ?? null;
        out.push({
          id,
          color: colorById.get(id) ?? "#2563eb",
          label: r?.short_name ?? id,
          sub: r?.long_name ?? "",
          live: liveCounts.get(id) ?? 0,
          medHw: s?.median_headway_min ?? null,
          bunch: s?.bunching_index ?? null,
          schedHw: s?.sched_median_headway_min ?? null,
          adherence: adherence.get(id) ?? null,
          alerts: null,
          prelim: !!s?.preliminary,
          dossierHref: APEX + "/observatory/" + encodeURIComponent(id),
        });
      }
    } else {
      for (const id of selected) {
        const nAlerts = alerts.filter((a) => a.routes.some((r) => lineKey(r) === id)).length;
        const grp = SUBWAY_GROUPS.find((g) => g.lines.includes(id))?.label ?? "";
        out.push({
          id,
          color: subwayColor(id),
          label: subwayLabel(id),
          sub: grp,
          live: liveCounts.get(id) ?? 0,
          medHw: null,
          bunch: null,
          schedHw: null,
          adherence: null,
          alerts: nAlerts,
          prelim: false,
          dossierHref: APEX + "/live/subway?line=" + encodeURIComponent(id),
        });
      }
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (r: RailRow): number | string => {
      switch (sortKey) {
        case "label":
          return r.label;
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
  }, [mode, selected, routes, adherence, alerts, liveCounts, colorById, sortKey, sortDir]);

  const sortBy = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "label" ? "asc" : "desc");
    }
  };
  const sortCaret = (k: SortKey) => (sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const dark = currentDark();
  const asOfCls = err ? "error" : stale ? "stale" : "";
  const overCap = selected.length > DISTINCT_CAP;
  const noun = mode === "bus" ? "routes" : "lines";
  const unit = mode === "bus" ? "buses" : "trains";

  return (
    <div className={"imm-root ws-root" + (dark ? " imm-dark" : "")} data-mode={mode}>
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
            {/* Bus↔Subway workstation switch = FULL page load (plain <a>): isolated
                family, each owns its own Leaflet map + live feeds. */}
            <div className="imm-modeswitch" role="group" aria-label="Workstation">
              <a className={"imm-mode" + (mode === "bus" ? " on" : "")} href="/workstation/bus">
                Bus
              </a>
              <a className={"imm-mode" + (mode === "subway" ? " on" : "")} href="/workstation/subway">
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

      {/* ---- LEFT: multi-select panel (collapsible; bottom-sheet at ≤390px) ---- */}
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
          <span className="ws-panel-title">{mode === "bus" ? "Routes" : "Lines"}</span>
          <span className="ws-count-chip">{selected.length} selected</span>
          {selected.length > 0 && (
            <button type="button" className="ws-clear" onClick={clearAll}>
              Clear all
            </button>
          )}
        </div>

        {panelOpen && (
          <div className="ws-panel-body">
            {overCap && (
              <div className="ws-warn">
                {selected.length} {noun} selected — colours repeat past {DISTINCT_CAP}; the extra {noun} reuse
                a hue with a lightness shift.
              </div>
            )}

            {mode === "bus" ? (
              <>
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
                    const allOn = ids.every((i) => selectedSet.has(i));
                    return (
                      <div className="ws-group" key={g}>
                        <div className="ws-group-head">
                          <label className="ws-selall">
                            <input
                              type="checkbox"
                              checked={allOn}
                              onChange={(e) => selectGroup(ids, e.target.checked)}
                            />
                            All {boroughLabel(g)} routes
                          </label>
                          <span className="ws-group-n">{rs.length}</span>
                        </div>
                        <div className="ws-checks">
                          {rs.map((r) => {
                            const on = selectedSet.has(r.route_id);
                            const c = colorById.get(r.route_id);
                            return (
                              <label className={"ws-check" + (on ? " on" : "")} key={r.route_id} title={r.long_name}>
                                <input type="checkbox" checked={on} onChange={() => toggle(r.route_id)} />
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
                  Show route lines <span className="ws-hint">(off = stops + buses only)</span>
                </label>
              </>
            ) : (
              <div className="ws-groups">
                {SUBWAY_GROUPS.map((g) => {
                  const allOn = g.lines.every((i) => selectedSet.has(i));
                  return (
                    <div className="ws-group" key={g.label}>
                      <div className="ws-group-head">
                        <label className="ws-selall">
                          <input
                            type="checkbox"
                            checked={allOn}
                            onChange={(e) => selectGroup(g.lines, e.target.checked)}
                          />
                          All {g.label.toLowerCase()}
                        </label>
                      </div>
                      <div className="ws-bullets">
                        {g.lines.map((k) => {
                          const on = selectedSet.has(k);
                          return (
                            <button
                              key={k}
                              type="button"
                              className={"ws-bullet" + (on ? " on" : "")}
                              style={{ background: subwayColor(k), color: subwayTextColor(k) }}
                              aria-pressed={on}
                              aria-label={`Line ${subwayLabel(k)}`}
                              onClick={() => toggle(k)}
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
            )}
          </div>
        )}
      </div>

      {/* ---- RIGHT: "easy to find data" rail ---- */}
      <div className="ws-rail">
        <div className="ws-rail-head">
          <span className="ws-rail-title">{mode === "bus" ? "Route data" : "Line data"}</span>
          {rows.length > 0 && (
            <button
              type="button"
              className="ws-dl"
              onClick={() =>
                downloadCsv(
                  mode === "bus" ? "bus_workstation_selection.csv" : "subway_workstation_selection.csv",
                  rows,
                  mode,
                  asOf,
                )
              }
              title="Download the current selection's stats (CSV)"
            >
              ↓ CSV
            </button>
          )}
        </div>
        {rows.length === 0 ? (
          <div className="ws-rail-empty nyc-note">
            Select {noun} at left to see live counts{mode === "bus" ? ", headways, bunching and adherence" : " and alerts"} here.
          </div>
        ) : (
          <div className="ws-table-wrap">
            <table className="ws-table">
              <thead>
                <tr>
                  <th className="ws-th-l" onClick={() => sortBy("label")}>
                    {mode === "bus" ? "Route" : "Line"}
                    {sortCaret("label")}
                  </th>
                  <th onClick={() => sortBy("live")} title="Active vehicles reporting now">
                    Now{sortCaret("live")}
                  </th>
                  {mode === "bus" ? (
                    <>
                      <th onClick={() => sortBy("medHw")} title="Observed median headway today (min)">
                        Hw{sortCaret("medHw")}
                      </th>
                      <th onClick={() => sortBy("schedHw")} title="Scheduled median headway (min)">
                        Sched{sortCaret("schedHw")}
                      </th>
                      <th onClick={() => sortBy("bunch")} title="Bunching index (share of headways ≤ ¼ scheduled)">
                        Bunch{sortCaret("bunch")}
                      </th>
                      <th onClick={() => sortBy("adherence")} title="Share of GPS pings on-route (position quality)">
                        On-rt{sortCaret("adherence")}
                      </th>
                    </>
                  ) : (
                    <th onClick={() => sortBy("alerts")} title="Active service alerts on this line">
                      Alerts{sortCaret("alerts")}
                    </th>
                  )}
                  <th className="ws-th-r">Info</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="ws-td-l">
                      <span className="ws-row-dot" style={{ background: r.color }} />
                      <strong>{r.label}</strong>
                      {r.prelim && <span className="ws-prelim" title="Preliminary — archive under 14-day depth">P</span>}
                    </td>
                    <td className="ws-num">{r.live}</td>
                    {mode === "bus" ? (
                      <>
                        <td className="ws-num">{r.medHw != null ? r.medHw : "—"}</td>
                        <td className="ws-num">{r.schedHw != null ? r.schedHw : "—"}</td>
                        <td className="ws-num">{r.bunch != null ? r.bunch.toFixed(2) : "—"}</td>
                        <td className="ws-num">{r.adherence != null ? r.adherence.toFixed(1) + "%" : "—"}</td>
                      </>
                    ) : (
                      <td className="ws-num">{r.alerts != null ? r.alerts : "—"}</td>
                    )}
                    <td className="ws-td-r">
                      {/* full page load — dossier is main-family (bus) / immersive family (subway) */}
                      <a href={r.dossierHref}>{mode === "bus" ? "Dossier" : "Live map"}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {mode === "bus" && (
              <div className="ws-rail-caveat nyc-note">
                “On-rt” = share of GPS pings within 100 ft of the route shape — a position-quality signal
                (GPS noise floor; terminals excluded), not a schedule-adherence guarantee.
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- live count + as-of (top-right, above the rail) ---- */}
      <div className={"imm-asof ws-asof " + asOfCls} aria-live="polite">
        <span className="dot" />
        {err ? (
          err
        ) : (
          <>
            <strong>{count.toLocaleString()}</strong> {unit} · {selected.length} {noun}
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
            <div className="imm-info-title">
              {mode === "bus" ? "Bus Planner Workstation" : "Subway Planner Workstation"}
            </div>
            <p className="imm-info-honesty">
              A monitoring tool: select any {noun} and watch their live {unit} at true scale, each in its own
              colour, with the numbers a planner reaches for in the right rail. Positions update ~30 s from the
              MTA feed; movement between reports is <em>estimated</em> (glided along each route’s shape), never
              fabricated.
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

      {/* ---- shared legend ---- */}
      <MapLegend
        className="maplegend--imm ws-legend"
        items={
          mode === "bus"
            ? [
                <span>
                  Each selected route gets a <strong>distinct colourblind-safe colour</strong> — its stops (dots,
                  no connecting lines) and its live buses share it.
                </span>,
                <span>
                  <Swatch color="#4e79a7" />
                  <Swatch color="#f28e2b" />
                  <Swatch color="#59a14f" /> two routes = two visibly distinct populations.
                </span>,
                <span>
                  Positions update ~30&nbsp;s · movement between updates is <em>estimated</em> along each route’s
                  shape.
                </span>,
              ]
            : [
                <span>
                  Selected lines keep their <strong>official MTA colour</strong> — stations as dots, live trains
                  as track-worms.
                </span>,
                <span>
                  Positions update ~30&nbsp;s · between stations a train’s position is an honest estimate (faded).
                </span>,
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
