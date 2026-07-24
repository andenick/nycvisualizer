// nycviz-flow — the Leaflet FlowHost adapter.
//
// This is the ONLY module in the engine that imports `leaflet`. It reproduces every L.*
// call the old VehicleFlowLayer made — canvas creation in a dedicated pane (z-450, above
// the station SVG), the zoom-animation transform mirror (L.Renderer._updateTransform),
// viewport queries, popup + cursor — behind the host-agnostic FlowHost interface. A future
// MapLibreFlowHost implements the same surface with zero engine changes (see FLOW_ENGINE.md).

import L from "leaflet";
import type { FlowHost, LatLng, PopupHandle, ScreenPoint } from "../types";

export class LeafletFlowHost implements FlowHost {
  private _map: L.Map;
  private _canvas!: HTMLCanvasElement;

  constructor(map: L.Map) {
    this._map = map;
  }

  getContainer(): HTMLElement {
    return this._map.getContainer();
  }

  // [VehicleFlowLayer.ts L247-270]
  mountCanvas(): HTMLCanvasElement {
    const map = this._map;
    const canvas = L.DomUtil.create("canvas", "leaflet-layer nycv-flow") as HTMLCanvasElement;
    const anim = (map as unknown as { _zoomAnimated?: boolean })._zoomAnimated;
    if (anim) L.DomUtil.addClass(canvas, "leaflet-zoom-animated");
    canvas.style.pointerEvents = "none";
    // Dedicated pane ABOVE the station SVG (z-450) so moving worms + at-station rings paint
    // OVER the station discs instead of hiding beneath them (the at-station occlusion fix).
    const paneName = "nycvFlowPane";
    let pane = map.getPane(paneName);
    if (!pane) {
      pane = map.createPane(paneName);
      pane.style.zIndex = "450";
      pane.style.pointerEvents = "none";
    }
    pane.appendChild(canvas);
    this._canvas = canvas;
    return canvas;
  }

  unmountCanvas(): void {
    L.DomUtil.remove(this._canvas);
  }

  isZoomAnimated(): boolean {
    return !!(this._map as unknown as { _zoomAnimated?: boolean })._zoomAnimated;
  }

  getZoom(): number {
    return this._map.getZoom();
  }
  getCenter(): LatLng {
    const c = this._map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }
  getSize(): ScreenPoint {
    const s = this._map.getSize();
    return { x: s.x, y: s.y };
  }
  getPixelOrigin(): ScreenPoint {
    const o = this._map.getPixelOrigin();
    return { x: o.x, y: o.y };
  }
  getMapPanePos(): ScreenPoint {
    const p = (this._map as unknown as { _getMapPanePos(): L.Point })._getMapPanePos();
    return { x: p.x, y: p.y };
  }
  // [VehicleFlowLayer.ts L613] — rounded, matching the original .round()
  containerPointToLayerPoint(x: number, y: number): ScreenPoint {
    const lp = this._map.containerPointToLayerPoint(L.point(x, y)).round();
    return { x: lp.x, y: lp.y };
  }

  setCanvasPosition(x: number, y: number): void {
    L.DomUtil.setPosition(this._canvas, L.point(x, y));
  }

  // Mirror of L.Renderer._updateTransform (Leaflet 1.9.4). [VehicleFlowLayer.ts L629-639]
  updateTransform(
    targetCenter: LatLng,
    targetZoom: number,
    curCenter: LatLng,
    curZoom: number,
    padding: number,
  ): void {
    const map = this._map as unknown as {
      getZoomScale(a: number, b: number): number;
      getSize(): L.Point;
      project(ll: L.LatLng, z: number): L.Point;
      _getNewPixelOrigin(ll: L.LatLng, z: number): L.Point;
    };
    const scale = map.getZoomScale(targetZoom, curZoom);
    const viewHalf = map.getSize().multiplyBy(0.5 + padding);
    const currentCenterPoint = map.project(L.latLng(curCenter.lat, curCenter.lng), targetZoom);
    const topLeftOffset = viewHalf
      .multiplyBy(-scale)
      .add(currentCenterPoint)
      .subtract(map._getNewPixelOrigin(L.latLng(targetCenter.lat, targetCenter.lng), targetZoom));
    L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
  }

  setCursor(cursor: string): void {
    this._map.getContainer().style.cursor = cursor;
  }

  // [VehicleFlowLayer.ts L1232]
  openPopup(lat: number, lng: number, html: string): PopupHandle {
    return L.popup({ offset: [0, -2] })
      .setLatLng(L.latLng(lat, lng))
      .setContent(html)
      .openOn(this._map);
  }
  closePopup(h: PopupHandle): void {
    this._map.closePopup(h as unknown as L.Popup);
  }
}
