// In-page sub-navigation for the Observatory section (S5 item 4). The shared
// Arcanum chrome nav is flat, so Routes / Leagues / Service Changes live here.
// Q4.1: now built on the shared SectionSubnav (same tab strip the Maps group
// uses). A route dossier (/observatory/:route) keeps "Routes" highlighted.
import SectionSubnav from "./SectionSubnav";

const TABS = [
  { label: "Routes", href: "/observatory", matchPrefix: "/observatory/" },
  { label: "Leagues", href: "/observatory/leagues" },
  { label: "Service Changes", href: "/observatory/changes" },
];

export default function ObsSubnav() {
  return <SectionSubnav tabs={TABS} ariaLabel="Observatory sections" />;
}
