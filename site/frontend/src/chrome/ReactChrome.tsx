/* =============================================================================
   Arcanum Site Kit (ASK) chrome — LOCAL nycvisualizer copy, DE-FEDERATED.
   <ArcanumChrome/> — header + standalone footer for this React/Vite stack.

   ANTFARM_V3 W2.5 (de-federation, 2026-07-24)
   -------------------------------------------
   NYC Visualizer left the Heterodata ecosystem ("the websites should not be
   connected" — user 2026-07-24). This is the site's OWN vendored copy of the kit
   chrome, edited for standalone use — it does NOT feed back into the shared kit.
   - Ecosystem switcher: REMOVED (no hub link, no cross-site list).
   - Header brand: the site's own name ("NYC Visualizer"), links to "/". No
     "Heterodata" / "An Arcanum Research project" framing.
   - Footer: one quiet "Built by Nick Anderson — nickanderson.us" line + the
     data-source attributions (MTA · NYC Open Data · OSM/Protomaps). No dual anchors.
   The site stays heterodata-LEVEL in standards (still uses this kit's CSS/components);
   it just no longer advertises the ecosystem.

   No external/CDN calls (offline rule): import the vendored CSS, and either
   pass the ecosystem object as a prop or import the vendored ecosystem.json.

   Vendoring (Foodberg / Vite)
   ---------------------------
   1) Copy arcanum.css + ecosystem.json into the app's src (or public) tree.
   2) import "./arcanum.css"  (or wherever you vendored it)
   3) Wrap your app:

        import ArcanumChrome from "./ReactChrome";
        import ecosystem from "./ecosystem.json";

        <ArcanumChrome
          siteKey="foodberg"
          accent="#ea580c"
          accentSoft="#3a1e0c"
          nav={[
            { label: "Explore", href: "/explore" },
            { label: "Data",    href: "/data" },
            { label: "Code",    href: "/code" },
            { label: "Methodology", href: "/methodology" },
            { label: "About",   href: "/about" },
          ]}
          dprUrl="/methodology"
          ecosystem={ecosystem}
          activePath={location.pathname}
        >
          <YourRoutes />
        </ArcanumChrome>

   The accent is applied as inline CSS vars on the wrapper, so it themes every
   .ark-* component beneath it with no global CSS edit. Children render between
   <ArcanumHeader/> and <ArcanumFooter/> inside <main id="ark-main">.
   ============================================================================= */
import React from "react";

/* ---- types ---------------------------------------------------------------- */
export interface NavItem {
  label: string;
  href: string;
}
export interface EcoPage {
  label: string;
  path: string;
}
export interface EcoSite {
  key: string;
  title?: string;
  display?: string;
  url: string;
  accent?: string;
  group?: string;
  draft?: boolean;
  roadmap?: boolean;
  /** Externally-owned but part of the ecosystem (e.g. jjmuni). Shows a tag. */
  affiliated?: boolean;
  /** Detailed in-site sub-links rendered indented under the site in the switcher. */
  pages?: EcoPage[];
}
export interface Ecosystem {
  anchors?: {
    hub?: { name: string; url: string };
    author?: { name: string; url: string };
  };
  sites?: EcoSite[];
}
export interface ArcanumChromeProps {
  siteKey: string;
  /** Display name next to the brand (defaults to the ecosystem title for siteKey). */
  siteTitle?: string;
  /** THE per-site knob. Applied as --ark-accent on the wrapper. */
  accent?: string;
  accentSoft?: string;
  nav?: NavItem[];
  dprUrl?: string;
  dprLabel?: string;
  ecosystem?: Ecosystem;
  /** Current path for nav `.active` (e.g. location.pathname). */
  activePath?: string;
  children?: React.ReactNode;
}

// De-federated (ANTFARM_V3 W2.5): no hub anchor. Only the personal-site author
// anchor remains — this project is listed on nickanderson.us.
const AUTHOR = { name: "nickanderson.us", url: "https://nickanderson.us" };

const MarkSvg: React.FC = () => (
  <svg viewBox="0 0 32 32" width="100%" height="100%" fill="none" aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg">
    <path d="M16 3 4 27h5l2.4-5h9.2l2.4 5h5L16 3Zm-2.7 14L16 11l2.7 6h-5.4Z" fill="currentColor" />
    <circle cx="16" cy="25.5" r="1.6" fill="currentColor" />
  </svg>
);

/* ---- ecosystem switcher: REMOVED (ANTFARM_V3 W2.5 de-federation) -----------
   NYC Visualizer is a standalone product and no longer federates with the
   Heterodata ecosystem, so the site-switcher (and its hub link + cross-site
   list) is gone. The site keeps the Arcanum Site Kit chrome/standards; it just
   does not advertise the ecosystem. Nothing renders it — do not re-add.
   --------------------------------------------------------------------------- */

/* ---- header --------------------------------------------------------------- */
export const ArcanumHeader: React.FC<ArcanumChromeProps> = (props) => {
  const { siteKey, ecosystem, nav = [], activePath } = props;
  const current = ecosystem?.sites?.find((s) => s.key === siteKey);
  const siteTitle = props.siteTitle ?? current?.title ?? current?.display ?? "NYC Visualizer";
  const norm = (p: string) => p.replace(/\/$/, "");
  // De-federated (ANTFARM_V3 W2.5): NYC Visualizer is a standalone product — no
  // ecosystem switcher, no hub brand/sub. The brand is the site's own name and
  // links to its own root. Standards (the Arcanum Site Kit chrome) are unchanged.
  return (
    <header className="ark-header">
      <div className="ark-header-inner">
        <a className="ark-brand" href="/" aria-label={siteTitle + " — home"}>
          <span className="ark-mark" aria-hidden="true"><MarkSvg /></span>
          <span className="ark-brand-text">
            <span className="ark-brand-name">{siteTitle}</span>
          </span>
        </a>
        {nav.length ? (
          <nav className="ark-nav" aria-label="Site sections">
            {nav.map((n) => {
              const active = activePath != null && norm(activePath) === norm(n.href);
              return (
                <a key={n.href} className={"ark-nav-a" + (active ? " active" : "")}
                  href={n.href} aria-current={active ? "page" : undefined}>
                  {n.label}
                </a>
              );
            })}
          </nav>
        ) : null}
      </div>
    </header>
  );
};

/* ---- footer (standalone: one quiet personal-site line + data credits) -----
   De-federated (ANTFARM_V3 W2.5): no hub anchor, no "Arcanum Research" framing.
   A single "Built by Nick Anderson — nickanderson.us" line (the personal site is
   where this project is listed) plus the data-source attributions. */
export const ArcanumFooter: React.FC<Pick<ArcanumChromeProps,
  "ecosystem" | "dprUrl" | "dprLabel">> = ({ ecosystem, dprUrl, dprLabel = "Provenance" }) => {
    const author = ecosystem?.anchors?.author ?? AUTHOR;
    return (
      <footer className="ark-footer">
        <div className="ark-footer-inner">
          <span>Built by Nick Anderson &mdash; <a href={author.url}>{author.name}</a></span>
          <span className="ark-sep" aria-hidden="true">&middot;</span>
          <span className="ark-foot-sources">
            Data: MTA &middot; NYC Open Data &middot; OpenStreetMap / Protomaps
          </span>
          <span className="ark-sep" aria-hidden="true">&middot;</span>
          <span className="ark-foot-badges">
            <span className="ark-badge reproducible">Reproducible</span>
            <span className="ark-badge offline">Offline</span>
            <span className="ark-badge real-data">Real data</span>
          </span>
          {dprUrl ? (
            <>
              <span className="ark-sep" aria-hidden="true">&middot;</span>
              <a href={dprUrl}>{dprLabel}</a>
            </>
          ) : null}
        </div>
      </footer>
    );
  };

/* ---- the wrapper ---------------------------------------------------------- */
const ArcanumChrome: React.FC<ArcanumChromeProps> = (props) => {
  const { accent, accentSoft, children } = props;
  const style: React.CSSProperties = {};
  if (accent) (style as Record<string, string>)["--ark-accent"] = accent;
  if (accentSoft) (style as Record<string, string>)["--ark-accent-soft"] = accentSoft;
  return (
    <div className="ark-app" style={style}>
      <a className="ark-skip-link" href="#ark-main">Skip to content</a>
      <ArcanumHeader {...props} />
      <main id="ark-main" className="ark-main">
        <div className="ark-wrap">{children}</div>
      </main>
      <ArcanumFooter ecosystem={props.ecosystem} dprUrl={props.dprUrl} dprLabel={props.dprLabel} />
    </div>
  );
};

export default ArcanumChrome;
