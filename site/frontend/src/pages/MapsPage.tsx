// Maps hub (Q4.1) — the section landing the "Maps" chrome item points to. Groups
// the three interactive maps (Transit Live, Sidewalks, Renter's Map) with a
// sentence each, mirroring the landing spoke cards but scoped to the map trio.
// The MapsSubnav strip sits on top so the three are one click apart everywhere.
import { Link } from "react-router-dom";
import MapsSubnav from "../components/MapsSubnav";

const MAPS = [
  {
    key: "bus",
    title: "Live Transit Map",
    to: "/bus",
    blurb:
      "Every MTA bus and subway train in the five boroughs, live — filter routes, tap a station for its arrivals board, with an honest 'as of' clock on every tick.",
  },
  {
    key: "live-buses",
    title: "Bus Ant Farm — full screen",
    to: "/live/bus",
    blurb:
      "The live bus map with nothing else on screen: every vehicle gliding at true scale, the map filling the whole window, route filter and borough/route color in a floating overlay.",
  },
  {
    key: "live-subway",
    title: "Subway Ant Farm — full screen",
    to: "/live/subway",
    blurb:
      "Every train as a track-worm along the rails, full window — line filter chips with official bullets, station dots when you zoom in, estimated positions faded for honesty.",
  },
  {
    key: "ws-unified",
    title: "Planner Workstation",
    to: "/workstation",
    blurb:
      "Select any mix of bus routes and subway lines together and monitor them on one board: live buses in per-route colours and track-worms in official line bullets, stops and stations on the map, and a sortable rail of buses-now / observed vs scheduled headway / bunching / on-route position quality (buses) and trains-now / active alerts (lines) — with a per-row detail drawer and a mixed-selection CSV.",
  },
  {
    key: "sidewalks",
    title: "Sidewalk Explorer",
    to: "/sidewalks",
    blurb:
      "Sidewalk coverage for 96,553 street segments drawn on the streets themselves, neighborhood equity, ADA ramp gaps, and the Stop Accessibility Index for all 13,621 bus stops.",
  },
  {
    key: "renters",
    title: "Renter's Map",
    to: "/renters",
    blurb:
      "Search any address — or tap the map — for a plain-language, fully-sourced profile: jobs reachable by transit, how the block ranks citywide, flood exposure, and the real buildings on it. Compare two places side by side.",
  },
];

export default function MapsPage() {
  return (
    <div>
      <MapsSubnav />
      <section className="nyc-hero" style={{ paddingTop: "0.4rem" }}>
        <h1>Maps</h1>
        <p className="lede">
          Three ways to see the city at the finest measurable grain: what's moving right now, whether
          you can walk to it, and what it's like to live there. Every map is built entirely on
          authentic NYC Open Data, MTA, DCP, and Census sources.
        </p>
      </section>

      <section className="nyc-section">
        <div className="nyc-cards">
          {MAPS.map((m) => (
            <Link className="nyc-card" to={m.to} key={m.key}>
              <h3>
                {m.title}
                <span className="nyc-pill live">Live</span>
              </h3>
              <p>{m.blurb}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
