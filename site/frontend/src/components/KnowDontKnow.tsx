// KnowDontKnow (Q2.5) — the paired "certainty audit" panel.
//
// Two columns, side by side: LEFT = "What we can say" (established findings on
// complete data), RIGHT = "What we can't yet — and what would change that"
// (open questions, each naming the exact data or method that would settle it).
// 3–4 rows a side, dated. Honesty as a feature: the site tells you where its
// evidence stops. Reusable + kit-token themed (.kdk-* in index.css); the two
// columns stack on narrow viewports.

export interface KdkRow {
  /** the claim (left) or the open question (right) */
  text: string;
  /** right column only: what data/method would move this to "can say" */
  closes?: string;
}

interface Props {
  /** what this panel is scoped to, e.g. "the Bus Observatory" */
  scope: string;
  can: KdkRow[];
  cannot: KdkRow[];
  /** ISO date the audit reflects */
  dated: string;
}

export default function KnowDontKnow({ scope, can, cannot, dated }: Props) {
  return (
    <section className="kdk" aria-label={`What we know and don't yet know about ${scope}`}>
      <div className="kdk-grid">
        <div className="kdk-side kdk-can">
          <h4 className="kdk-h">
            <span className="kdk-dot kdk-dot-can" aria-hidden="true" /> What we can say
          </h4>
          <ul className="kdk-list">
            {can.map((r, i) => (
              <li key={i}>{r.text}</li>
            ))}
          </ul>
        </div>
        <div className="kdk-side kdk-cannot">
          <h4 className="kdk-h">
            <span className="kdk-dot kdk-dot-cannot" aria-hidden="true" /> What we can&rsquo;t yet — and
            what would change that
          </h4>
          <ul className="kdk-list">
            {cannot.map((r, i) => (
              <li key={i}>
                {r.text}
                {r.closes && <span className="kdk-closes"> {r.closes}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="kdk-foot">Certainty audit for {scope} · current to {dated}</div>
    </section>
  );
}
