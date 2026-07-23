// Methodology & findings - pre-rendered HTML (build_content.py) per
// CONTENT_RENDERING_STANDARD: no literal markdown ships or renders.
import { useState } from "react";
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
