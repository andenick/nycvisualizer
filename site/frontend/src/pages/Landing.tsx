import { Link } from "react-router-dom";
import ArkTriad from "../chrome/ArkTriad";
import ecosystem from "../chrome/ecosystem.json";
import ArkPlotly from "../components/ArkPlotly";
import charts from "../content/chartdata.json";

// Spoke cards mirror SPOKE_REGISTRY.json semantics (hub-with-spokes). v1 spokes
// are the two flagship views; future NYC projects register there first.
const SPOKES = [
  {
    key: "bus",
    title: "Live Transit Map",
    to: "/bus",
    status: "live" as const,
    blurb:
      "Every MTA bus and subway train in the five boroughs, live. Filter bus routes, tap a station for its arrivals board — with an honest 'as of' clock on every tick and estimated train positions clearly marked.",
  },
  {
    key: "sidewalks",
    title: "Sidewalk Explorer",
    to: "/sidewalks",
    status: "live" as const,
    blurb:
      "Sidewalk coverage for 96,553 street segments, neighborhood equity, ADA ramp gaps, and the Stop Accessibility Index for all 13,621 bus stops — down to the segment and block.",
  },
];

export default function Landing() {
  const cdf = (ecosystem.sites as { key: string; cdf?: unknown }[]).find(
    (s) => s.key === "nycvisualizer",
  )?.cdf as Parameters<typeof ArkTriad>[0]["cdf"];

  return (
    <div>
      <section className="nyc-hero">
        <h1>Where can you go, and can you walk there?</h1>
        <p className="lede">
          NYC transit service and pedestrian infrastructure at the finest measurable grain — live.
          The home of all NYC work at Heterodata: a portfolio hub whose first spokes are a live bus
          map and a sidewalk explorer, built entirely on authentic NYC Open Data, MTA, DCP, and
          Census sources.
        </p>
        <ArkTriad cdf={cdf} track={{ site: "nycvisualizer", endpoint: "/__track" }} />
      </section>

      <section className="nyc-section">
        <h2>Explore the map</h2>
        <div className="nyc-cards">
          {SPOKES.map((s) => (
            <Link className="nyc-card" to={s.to} key={s.key}>
              <h3>
                {s.title}
                <span className={"nyc-pill " + s.status}>
                  {s.status === "live" ? "Live" : "In construction"}
                </span>
              </h3>
              <p>{s.blurb}</p>
            </Link>
          ))}
        </div>
      </section>

      <ArkPlotly
        title="OMNY has all but replaced MetroCard on NYC buses"
        subtitle="Share of bus boardings by payment method, 2020–2026 (2026 partial)"
        data={[
          {
            type: "bar", name: "OMNY", x: charts.omny.years, y: charts.omny.omny,
            marker: { color: "#2563eb" },
          },
          {
            type: "bar", name: "MetroCard", x: charts.omny.years, y: charts.omny.metrocard,
            marker: { color: "#93c5fd" },
          },
        ]}
        layout={{ barmode: "stack", yaxis: { title: { text: "boardings" } } }}
        csvRows={charts.omny.years.map((y: number, i: number) => ({
          year: y,
          omny_boardings: charts.omny.omny[i],
          metrocard_boardings: charts.omny.metrocard[i],
          omny_pct: charts.omny.omny_pct[i],
        }))}
        csvName="bus_omny_adoption.csv"
        source="Source: MTA Bus Hourly Ridership (kv7t-n8in / gxb3-akrn), retrieved 2026-07-16; analysis 01_route_demand. OMNY share: 1.1% (2020) to 98.6% (2026 to Jul 7)."
      />

      <section className="nyc-section">
        <h2>What this is</h2>
        <p>
          nycvisualizer is a hub for hyper-granular NYC visualizations. It pairs a realtime layer
          (a 31-second GTFS-RT poller archiving every bus, subway, ferry, and rail vehicle) with a
          static geodatabase of sidewalks, curbs, ramps, the street network, census population, and
          ridership. The signature question it is built to answer joins the two: for any bus stop,
          can you actually walk there — is there a sidewalk, a ramp, a shelter, and is it in good
          condition?
        </p>
        <p className="nyc-note">
          Real data only. Views that are not yet built show an honestly-labeled roadmap, never
          placeholder or synthetic data.
        </p>
      </section>
    </div>
  );
}
