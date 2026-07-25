// LiveHero (W1, 2026-07-24) — the landing page's live ant-farm hero.
//
// This is NOT a second engine and NOT a screenshot. It mounts the SAME
// `VehicleFlowLayer` (→ `src/flow/` FlowEngine) that /bus, /live/* and /workstation
// mount, on the SAME self-hosted Protomaps basemap, fed by the SAME
// `/api/rt/vehicles` snapshot + SSE stream, coloured by the SAME `lib/boroughs.ts`
// palette that W2 made the site-wide default. It is the existing ant farm, embedded
// in a bounded container — nothing here re-implements it.
//
// WEIGHT DISCIPLINE (the landing page must stay light):
//   * Landing.tsx `React.lazy`s this component, so Leaflet + protomaps + the flow
//     engine are a DEFERRED chunk — the landing's entry JS/CSS and first paint are
//     unchanged; the map streams in behind a sized placeholder (no layout shift).
//   * The poll is bbox-slimmed to the hero's own viewport (`bboxParam`).
//   * An IntersectionObserver REMOVES the flow layer when the hero scrolls out of
//     view. `VehicleFlowLayer.onRemove` unmounts the engine, cancelling its rAF, so
//     reading down the page costs nothing. (The engine already self-pauses on
//     `document.hidden`; this adds the scrolled-away case.)
//   * Scroll-wheel zoom is DISABLED — a full-bleed map that eats the page scroll is a
//     scroll trap on a landing page. Drag, pinch and the ± buttons still work.
//
// REDUCED MOTION: under `prefers-reduced-motion: reduce` the animated between-report
// glide is NOT started at all. The hero instead draws each bus's last REPORTED
// position as a plain Leaflet marker (same borough colours, refreshed every tick) and
// the stamp says so. That is a static fallback, not a second ant farm.

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBasemap, bboxParam, NYC_CENTER, NYC_BOUNDS, MAP_MAX_ZOOM } from "../lib/basemap";
import { trackMapError } from "../lib/beacon";
import { getVehicles, streamVehicles, type Vehicle, type VehiclesResponse } from "../lib/api";
import { VehicleFlowLayer } from "./VehicleFlowLayer";
import {
  BOROUGH_LEGEND,
  GROUP_COLORS,
  GROUP_COLOR_FALLBACK,
  routeGroup,
} from "../lib/boroughs";

function fmtClock(epoch: number | null): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function reducedMotion(): boolean {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

function popupHtml(v: Vehicle): string {
  const t = v.timestamp
    ? new Date(v.timestamp * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
  return (
    `<div style="min-width:150px">` +
    `<strong>Route ${v.route_id ?? "?"}</strong><br/>` +
    `Vehicle <code>${v.vehicle_id}</code><br/>` +
    `Reported: ${t}` +
    `</div>`
  );
}

export default function LiveHero() {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const flow = useRef<VehicleFlowLayer | null>(null);
  const staticLayer = useRef<L.LayerGroup | null>(null);
  const attached = useRef(false);
  const still = useRef(reducedMotion());

  const [asOf, setAsOf] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [count, setCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  // Full-bleed without the 100vw scrollbar bug: `100vw` INCLUDES the classic
  // scrollbar, so a bare `margin-inline: calc(50% - 50vw)` overflows the page by the
  // scrollbar width on any desktop that does not use overlay scrollbars — a real
  // horizontal-scroll defect that a headless screenshot (overlay scrollbars) would
  // never show. Measure it once and on resize; index.css `.nyc-livehero` subtracts it.
  useEffect(() => {
    const setSbw = () => {
      const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      document.documentElement.style.setProperty("--nyc-sbw", sbw + "px");
    };
    setSbw();
    window.addEventListener("resize", setSbw);
    return () => window.removeEventListener("resize", setSbw);
  }, []);

  const colorFor = (routeId: string | null): string => {
    if (!routeId) return GROUP_COLOR_FALLBACK;
    return GROUP_COLORS[routeGroup(routeId)] ?? GROUP_COLOR_FALLBACK;
  };
  const colorForRef = useRef(colorFor);
  colorForRef.current = colorFor;

  // ---- map init ----
  useEffect(() => {
    if (map.current || !mapRef.current) return;
    let m: L.Map;
    try {
      m = L.map(mapRef.current, {
        center: NYC_CENTER,
        zoom: 11,
        minZoom: 10,
        maxZoom: MAP_MAX_ZOOM,
        maxBounds: NYC_BOUNDS,
        maxBoundsViscosity: 0.7,
        zoomControl: true,
        // NEVER TRAP THE PAGE SCROLL. Two separate traps, two separate fixes:
        //   * desktop — a wheel over a full-bleed map would zoom instead of scrolling
        //     past it, so scrollWheelZoom is off (the ± buttons still zoom).
        //   * touch — worse: a one-finger drag that starts on the map pans the map, so
        //     a phone visitor whose thumb lands on a 300px-tall full-width hero cannot
        //     get down the page at all. On touch we disable dragging outright; the
        //     "Open the full map" button immediately below is the way in, and that is
        //     the better destination on a phone anyway.
        dragging: !L.Browser.mobile,
        scrollWheelZoom: false,
      });
    } catch (e) {
      trackMapError("init:" + (e instanceof Error ? e.message : String(e)), "/");
      setErr("The live map failed to start.");
      return;
    }
    m.zoomControl.setPosition("bottomright");
    addBasemap(m, {
      page: "/",
      onFallback: (_i, reason) => trackMapError("fallback:" + reason, "/"),
      onZeroTiles: (detail) => trackMapError("zero_tiles:" + detail, "/"),
    });
    if (still.current) {
      staticLayer.current = L.layerGroup().addTo(m);
    } else {
      const fl = new VehicleFlowLayer({ busPopup: popupHtml, trainPopup: () => "" });
      fl.addTo(m);
      fl.setVisibility(true, false); // buses only — the subway has its own door below
      fl.setTrails(false);
      flow.current = fl;
      attached.current = true;
      // Same opt-in perf hook the other three flow surfaces expose, so the harness can
      // read THIS hero's engine frame time (?perf) instead of inferring it from rAF.
      if (new URLSearchParams(window.location.search).has("perf")) {
        const w = window as unknown as Record<string, unknown>;
        w.__nycvFlow = fl;
        w.__nycvMap = m;
      }
    }
    map.current = m;
    requestAnimationFrame(() => m.invalidateSize());
    return () => {
      m.remove();
      map.current = null;
      flow.current = null;
      staticLayer.current = null;
      attached.current = false;
    };
  }, []);

  // ---- live feed (bbox-slimmed to the hero's own viewport) ----
  useEffect(() => {
    let cancelled = false;
    const render = (d: VehiclesResponse) => {
      if (cancelled) return;
      setAsOf(d.as_of);
      setStale(d.stale);
      setErr(null);
      setCount(d.vehicles.length);
      if (still.current) {
        const g = staticLayer.current;
        if (!g) return;
        g.clearLayers();
        for (const v of d.vehicles) {
          if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
          L.circleMarker([v.lat, v.lon], {
            radius: 3,
            weight: 0,
            fillColor: colorForRef.current(v.route_id),
            fillOpacity: 0.9,
          })
            .bindPopup(popupHtml(v))
            .addTo(g);
        }
        return;
      }
      flow.current?.setBuses(d.vehicles, "", colorForRef.current);
    };
    const pull = () =>
      getVehicles(map.current ? bboxParam(map.current) : undefined)
        .then(render)
        .catch(() => !cancelled && setErr("The live bus feed is unavailable right now."));
    pull();
    const unsub = streamVehicles(render, () => {});
    const poll = setInterval(pull, 30000);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(poll);
    };
  }, []);

  // ---- pause the animation when the hero is scrolled out of view ----
  // Removing the layer unmounts the engine (cancelAnimationFrame); re-adding
  // remounts it. Cheaper and more honest than leaving a rAF loop running under
  // content the visitor is reading. No-op in the reduced-motion path (no rAF).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || still.current || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.some((e) => e.isIntersecting);
        const m = map.current;
        const fl = flow.current;
        if (!m || !fl) return;
        if (vis && !attached.current) {
          fl.addTo(m);
          fl.setVisibility(true, false);
          attached.current = true;
        } else if (!vis && attached.current) {
          m.removeLayer(fl);
          attached.current = false;
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="nyc-livehero" ref={rootRef}>
      <div className="nyc-livehero-map" ref={mapRef} />

      <div className="nyc-livehero-caption">
        <p className="nyc-livehero-what">
          Every MTA bus in the five boroughs, moving right now — one shape per vehicle,
          coloured by the borough its route belongs to.
        </p>
        <p className={"nyc-livehero-stamp" + (stale || err ? " stale" : "")}>
          <span className="dot" aria-hidden="true" />
          {err ? (
            err
          ) : (
            <>
              <strong>{count.toLocaleString()}</strong> buses reporting · as of{" "}
              {fmtClock(asOf)}
              {stale ? " (the feed is running behind)" : ""}
              {still.current ? " · showing reported positions only (you asked for reduced motion)" : ""}
            </>
          )}
        </p>
        <p className="nyc-livehero-key" aria-label="Borough colour key">
          {BOROUGH_LEGEND.map((b) => (
            <span key={b.g} className="nyc-livehero-sw">
              <i style={{ background: b.color }} aria-hidden="true" />
              {b.short}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
