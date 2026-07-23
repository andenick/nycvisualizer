import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBasemap, NYC_CENTER, NYC_BOUNDS, type BasemapInfo } from "../lib/basemap";
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

// Stable fallback palette for bus route "groups" (borough prefix) when a route has
// no GTFS color. Colorblind-aware, brand-neutral.
const GROUP_COLORS: Record<string, string> = {
  M: "#2563eb", // Manhattan
  B: "#16a34a", // Brooklyn
  Q: "#d97706", // Queens
  Bx: "#dc2626", // Bronx
  S: "#7c3aed", // Staten Island
  X: "#0891b2", // Express
  SIM: "#0891b2",
};

function routeGroup(routeId: string): string {
  const up = routeId.toUpperCase();
  if (up.startsWith("BX")) return "Bx"; // Bronx (must precede the B check)
  if (up.startsWith("SIM")) return "SIM"; // Staten Island express
  if (up.startsWith("X")) return "X"; // Manhattan express
  const c = up.charAt(0);
  return "MBQS".includes(c) ? c : "M";
}

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
  const vehLayer = useRef<L.LayerGroup | null>(null);
  const subLayer = useRef<L.LayerGroup | null>(null);
  const stationLayer = useRef<L.LayerGroup | null>(null);
  const shapeLayer = useRef<L.LayerGroup | null>(null);
  const markers = useRef<Map<string, L.CircleMarker>>(new Map());
  const trainMarkers = useRef<Map<string, L.Marker>>(new Map());
  const stationsLoaded = useRef(false);

  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [showBuses, setShowBuses] = useState(true);
  const [showSubway, setShowSubway] = useState(true);
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

  const colorFor = (routeId: string | null): string => {
    if (!routeId) return "#6b7280";
    const c = routeColorByShort.get(routeId);
    if (c && c.toLowerCase() !== "#ffffff") return c;
    return GROUP_COLORS[routeGroup(routeId)] ?? "#2563eb";
  };

  // ---- map init ----
  useEffect(() => {
    if (map.current || !mapRef.current) return;
    const m = L.map(mapRef.current, {
      center: NYC_CENTER,
      zoom: 11,
      minZoom: 9,
      maxZoom: 17,
      maxBounds: NYC_BOUNDS,
      maxBoundsViscosity: 0.6,
      zoomControl: true,
    });
    setBasemap(addBasemap(m));
    vehLayer.current = L.layerGroup().addTo(m);
    subLayer.current = L.layerGroup().addTo(m);
    stationLayer.current = L.layerGroup();
    shapeLayer.current = L.layerGroup().addTo(m);
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

  // ---- render one BUS snapshot ----
  const render = (data: VehiclesResponse) => {
    setAsOf(data.as_of);
    setSource(data.source);
    setStale(data.stale);
    setErr(null);
    const layer = vehLayer.current;
    if (!layer) return;
    const sel = selectedRef.current;
    const seen = new Set<string>();
    let shown = 0;
    if (showBusesRef.current) {
      for (const v of data.vehicles) {
        if (sel && v.route_id !== sel) continue;
        seen.add(v.vehicle_id);
        shown++;
        const color = colorFor(v.route_id);
        let mk = markers.current.get(v.vehicle_id);
        if (!mk) {
          mk = L.circleMarker([v.lat, v.lon], {
            radius: 5,
            weight: 1.5,
            color: "#ffffff",
            fillColor: color,
            fillOpacity: 0.92,
            className: "nyc-veh",
          });
          mk.addTo(layer);
          markers.current.set(v.vehicle_id, mk);
        } else {
          mk.setLatLng([v.lat, v.lon]);
          mk.setStyle({ fillColor: color });
        }
        mk.bindPopup(popupHtml(v));
      }
    }
    // prune vehicles no longer present / filtered out / mode off
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) {
        layer.removeLayer(mk);
        markers.current.delete(id);
      }
    }
    setCount(shown);
  };

  // ---- render one SUBWAY snapshot ----
  const renderSubway = (data: SubwayResponse) => {
    setSubAsOf(data.as_of);
    setSubStale(data.stale);
    setSubSource(data.source);
    const layer = subLayer.current;
    if (!layer) return;
    const seen = new Set<string>();
    let shown = 0;
    if (showSubwayRef.current) {
      for (const t of data.trains) {
        const key = t.feed + "|" + t.trip_id;
        seen.add(key);
        shown++;
        const est = t.positional_basis === "interpolated";
        const icon = L.divIcon({
          className: "nyc-bullet-wrap",
          html: `<div class="nyc-bullet${est ? " est" : ""}" style="background:${subwayColor(
            t.route_id,
          )};color:${subwayTextColor(t.route_id)}">${subwayLabel(t.route_id)}</div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        let mk = trainMarkers.current.get(key);
        if (!mk) {
          mk = L.marker([t.lat, t.lon], { icon, keyboard: false });
          mk.addTo(layer);
          trainMarkers.current.set(key, mk);
        } else {
          mk.setLatLng([t.lat, t.lon]);
          mk.setIcon(icon);
        }
        mk.bindPopup(trainPopupHtml(t));
      }
    }
    for (const [id, mk] of trainMarkers.current) {
      if (!seen.has(id)) {
        layer.removeLayer(mk);
        trainMarkers.current.delete(id);
      }
    }
    setSubCount(shown);
  };

  // ---- live BUS feed: SSE + poll safety net ----
  useEffect(() => {
    let cancelled = false;
    const pull = () =>
      getVehicles()
        .then((d) => !cancelled && render(d))
        .catch(() => !cancelled && setErr("Live bus feed unavailable."));
    pull();
    const unsub = streamVehicles(
      (d) => !cancelled && render(d),
      () => {},
    );
    const poll = setInterval(pull, 30000);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeColorByShort, showBuses]);

  // ---- live SUBWAY feed: SSE + poll safety net ----
  useEffect(() => {
    let cancelled = false;
    const pull = () =>
      getSubway()
        .then((d) => !cancelled && renderSubway(d))
        .catch(() => {});
    pull();
    const unsub = streamSubway(
      (d) => !cancelled && renderSubway(d),
      () => {},
    );
    const poll = setInterval(pull, 30000);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSubway]);

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
              radius: 3.5,
              weight: 1.5,
              color: "#1f2937",
              fillColor: "#ffffff",
              fillOpacity: 1,
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

  // ---- route shape overlay + re-filter on selection change ----
  useEffect(() => {
    const sl = shapeLayer.current;
    if (!sl) return;
    sl.clearLayers();
    getVehicles().then(render).catch(() => {});
    if (!selected) return;
    getRouteShape(selected)
      .then((s) => {
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
                    `<strong>${seg.wt_speed_mph} mph</strong> · ${Math.round(seg.speed_pctile * 100)}th pct on ${selected}`,
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

  const grouped = useMemo(() => {
    const by: Record<string, RouteInfo[]> = {};
    for (const r of routes) {
      const g = routeGroup(r.route_id);
      (by[g] ??= []).push(r);
    }
    const order = ["M", "B", "Q", "Bx", "S", "SIM", "X"];
    return Object.entries(by).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [routes]);

  const asOfCls = err ? "error" : stale || (showSubway && subStale) ? "stale" : "";
  const stampParts: string[] = [];
  if (showBuses)
    stampParts.push(
      `buses ${fmtClock(asOf)} (${source === "archive" ? "archive" : source}${stale ? ", stale" : ""})`,
    );
  if (showSubway)
    stampParts.push(`trains ${fmtClock(subAsOf)} (${subSource}${subStale ? ", partly stale" : ""})`);

  return (
    <div className="nyc-map-wrap">
      <div className="nyc-map" ref={mapRef} />

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
        {showBuses && (
          <div className="row">
            <label htmlFor="routeSel">Filter by bus route</label>
            <select id="routeSel" value={selected} onChange={(e) => setSelected(e.target.value)}>
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
          </div>
        )}
        <div className="muted">
          {showBuses ? `${count.toLocaleString()} bus${count === 1 ? "" : "es"}` : ""}
          {showBuses && showSubway ? " · " : ""}
          {showSubway ? `${subCount.toLocaleString()} train${subCount === 1 ? "" : "s"}` : ""}
          {selected && showBuses ? ` · route ${selected}` : ""}
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

      <div className="nyc-legend">
        {showBuses && (
          <>
            <div>
              <span className="swatch" style={{ background: "#2563eb" }} />
              Manhattan
              <span className="swatch" style={{ background: "#16a34a", marginLeft: 8 }} />
              Brooklyn
              <span className="swatch" style={{ background: "#d97706", marginLeft: 8 }} />
              Queens
            </div>
            <div>
              <span className="swatch" style={{ background: "#dc2626" }} />
              Bronx
              <span className="swatch" style={{ background: "#7c3aed", marginLeft: 8 }} />
              Staten Is.
              <span className="swatch" style={{ background: "#0891b2", marginLeft: 8 }} />
              Express
            </div>
          </>
        )}
        {showSubway && (
          <div style={{ marginTop: showBuses ? 4 : 0 }}>
            Trains: official line colors · faded&nbsp;=&nbsp;estimated position
          </div>
        )}
        {showBuses && selected && (
          <div style={{ marginTop: 4 }}>
            {selected} speed:
            <span className="swatch" style={{ background: "#c1272d", marginLeft: 6 }} /> slow
            <span className="swatch" style={{ background: "#cfcfcf", marginLeft: 6 }} /> on-pace
            <span className="swatch" style={{ background: "#1a6fb5", marginLeft: 6 }} /> fast
          </div>
        )}
        {basemap && (
          <div className="attr">
            {basemap.vintageNote} · {basemap.attribution}
          </div>
        )}
      </div>
    </div>
  );
}

function boroughLabel(g: string): string {
  return (
    { M: "Manhattan", B: "Brooklyn", Q: "Queens", Bx: "Bronx", S: "Staten Island", SIM: "SI Express", X: "Express" }[
      g
    ] ?? g
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
