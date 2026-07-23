// Maps section sub-nav (Q4.1) — the three interactive maps share a group. Same
// pattern as ObsSubnav, built on the shared SectionSubnav. Shown on /bus,
// /sidewalks, /renters so a visitor can move between the maps without going up to
// the flat chrome nav. The "Maps" chrome item lands on /maps (the hub) which lists
// the three with a sentence each.
import SectionSubnav from "./SectionSubnav";

const TABS = [
  { label: "Overview", href: "/maps" },
  { label: "Transit Live", href: "/bus" },
  { label: "Sidewalks", href: "/sidewalks" },
  { label: "Renter's Map", href: "/renters" },
];

export default function MapsSubnav() {
  return <SectionSubnav tabs={TABS} ariaLabel="Maps sections" />;
}
