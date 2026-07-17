// Methodology & findings - pre-rendered HTML (build_content.py) per
// CONTENT_RENDERING_STANDARD: no literal markdown ships or renders.
import { useState } from "react";
import methodsSai from "../content/methods_sai.html?raw";
import findingsSai from "../content/findings_sai.html?raw";
import methodsSidewalk from "../content/methods_sidewalk.html?raw";
import findingsSidewalk from "../content/findings_sidewalk.html?raw";
import methodsBus from "../content/methods_bus.html?raw";
import findingsBus from "../content/findings_bus.html?raw";

const TABS = [
  { key: "sai", label: "Stop Accessibility Index", methods: methodsSai, findings: findingsSai },
  { key: "sidewalk", label: "Sidewalk network", methods: methodsSidewalk, findings: findingsSidewalk },
  { key: "bus", label: "Bus service & ridership", methods: methodsBus, findings: findingsBus },
];

export default function MethodologyPage() {
  const [tab, setTab] = useState("sai");
  const [view, setView] = useState<"findings" | "methods">("findings");
  const cur = TABS.find((t) => t.key === tab)!;

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
      <p className="nyc-note" style={{ marginTop: 0 }}>
        Every claim below carries its caveat and a pointer to the exact output table or query.
        Key honest limits up front: bus APC ridership is <strong>route-level only</strong>; walksheds
        are <strong>Euclidean 400&nbsp;m</strong>, not network distance; sidewalk width is a
        2&times;Area/Perimeter <strong>proxy (validation r&nbsp;=&nbsp;0.47)</strong>; the 311 condition
        signal <strong>excludes the 81% noise-complaint majority class</strong>; realtime headway
        findings are preliminary (~2&nbsp;h archive at analysis time). Realtime map data honesty:
        subway positions between stations are estimates and are labeled as such.
      </p>

      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", margin: "1rem 0 0.6rem" }}>
        {TABS.map((t) => (
          <button key={t.key} style={pill(tab === t.key)} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem" }}>
        <button style={pill(view === "findings")} onClick={() => setView("findings")}>Findings</button>
        <button style={pill(view === "methods")} onClick={() => setView("methods")}>Methods</button>
      </div>

      <article
        className="ark-prose nyc-prose"
        dangerouslySetInnerHTML={{ __html: view === "findings" ? cur.findings : cur.methods }}
      />

      <section className="nyc-section">
        <h2>Realtime &amp; basemap methods</h2>
        <p>
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
