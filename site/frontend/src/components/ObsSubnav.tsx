// In-page sub-navigation for the Observatory section (S5 item 4). The shared
// Arcanum chrome nav is flat, so Routes / Leagues / Service Changes live here.
import { Link, useLocation } from "react-router-dom";

const TABS = [
  { label: "Routes", href: "/observatory" },
  { label: "Leagues", href: "/observatory/leagues" },
  { label: "Service Changes", href: "/observatory/changes" },
];

export default function ObsSubnav() {
  const { pathname } = useLocation();
  return (
    <nav className="obs-subnav" aria-label="Observatory sections">
      {TABS.map((t) => {
        const active = pathname === t.href || (t.href === "/observatory" && pathname === "/observatory/");
        return (
          <Link key={t.href} to={t.href} className={active ? "on" : ""} aria-current={active ? "page" : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
