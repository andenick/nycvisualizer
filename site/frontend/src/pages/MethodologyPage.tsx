// Methodology & findings - pre-rendered HTML (build_content.py) per
// CONTENT_RENDERING_STANDARD: no literal markdown ships or renders.
import { useState } from "react";
import ReconciliationNote from "../components/ReconciliationNote";
import KnowDontKnow from "../components/KnowDontKnow";
import { ContextCallouts } from "../components/ContextCallout";
import methodsSai from "../content/methods_sai.html?raw";
import findingsSai from "../content/findings_sai.html?raw";
import methodsSidewalk from "../content/methods_sidewalk.html?raw";
import findingsSidewalk from "../content/findings_sidewalk.html?raw";
import methodsBus from "../content/methods_bus.html?raw";
import findingsBus from "../content/findings_bus.html?raw";
import methodsDerive2 from "../content/methods_derive2.html?raw";
import methodsAccess from "../content/methods_access.html?raw";
import findingsAccess from "../content/findings_access.html?raw";
import methodsRenters from "../content/methods_renters.html?raw";
import methodsChanges from "../content/methods_changes.html?raw";

interface Tab {
  key: string;
  label: string;
  methods: string;
  findings?: string;
}

const TABS: Tab[] = [
  { key: "sai", label: "Stop Accessibility Index", methods: methodsSai, findings: findingsSai },
  { key: "sidewalk", label: "Sidewalk network", methods: methodsSidewalk, findings: findingsSidewalk },
  { key: "bus", label: "Bus service & ridership", methods: methodsBus, findings: findingsBus },
  { key: "derive2", label: "Observed headways (derive2)", methods: methodsDerive2 },
  { key: "access", label: "Access & isochrones", methods: methodsAccess, findings: findingsAccess },
  { key: "renters", label: "Renter's Map", methods: methodsRenters },
  { key: "changes", label: "Service changes", methods: methodsChanges },
];

export default function MethodologyPage() {
  const [tab, setTab] = useState("sai");
  const [view, setView] = useState<"findings" | "methods">("findings");
  const cur = TABS.find((t) => t.key === tab)!;
  // Some tabs (derive2, renters, changes) are methods-only — no separate findings doc.
  const hasFindings = Boolean(cur.findings);
  const effectiveView: "findings" | "methods" = hasFindings ? view : "methods";

  const pill = (active: boolean) => ({
    border: "1px solid var(--ark-border, #d4d8dd)",
    background: active ? "var(--ark-accent, #2563eb)" : "transparent",
    color: active ? "var(--ark-on-accent, #fff)" : "inherit",
    borderRadius: 999,
    padding: "0.3rem 0.9rem",
    fontSize: "0.85rem",
    fontWeight: 600,
    cursor: "pointer",
  });

  return (
    <div>
      <h1 style={{ margin: "0.6rem 0" }}>Methodology &amp; findings</h1>
      <p className="nyc-note" style={{ marginTop: 0, fontSize: "0.95rem", maxWidth: "72ch" }}>
        Every claim below carries its caveat and a pointer to the exact output table or query.
        Key honest limits up front: bus APC ridership is <strong>route-level only</strong>;{" "}
        <strong>SAI walksheds are Euclidean 400&nbsp;m</strong> (straight-line, not network distance) —
        but the job-access <strong>isochrones are real network routing</strong> (OpenTripPlanner over
        the street + transit graph), so the &ldquo;as-the-crow-flies overstates access&rdquo; caveat does{" "}
        <em>not</em> apply to them; sidewalk width is a 2&times;Area/Perimeter{" "}
        <strong>proxy (validation r&nbsp;=&nbsp;0.47)</strong>; the 311 condition signal{" "}
        <strong>excludes the 81% noise-complaint majority class</strong>. The{" "}
        <strong>Observed Bus Headways</strong> dataset and reliability leagues are{" "}
        <strong>PRELIMINARY</strong> until the archive reaches 14-day depth (archive depth is stamped
        on every reliability figure, and poller-downtime gaps are excluded, never smoothed); a detected
        arrival is a <strong>positional crossing</strong> of a stop&rsquo;s shape offset, which is
        distinct from a true door-open arrival, so bunching here is positional. Realtime map honesty:
        subway positions between stations are estimates and are labeled as such.
      </p>

      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", margin: "1rem 0 0.6rem" }}>
        {TABS.map((t) => (
          <button key={t.key} style={pill(tab === t.key)} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {hasFindings ? (
        <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem" }}>
          <button style={pill(effectiveView === "findings")} onClick={() => setView("findings")}>Findings</button>
          <button style={pill(effectiveView === "methods")} onClick={() => setView("methods")}>Methods</button>
        </div>
      ) : (
        <p className="nyc-note" style={{ marginBottom: "1rem" }}>Methods reference (no separate findings brief for this section).</p>
      )}

      <article
        className="ark-prose nyc-prose"
        dangerouslySetInnerHTML={{
          __html: effectiveView === "findings" && cur.findings ? cur.findings : cur.methods,
        }}
      />

      {/* Q2.4 reconciliation panels — bus tab: ACE (disagreement) + DOT (corroboration) */}
      {tab === "bus" && (
        <section className="nyc-section">
          <h2>Reconciling our figures with the authorities</h2>
          <ReconciliationNote
            title="Does camera enforcement speed the bus up? Our reading vs the MTA's"
            ours={{
              label: "Our measurement",
              value: "≈ 0 mph",
              detail: "median change in per-segment through-speed on ACE vs non-ACE corridors (peak, weighted) — a blunt, unmatched citywide difference",
              source: "nycvisualizer segment-speed analysis, 2026-07",
            }}
            authority={{
              label: "MTA ACE program",
              value: "+5% average",
              detail: "reported speed-up across the 39 ACE-enforced routes, with some corridors up to +30%",
              source: "MTA ACE program materials, 2024–25",
            }}
            why="These measure different things. Ours is the median difference in raw through-speed across every segment citywide — an unmatched comparison dominated by ordinary congestion and route mix, so the net difference washes out near zero. The MTA's is a targeted before-and-after on the specific corridors it enforces, where a blocked bus lane is the binding delay; on those corridors, and by that estimand, clearing the lane buys measurable speed."
            closes="A matched difference-in-differences — ACE corridors before vs after enforcement against comparable control routes — rather than a citywide segment average. The congestion-pricing and ACE-evaluation acquisitions (campaign Q3) feed that design."
            dated="2026-07 (MTA figures current to 2024–25)"
          />
          <ReconciliationNote
            kind="corroborate"
            title="Citywide bus speed: our observation lines up with NYC DOT"
            ours={{
              label: "Our Manhattan bus speed",
              value: "≈ 6.2 mph",
              detail: "median peak through-speed on Manhattan routes, from our segment-speed analysis",
              source: "nycvisualizer, 2026-07",
            }}
            authority={{
              label: "NYC DOT Mobility Report",
              value: "7.44 mph",
              detail: "average citywide bus speed, 2017",
              source: "NYC DOT Citywide Mobility Report, 2018 — Jane KB DOC0326",
            }}
            why="Manhattan is the slow end of the city, so a Manhattan-only 6.2 mph sitting just under DOT's 7.44 mph citywide average — which blends in faster outer-borough corridors — is exactly the relationship you would expect. Two independent measurements, taken years apart with different pipelines, agree in magnitude and in the Manhattan-slow gradient."
            closes="It confirms our segment-speed pipeline reproduces the official order of magnitude and the borough gradient. NYC DOT has tracked these speeds with MTA Bus Time data since 2012, so the comparison rests on a long official baseline."
            dated="2026-07 (DOT figure: 2017)"
          />
        </section>
      )}

      {/* Q2.5 + Q2.6 access section: certainty audit + the ferry-access KB callout */}
      {tab === "access" && (
        <section className="nyc-section">
          <h2>What access analysis can and can&rsquo;t say yet</h2>
          <ContextCallouts anchor="access" />
          <KnowDontKnow
            scope="job access &amp; isochrones"
            dated="2026-07-23"
            can={[
              { text: "How many jobs are reachable from any address in 45 minutes by transit at the weekday AM peak — from real OpenTripPlanner network routing over the street + transit graph, not straight-line distance." },
              { text: "The income gradient in job access: higher-income blocks reach more jobs, quantified decile by decile." },
              { text: "Where the outliers are — Staten Island's ferry-dependent access and the outer-borough middle-income gap." },
            ]}
            cannot={[
              { text: "Whether the income gradient holds off-peak or in the evening.", closes: "→ midday and evening departure windows added to the isochrone runs." },
              { text: "Access via commuter rail (LIRR / Metro-North) or to cross-border (NJ / Westchester) jobs.", closes: "→ those feeds added to the routing graph." },
              { text: "Door-to-door reliability, not just scheduled travel time.", closes: "→ our live headway archive folded into the routing cost (schedule + observed delay)." },
            ]}
          />
        </section>
      )}

      <section className="nyc-section">
        <h2>Realtime &amp; basemap methods</h2>
        <p style={{ maxWidth: "72ch" }}>
          A single supervised poller pulls MTA GTFS-RT (bus VehiclePositions/TripUpdates/Alerts with
          a server-side key at a 31-second floor; the 8 key-free NYCT subway feeds + SIR; LIRR/MNR,
          Citi Bike, NYC Ferry) and appends hourly-partitioned Parquet. The site backend serves the
          freshest snapshot per vehicle, falling back to a direct cached fetch when the archive is
          stale, and always stamps the true data age. NYCT reports trains by station: between
          stations the site interpolates along the GTFS shape by elapsed vs scheduled hop time and
          labels every such position <em>estimated</em>. The basemap is a self-hosted NYC-extent
          Protomaps/OSM vector bundle; geometry math is EPSG:2263 (ftUS), display EPSG:4326.
        </p>
      </section>
    </div>
  );
}
