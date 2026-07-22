import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import ArkTriad from "../chrome/ArkTriad";
import ecosystem from "../chrome/ecosystem.json";
import ArkPlotly from "../components/ArkPlotly";
import charts from "../content/chartdata.json";
import { getChangesFeed } from "../lib/api";

// Spoke cards mirror SPOKE_REGISTRY.json semantics (hub-with-spokes). Order and
// wording are unified across all spokes; every count here is static-true or the
// live-fetched Service-Changes total (never a placeholder). Status stays "built"
// vs "live" per the registry (all six are functionally live pre-cutover on apex paths).
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
    key: "observatory",
    title: "Bus Observatory",
    to: "/observatory",
    status: "live" as const,
    blurb:
      "Pick any of 345 bus routes for its dossier: the signature Marey diagram of every trip (observed vs the GTFS schedule, bunching made visible, a live tail), a per-stop headway strip, ridership by hour, slowest segments, ACE, and stop accessibility — plus reliability leagues, with a preliminary stamp until the archive reaches 14-day depth.",
  },
  {
    key: "ops",
    title: "Ops Wall",
    to: "/ops",
    status: "live" as const,
    blurb:
      "A control-room view of NYC transit right now: buses in service vs the schedule, the share of routes with active bunching, mean headway deviation, and live service alerts — with a bunching-hotspot map, an alert ticker, a subway line-status strip, and 3-hour sparklines. Auto-updates, dark by default, every number traceable to a live endpoint.",
  },
  {
    key: "sidewalks",
    title: "Sidewalk Explorer",
    to: "/sidewalks",
    status: "live" as const,
    blurb:
      "Sidewalk coverage for 96,553 street segments, neighborhood equity, ADA ramp gaps, and the Stop Accessibility Index for all 13,621 bus stops — down to the segment and block.",
  },
  {
    key: "renters",
    title: "Renter's Map",
    to: "/renters",
    status: "live" as const,
    blurb:
      "Search any address — or tap the map — for a plain-language, fully-sourced profile of the place: jobs reachable by transit, how the block ranks citywide for noise, pedestrian safety, rodents, trees and sidewalks, its flood exposure, and the real buildings on it. Compare two places side by side. Describes places, not people — no demographics in any score.",
  },
];

export default function Landing() {
  const cdf = (ecosystem.sites as { key: string; cdf?: unknown }[]).find(
    (s) => s.key === "nycvisualizer",
  )?.cdf as Parameters<typeof ArkTriad>[0]["cdf"];

  // Real count from the S8 service-change feed (honest; hides the card on failure).
  const [changeCount, setChangeCount] = useState<number | null>(null);
  useEffect(() => {
    getChangesFeed()
      .then((f) => setChangeCount(f.total_detected))
      .catch(() => setChangeCount(null));
  }, []);

  return (
    <div>
      <section className="nyc-hero">
        <h1>Where can you go, and can you walk there?</h1>
        <p className="lede">
          NYC transit service and pedestrian infrastructure at the finest measurable grain — live.
          The home of all NYC work at Heterodata: a portfolio hub whose spokes span a live transit
          map, a bus observatory, a control-room ops wall, a sidewalk explorer, and a renter's map —
          built entirely on authentic NYC Open Data, MTA, DCP, and Census sources.
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
          {changeCount !== null && (
            <Link className="nyc-card" to="/observatory/changes" key="changes">
              <h3>
                Service Changes
                <span className="nyc-pill live">Live</span>
              </h3>
              <p>
                {changeCount} detected schedule change{changeCount === 1 ? "" : "s"} in NYC transit
                &mdash; headway shifts, trip-count changes, and service-span edits, per route, with
                planned-vs-persisted badges and per-route RSS. A content-hashed snapshot of every
                MTA feed every 6 hours.
              </p>
            </Link>
          )}
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
