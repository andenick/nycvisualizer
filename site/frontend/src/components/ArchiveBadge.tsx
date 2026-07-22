// Data-honesty stamp shared across every Observatory view (S5). Surfaces the
// archive depth, a PRELIMINARY badge until the archive reaches 14-day depth,
// and the standing gap note — so no reliability claim is ever shown as settled
// before it has enough history behind it.
import type { ObsArchive } from "../lib/api";

export default function ArchiveBadge({
  archive,
  compact = false,
}: {
  archive: ObsArchive | null | undefined;
  compact?: boolean;
}) {
  if (!archive) return null;
  const d = archive.archive_depth_days;
  const dates = archive.observed_dates ?? [];
  const span =
    dates.length > 1 ? `${dates[0]} → ${dates[dates.length - 1]}` : dates[0] ?? "—";

  return (
    <div className="obs-archive">
      <span className="obs-archive-chips">
        {archive.preliminary && (
          <span className="nyc-badge type obs-prelim" title="Fewer than 14 observed days of archive">
            Preliminary
          </span>
        )}
        <span className="obs-depth" title={`Observed dates: ${span}`}>
          {d} day{d === 1 ? "" : "s"} observed{d < 14 ? ` of 14 for full depth` : ""}
        </span>
      </span>
      {!compact && archive.gap_note && (
        <div className="obs-gapnote">{archive.gap_note}</div>
      )}
    </div>
  );
}
