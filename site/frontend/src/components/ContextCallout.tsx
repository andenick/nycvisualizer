// ContextCallout (Q2.6) — the KB as marginalia on live data.
//
// A quiet soft-surface sidebar card that places a VERIFIED passage from the Jane
// Knowledge Base next to a live figure: a quote or fact, then a source line
// ("Doc title, Year — Jane KB"). Content is curated in content/kb_callouts.json;
// every passage was quote-verified against its KB doc before shipping (see the
// campaign report). `verbatim` renders the text in quotes; a paraphrase drops
// the quote marks and is clearly a summary. Kit-token themed (.ctx-* in
// index.css); decorative, never load-bearing for a claim.
import callouts from "../content/kb_callouts.json";

export interface KbCallout {
  id: string;
  /** where it mounts (page-side key, matched by the host page) */
  anchor: string;
  /** the passage — a quote (verbatim) or a marked paraphrase */
  text: string;
  /** true = exact quote from the doc (rendered in quotation marks) */
  verbatim: boolean;
  /** short source label, e.g. "NYC DOT Mobility Report" */
  source: string;
  /** publication year */
  year: number;
  /** KB doc id, e.g. "DOC0326" */
  doc: string;
  /** optional one-line lead-in above the quote */
  lead?: string;
}

const ALL = callouts as KbCallout[];

/** All callouts curated for a given anchor (a page may show 1–2). */
export function calloutsFor(anchor: string): KbCallout[] {
  return ALL.filter((c) => c.anchor === anchor);
}

export default function ContextCallout({ c }: { c: KbCallout }) {
  return (
    <aside className="ctx-callout" aria-label={`Historical context from the Jane Knowledge Base: ${c.source}, ${c.year}`}>
      <div className="ctx-kicker">From the archive</div>
      {c.lead && <div className="ctx-lead">{c.lead}</div>}
      <blockquote className="ctx-quote">
        {c.verbatim ? <>&ldquo;{c.text}&rdquo;</> : c.text}
      </blockquote>
      <div className="ctx-src">
        {c.source}, {c.year} <span className="ctx-kb">— Jane KB · {c.doc}</span>
        {!c.verbatim && <span className="ctx-para"> (paraphrased)</span>}
      </div>
    </aside>
  );
}

/** Render every callout curated for an anchor (nothing if none). */
export function ContextCallouts({ anchor }: { anchor: string }) {
  const list = calloutsFor(anchor);
  if (!list.length) return null;
  return (
    <div className="ctx-stack">
      {list.map((c) => (
        <ContextCallout key={c.id} c={c} />
      ))}
    </div>
  );
}
