// Breadcrumbs (Q4.1) — the "you are here" trail on deep pages (e.g. a route
// dossier: Observatory → M15). The last crumb is the current page (no link).
// Uses real <Link>s so the trail is client-routed and shareable.
import { Link } from "react-router-dom";

export interface Crumb {
  label: string;
  to?: string; // omit for the current (last) crumb
}

export default function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="nyc-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={c.label + i}>
              {c.to && !last ? (
                <Link to={c.to}>{c.label}</Link>
              ) : (
                <span aria-current={last ? "page" : undefined}>{c.label}</span>
              )}
              {!last && <span className="crumb-sep" aria-hidden="true">›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
