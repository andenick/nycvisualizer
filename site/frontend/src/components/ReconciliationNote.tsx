// ReconciliationNote (Q2.4) — "Our figure vs authority".
//
// A quiet, reusable trust panel for the (few) places our measurement lands next
// to an official figure. It states BOTH numbers side by side, explains WHY they
// differ (resolution / definition / method), and names exactly WHAT WOULD CLOSE
// the gap — then dates the comparison and cites the authority precisely. It never
// implies one number is "wrong": a reconciliation is a definitional bridge, not a
// correction. Two flavours read the same: a genuine disagreement (ACE) and a
// corroboration (DOT bus speeds) — `agreement` only tunes the accent word.
//
// Styling is kit-token + theme-aware (see .recon-* in index.css). No color
// carries good/bad sentiment; the divider is neutral.

export interface ReconSide {
  /** who: "Our measurement" / "MTA ACE program materials, 2024–25" */
  label: string;
  /** the headline figure, e.g. "≈ 0.0 mph" or "+5% average (up to +30%)" */
  value: string;
  /** one-line gloss under the figure (what it measures) */
  detail?: string;
  /** precise citation shown small under an authority column */
  source?: string;
}

interface Props {
  title: string;
  ours: ReconSide;
  authority: ReconSide;
  /** why the two figures differ (or agree) — one short paragraph */
  why: string;
  /** what would close (or has closed) the gap — one line */
  closes: string;
  /** ISO date the comparison was made / the authority figure is current to */
  dated: string;
  /** "disagree" (default) tunes wording to a reconciliation; "corroborate"
   *  frames it as agreement between independent measurements. */
  kind?: "disagree" | "corroborate";
}

export default function ReconciliationNote({
  title,
  ours,
  authority,
  why,
  closes,
  dated,
  kind = "disagree",
}: Props) {
  const verb = kind === "corroborate" ? "corroborates" : "vs";
  return (
    <section className="recon" aria-label={`Reconciliation: ${title}`}>
      <div className="recon-head">
        <span className="recon-kicker">
          {kind === "corroborate" ? "Independent check" : "Our figure vs the authority"}
        </span>
        <h4 className="recon-title">{title}</h4>
      </div>
      <div className="recon-cols">
        <div className="recon-col">
          <div className="recon-col-label">{ours.label}</div>
          <div className="recon-col-value">{ours.value}</div>
          {ours.detail && <div className="recon-col-detail">{ours.detail}</div>}
          {ours.source && <div className="recon-col-src">{ours.source}</div>}
        </div>
        <div className="recon-vs" aria-hidden="true">{verb}</div>
        <div className="recon-col">
          <div className="recon-col-label">{authority.label}</div>
          <div className="recon-col-value">{authority.value}</div>
          {authority.detail && <div className="recon-col-detail">{authority.detail}</div>}
          {authority.source && <div className="recon-col-src">{authority.source}</div>}
        </div>
      </div>
      <p className="recon-why">
        <strong>{kind === "corroborate" ? "Why they line up. " : "Why they differ. "}</strong>
        {why}
      </p>
      <p className="recon-closes">
        <strong>{kind === "corroborate" ? "What it confirms. " : "What would close the gap. "}</strong>
        {closes}
      </p>
      <div className="recon-foot">
        Reconciliation current to {dated}. Both figures are reported as their sources state them; neither
        is presented as a correction of the other.
      </div>
    </section>
  );
}
