// In-page sub-navigation for the Observatory section (S5 item 4). The shared
// Arcanum chrome nav is flat, so Routes / Leagues / Service Changes live here.
// Q4.1: now built on the shared SectionSubnav (same tab strip the Maps group
// uses). A route dossier (/observatory/:route) keeps "Routes" highlighted.
import SectionSubnav from "./SectionSubnav";

// 2026-07-25: "Subway" joins the strip. The subway derivation (observed station-to-
// station gaps over ~273k cells, 30 routes, 518 stations) had existed for a day with no
// reader at all, and a surface nobody can navigate to is the same defect as no surface.
// It is a tab rather than a nav item because the chrome nav is deliberately four items.
const TABS = [
  { label: "Routes", href: "/observatory", matchPrefix: "/observatory/" },
  { label: "Leagues", href: "/observatory/leagues" },
  { label: "Subway", href: "/observatory/subway" },
  { label: "Service Changes", href: "/observatory/changes" },
];

export default function ObsSubnav() {
  return <SectionSubnav tabs={TABS} ariaLabel="Observatory sections" />;
}
