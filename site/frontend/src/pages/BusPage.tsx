import { Link } from "react-router-dom";
import BusMap from "../components/BusMap";
import MapsSubnav from "../components/MapsSubnav";

export default function BusPage() {
  return (
    <div>
      <MapsSubnav />
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0.6rem 0" }}>Live Transit Map</h1>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Live</span>
      </div>
      <p className="nyc-feedlinks" style={{ margin: "0 0 0.2rem" }}>
        <Link to="/live/bus">Buses — full-window view &rarr;</Link>
        <Link to="/live/subway">Subway — full-window view &rarr;</Link>
      </p>
      {/* W7 framing: this opened with ~95 words of plumbing (GTFS-RT, server-side
          poller, API keys, interpolation) before saying what a person can DO. Rewritten
          to the /renters template — the doing first, the honesty second, the plumbing
          in a fold. Nothing honest was dropped, only re-ordered and translated. */}
      <p className="nyc-note" style={{ marginTop: 0 }}>
        Every bus and every train in New York, on one map, updating about every 30 seconds.
        Filter to a route, zoom in and tap a station for the next arrivals. Buses report
        their own GPS position; trains only report which station they last reached, so
        between stations a train&rsquo;s position is our estimate &mdash; those are drawn
        faded and say &ldquo;estimated&rdquo; when you tap them. The clock always shows how
        old the data really is.
      </p>
      <details className="nyc-fold">
        <summary>Where the positions come from</summary>
        <p className="nyc-note" style={{ marginTop: "0.4rem" }}>
          A service we run polls the MTA&rsquo;s public realtime feeds (GTFS-RT) roughly every
          31 seconds and archives every reading. This page reads that archive, not the MTA
          directly: your browser never contacts the MTA and never sees a key. Between two
          readings a bus keeps moving at the speed it last reported, along its own route
          shape, until the reading goes stale (about 40 seconds) &mdash; after that it eases
          to a stop rather than inventing motion.
        </p>
      </details>
      <BusMap />
    </div>
  );
}
