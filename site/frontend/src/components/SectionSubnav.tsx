// Generic in-page section sub-nav (Q4.1). The shared Arcanum chrome nav is flat
// (no dropdowns), so grouped sections express their internal structure with a
// small tab strip directly under the page heading. Generalized from ObsSubnav so
// the "Maps" group (Transit Live / Sidewalks / Renters) and the "Observatory"
// group (Routes / Leagues / Service Changes) share one implementation + one style.
import { Link, useLocation } from "react-router-dom";

export interface SubnavTab {
  label: string;
  href: string;
  /** extra paths that should also mark this tab active (e.g. dossier detail) */
  matchPrefix?: string;
}

export default function SectionSubnav({
  tabs,
  ariaLabel,
}: {
  tabs: SubnavTab[];
  ariaLabel: string;
}) {
  const { pathname } = useLocation();
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/$/, "") : p);
  const here = norm(pathname);
  // A prefix match (e.g. Routes ← /observatory/:route) only wins when NO tab is an
  // exact match for the current path, so /observatory/leagues lights Leagues, not
  // both Leagues and Routes.
  const exactHit = tabs.some((t) => norm(t.href) === here);
  return (
    <nav className="obs-subnav section-subnav" aria-label={ariaLabel}>
      {tabs.map((t) => {
        const target = norm(t.href);
        const active =
          here === target ||
          (!exactHit && t.matchPrefix != null && here.startsWith(t.matchPrefix));
        return (
          <Link
            key={t.href}
            to={t.href}
            className={active ? "on" : ""}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
