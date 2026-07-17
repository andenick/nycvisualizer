/* =============================================================================
   Arcanum Site Kit (ASK) v2.0 — adapters/ArkTriad.tsx
   <ArkTriad/> — the Research Triad for React/Vite stacks (Foodberg). Self-contained,
   dependency-free, no external/CDN calls (offline rule). Reads a passed-in `cdf`
   prop (this site's ecosystem.json entry's `cdf` block) and renders the fixed
   Data · Code · Outputs row — matching ReactChrome.tsx conventions (function
   components, --ark-* tokens inherited from the vendored arcanum.css, real <a>s).

   Usage:
       import ArkTriad from "./ArkTriad";
       import ecosystem from "./ecosystem.json";
       const cdf = ecosystem.sites.find(s => s.key === "foodberg")?.cdf;
       // directly under the site title/tagline block, above the fold:
       <ArkTriad cdf={cdf} track={{ site: "foodberg", endpoint: "/__track" }} />

   Renders nothing when `cdf` is null/undefined (graceful no-op). On click it fires
   ONE first-party beacon reusing the ark-track.js transport (sendBeacon → fetch
   keepalive fallback, DNT-respecting), adding { surface, endpoint:
   "triad:data|triad:code|triad:outputs" } — surface="download" for Data/Code
   (real downloads) and surface="web" for Outputs (navigation, not a download).
   ============================================================================= */
import React from "react";

export interface CdfData {
  href: string;
  kind?: "bundle" | "page" | "bulk";
  size?: string | null;
  formats?: string[];
  bulk?: { href: string; size?: string; label?: string };
  note?: string;
}
export interface CdfCode {
  href: string;
  kind?: "bundle" | "repo";
  langs?: string[];
  license?: string;
}
export interface CdfOutputs { href: string; label?: string }
export interface Cdf {
  provisional?: boolean;
  data: CdfData;
  code: CdfCode;
  outputs: CdfOutputs;
  site_repo?: string | null;
  citation?: string;
  llms_txt?: boolean;
  mcp?: string;
}
export interface ArkTriadProps {
  cdf?: Cdf | null;
  /** Telemetry target — same shape as window.ARK_TRACK. Omit to disable. */
  track?: { site?: string; endpoint?: string };
  /** Extra class on the <section> (e.g. "ark-triad-compact"). */
  className?: string;
}

const FORMAT_LABELS: Record<string, string> = { csv: "CSV", xlsx: "XLSX", parquet: "Parquet", zip: "ZIP" };
const LANG_LABELS: Record<string, string> = {
  python: "Python", r: "R", typescript: "TypeScript", javascript: "JavaScript",
  sql: "SQL", stata: "Stata", julia: "Julia",
};

function dataSub(d: CdfData): string {
  const parts: string[] = [];
  const fmts = (d.formats ?? []).map((x) => FORMAT_LABELS[x.toLowerCase()] ?? x).join(", ");
  if (d.size) parts.push(fmts ? `${d.size} · ${fmts}` : d.size);
  else if (fmts) parts.push(fmts);
  if (d.bulk?.size) parts.push(`bulk ${d.bulk.size} →`);
  return parts.join(" · ");
}
function codeSub(c: CdfCode): string {
  const langs = (c.langs ?? []).map((x) => LANG_LABELS[x.toLowerCase()] ?? x).join(" + ");
  const bits: string[] = [];
  if (langs) bits.push(langs);
  if (c.license) bits.push(c.license);
  return bits.join(" · ");
}

/** Fire one telemetry beacon, mirroring ark-track.js's transport. */
export function trackTriadClick(endpointTag: string, track?: { site?: string; endpoint?: string }): void {
  try {
    const dnt =
      navigator.doNotTrack === "1" ||
      (window as unknown as { doNotTrack?: string }).doNotTrack === "1" ||
      (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
    if (dnt) return;
    const site = track?.site ?? location.hostname;
    const url = track?.endpoint ?? "/__track";
    // Outputs is navigation (to the results construct), not a download → surface=web.
    // Data/Code are genuine downloads → surface=download. (surface enum: mcp|rest|web|download.)
    const surface = endpointTag === "triad:outputs" ? "web" : "download";
    const payload = JSON.stringify({
      site,
      surface,
      endpoint: endpointTag,
      path: location.pathname,
      ref: document.referrer ? new URL(document.referrer, location.href).hostname : "",
      ts: Math.floor(Date.now() / 1000),
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    } else if (window.fetch) {
      fetch(url, { method: "POST", body: payload, keepalive: true, credentials: "omit",
        headers: { "Content-Type": "application/json" } }).catch(() => {});
    }
  } catch { /* telemetry must never break a page */ }
}

const ArkTriad: React.FC<ArkTriadProps> = ({ cdf, track, className }) => {
  if (!cdf || !cdf.data?.href || !cdf.code?.href || !cdf.outputs?.href) return null;
  const cls = "ark-triad" + (className ? " " + className : "");
  return (
    <section className={cls} data-ark-triad aria-label="Get the data and the code for this research">
      <a className="ark-triad-btn ark-triad-data" data-cdf="data" href={cdf.data.href}
         aria-label="Download the data for this site" onClick={() => trackTriadClick("triad:data", track)}>
        <span className="ark-triad-icon" aria-hidden="true">&#8595;</span>
        <span className="ark-triad-text">
          <span className="ark-triad-label">Download the Data</span>
          <span className="ark-triad-sub" data-cdf-sub="data">{dataSub(cdf.data)}</span>
        </span>
      </a>
      <a className="ark-triad-btn ark-triad-code" data-cdf="code" href={cdf.code.href}
         aria-label="Download the research code for this site" onClick={() => trackTriadClick("triad:code", track)}>
        <span className="ark-triad-icon" aria-hidden="true">&#8595;</span>
        <span className="ark-triad-text">
          <span className="ark-triad-label">Download the Code</span>
          <span className="ark-triad-sub" data-cdf-sub="code">{codeSub(cdf.code)}</span>
        </span>
      </a>
      <a className="ark-triad-btn ark-triad-outputs ark-triad-secondary" data-cdf="outputs" href={cdf.outputs.href}
         aria-label="Explore the finished outputs of this site" onClick={() => trackTriadClick("triad:outputs", track)}>
        <span className="ark-triad-icon" aria-hidden="true">&#8594;</span>
        <span className="ark-triad-text">
          <span className="ark-triad-label">Explore the Outputs</span>
          <span className="ark-triad-sub" data-cdf-sub="outputs">{cdf.outputs.label ?? ""}</span>
        </span>
      </a>
    </section>
  );
};

export default ArkTriad;
