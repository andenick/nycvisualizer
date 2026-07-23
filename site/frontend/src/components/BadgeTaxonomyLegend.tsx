// "How to read our badges" taxonomy legend (Q4.1). A compact strip that names the
// three confidence tiers one line each, so a first-time visitor learns the
// vocabulary the ConfidenceBadge chips use across the site. Sourced from the same
// TIER_META registry as the badges themselves (single source of truth) — the dot,
// the label, and a one-line plain-language gloss per tier.
import { Link } from "react-router-dom";
import { TIER_META, type ConfidenceTier } from "../lib/confidence";

const GLOSS: Record<ConfidenceTier, string> = {
  established: "a descriptive fact on complete administrative data",
  preliminary: "a short live archive or a known gap — firms itself as data deepens",
  exploratory: "a proxy, index, or weighting choice sits between the data and the claim",
};

const ORDER: ConfidenceTier[] = ["established", "preliminary", "exploratory"];

export default function BadgeTaxonomyLegend() {
  return (
    <aside className="badge-taxonomy" aria-label="How to read our confidence badges">
      <div className="badge-taxonomy-head">How to read our badges</div>
      <ul>
        {ORDER.map((t) => {
          const m = TIER_META[t];
          return (
            <li key={t} className={"bt-" + t}>
              <span className="bt-dot" aria-hidden="true">{m.dot}</span>
              <span className="bt-label">{m.label}</span>
              <span className="bt-gloss">{GLOSS[t]}</span>
            </li>
          );
        })}
      </ul>
      <p className="badge-taxonomy-foot">
        Every headline stat carries one of these — hover or tap a badge for its data
        window, sample size, and what would upgrade it. More on the{" "}
        <Link to="/methodology">Methodology</Link> page.
      </p>
    </aside>
  );
}
