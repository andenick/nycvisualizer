import BusMap from "../components/BusMap";

export default function BusPage() {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0.6rem 0" }}>Live Transit Map</h1>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Live</span>
      </div>
      <p className="nyc-note" style={{ marginTop: 0 }}>
        Every MTA bus and subway/SIR train, refreshed ~every 30 seconds from the MTA GTFS-RT feeds
        via our server-side poller. Positions are served through this site's backend &mdash; your browser
        never contacts MTA directly and never sees any API key. Buses carry GPS positions; the
        subway reports trains <em>by station</em>, so between stations a train's position is an
        honest <em>estimate</em> interpolated along the route (shown faded, and labeled
        &ldquo;estimated&rdquo; in its popup). Zoom in and tap a station for its live arrivals board. The
        clock shows the true age of each data source.
      </p>
      <BusMap />
    </div>
  );
}
