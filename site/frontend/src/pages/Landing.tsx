// Landing (W1, 2026-07-24) — MAPS FIRST.
//
// What changed and why (the information-architecture flip):
//   BEFORE: hero prose → ArkTriad (Download the Data / Code / Explore the Outputs)
//           → 9 spoke cards → badge-taxonomy explainer → a Plotly chart → "What this is".
//           No map anywhere above the fold, and the first thing a non-technical planner
//           was offered was a data bundle and a git repo.
//   AFTER:  the LIVE ANT FARM as a full-bleed hero (the real renderer, embedded — see
//           components/LiveHero.tsx), four plain-language entry buttons, THREE DOORS in
//           plain language, a two-sentence "what this is", and a small-print line to
//           data · methodology · code.
//
// The Research Triad has NOT been deleted — it MOVED to /data (one click from the
// primary nav) plus the compact triad in the action footer on every page, under the
// `tool-first` exception class added to CODE_DATA_FIRST_STANDARD.md §9 and enforced by
// `check_cdf.py --tool-first`. The OMNY payment chart moved to /observatory (where a
// bus-ridership chart belongs); the badge-taxonomy explainer moved to /methodology.
import { Suspense, lazy } from "react";
import { Link } from "react-router-dom";

// The ant farm is a DEFERRED chunk: Leaflet + protomaps + the flow engine must not sit
// in the landing's critical path. The placeholder is the same height as the map, so
// there is no layout shift when it arrives.
const LiveHero = lazy(() => import("../components/LiveHero"));

// The four entry buttons under the hero — the tools, named the way a visitor would.
const ENTRIES: { to: string; label: string; sub: string }[] = [
  { to: "/live/bus", label: "Open the full map", sub: "buses, full screen" },
  { to: "/live/subway", label: "Subway", sub: "every train on the track" },
  { to: "/workstation", label: "Planner Workstation", sub: "watch routes side by side" },
  { to: "/ops", label: "Ops Wall", sub: "the city at a glance" },
];

// The three doors — one per thing a person actually comes here to do. No jargon, no
// dataset names, no acronyms.
const DOORS: { to: string; icon: string; title: string; blurb: string }[] = [
  {
    to: "/bus",
    icon: "🚌",
    title: "Watch the city move",
    blurb:
      "See every bus and train in New York as it moves, filter to the routes you care about, and tap a station for the next arrivals. The clock always shows how old the data really is.",
  },
  {
    to: "/observatory",
    icon: "📊",
    title: "Look up a route",
    blurb:
      "Pick any of the 345 bus routes and see how it actually ran: how long the gaps between buses really were, where buses bunch up, which stretches are slowest, and how that compares with the timetable.",
  },
  {
    to: "/renters",
    icon: "🗺",
    title: "Explore a place",
    blurb:
      "Type an address — or tap the map — for a plain-language picture of a block: what you can reach by transit, how far it is to a usable bus stop, whether there are sidewalks and ramps, and how it ranks citywide. It describes places, not people.",
  },
];

export default function Landing() {
  return (
    <div>
      <section className="nyc-hero nyc-hero--map">
        <h1 className="nyc-hero-h1">Where can you go, and can you walk there?</h1>

        <Suspense
          fallback={
            <div className="nyc-livehero nyc-livehero--loading" aria-hidden="true">
              <div className="nyc-livehero-map nyc-livehero-skeleton" />
              <div className="nyc-livehero-caption">
                <p className="nyc-livehero-what">Starting the live bus map…</p>
              </div>
            </div>
          }
        >
          <LiveHero />
        </Suspense>

        <nav className="nyc-entries" aria-label="Open a map">
          {ENTRIES.map((e) => (
            <Link className="nyc-entry" to={e.to} key={e.to}>
              <span className="nyc-entry-label">{e.label}</span>
              <span className="nyc-entry-sub">{e.sub}</span>
            </Link>
          ))}
        </nav>
      </section>

      <section className="nyc-section">
        <div className="nyc-doors">
          {DOORS.map((d) => (
            <Link className="nyc-door" to={d.to} key={d.to}>
              <span className="nyc-door-icon" aria-hidden="true">
                {d.icon}
              </span>
              <h2>{d.title}</h2>
              <p>{d.blurb}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="nyc-section nyc-whatthisis">
        <h2>What this is</h2>
        <div className="ark-prose">
          <p>
            NYC Visualizer shows New York&rsquo;s buses, trains and sidewalks at the finest
            grain the public record allows &mdash; live where the city publishes live data,
            and measured street by street where it doesn&rsquo;t. It is built entirely on
            open data from the MTA, NYC Open Data, City Planning and the Census: nothing
            here is invented, and anything estimated says so on the page.
          </p>
        </div>
        <p className="nyc-smallprint">
          <Link to="/data">Data</Link>
          <span aria-hidden="true"> · </span>
          <Link to="/methodology">How it&rsquo;s measured</Link>
          <span aria-hidden="true"> · </span>
          <Link to="/code">Code</Link>
          <span aria-hidden="true"> · </span>
          <Link to="/about">About</Link>
        </p>
      </section>
    </div>
  );
}
