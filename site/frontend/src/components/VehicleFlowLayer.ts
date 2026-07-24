// VehicleFlowLayer — thin Leaflet back-compat wrapper around the nycviz-flow engine.
//
// The "ant farm" live-vehicle renderer for /bus, /live/* and the planner workstation. The
// entire engine (rAF loop, true-scale Web-Mercator geometry, shape-following dead-reckoning
// with decay-to-stop + snap-correct, subway worms, motion trails, follow/focus, the degrade
// ladder, and hit-testing) now lives host-agnostically under `src/flow/` — see
// `src/flow/FLOW_ENGINE.md`. This file is the ONLY Leaflet coupling: an `L.Layer` subclass
// that mounts the engine on a `LeafletFlowHost` and forwards the exact same public API the
// three consumers (BusMap, ImmersiveMapPage, WorkstationPage) already call. Zero behavior
// change: every constant, easing curve, threshold and honesty rule was moved VERBATIM.

import L from "leaflet";
import type { Vehicle, SubwayTrain } from "../lib/api";
import type { RouteShapeCache } from "../lib/shapeCache";
import { FlowEngine } from "../flow/core";
import { LeafletFlowHost } from "../flow/hosts/leaflet";
import type { ColorFor, FlowPopupHooks, FocusPred } from "../flow/types";

// Public types preserved at the original import path (consumers import { FlowSelection }).
export type { FlowSelection, FocusPred, FlowPopupHooks } from "../flow/types";

export class VehicleFlowLayer extends L.Layer {
  private _lmap!: L.Map;
  private _hooks: FlowPopupHooks;
  private _engine!: FlowEngine;

  constructor(hooks: FlowPopupHooks) {
    super();
    this._hooks = hooks;
  }

  // ---- Leaflet lifecycle ----
  onAdd(map: L.Map): this {
    this._lmap = map;
    this._engine = new FlowEngine(new LeafletFlowHost(map), this._hooks);
    this._engine.mount();
    return this;
  }

  onRemove(map: L.Map): this {
    this._engine.unmount();
    void map;
    return this;
  }

  getEvents(): Record<string, L.LeafletEventHandlerFn> {
    const ev: Record<string, L.LeafletEventHandlerFn> = {
      viewreset: () => this._engine.onViewReset(),
      moveend: () => this._engine.onViewReset(),
      resize: () => this._engine.onViewReset(),
      zoom: () => this._engine.onZoomThrottle(),
      zoomstart: () => this._engine.onZoomStart(),
      zoomend: () => this._engine.onZoomEnd(),
      click: ((e: L.LeafletMouseEvent) =>
        this._engine.onClick(e.containerPoint.x, e.containerPoint.y, e.latlng.lat, e.latlng.lng)) as L.LeafletEventHandlerFn,
      mousemove: ((e: L.LeafletMouseEvent) =>
        this._engine.onMouseMove(e.containerPoint.x, e.containerPoint.y)) as L.LeafletEventHandlerFn,
    };
    if ((this._lmap as unknown as { _zoomAnimated?: boolean })?._zoomAnimated) {
      ev.zoomanim = ((e: L.ZoomAnimEvent) =>
        this._engine.onAnimZoom({ lat: e.center.lat, lng: e.center.lng }, e.zoom)) as L.LeafletEventHandlerFn;
    }
    return ev;
  }

  // ---- public data API (forwarded 1:1 to the engine) ----
  setVisibility(showBuses: boolean, showSubway: boolean): void {
    this._engine.setVisibility(showBuses, showSubway);
  }
  setShapeSource(cache: RouteShapeCache): void {
    this._engine.setShapeSource(cache);
  }
  setTrails(on: boolean): void {
    this._engine.setTrails(on);
  }
  setFocus(pred: FocusPred | null): void {
    this._engine.setFocus(pred);
  }
  getDisplayLatLng(id: string): [number, number] | null {
    return this._engine.getDisplayLatLng(id);
  }
  setBuses(vehicles: Vehicle[], selected: string, colorFor: ColorFor): void {
    this._engine.setBuses(vehicles, selected, colorFor);
  }
  setTrains(trains: SubwayTrain[]): void {
    this._engine.setTrains(trains);
  }
  getStats() {
    return this._engine.getStats();
  }
}
