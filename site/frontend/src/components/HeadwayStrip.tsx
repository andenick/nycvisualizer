// HeadwayStrip (S5) — per-stop observed-vs-scheduled headway dot-strip, ordered
// along the route by distance offset. Each stop shows a scheduled tick and an
// observed dot; the gap between them is the headway deviation, and the dot is
// tinted by bunching index. Click a stop → an hourly observed-vs-scheduled
// detail chart (Universal Graph Contract, via ArkPlotly).
import { useEffect, useState } from "react";
import {
  getHeadwaysSummary,
  getHeadways,
  type HeadwaySummaryResponse,
  type HeadwaySummaryStop,
  type HeadwaysResponse,
} from "../lib/api";
import ArkPlotly from "./ArkPlotly";
import ArchiveBadge from "./ArchiveBadge";

function bunchColor(bi: number | null): string {
  if (bi == null) return "#94a3b8";
  if (bi < 0.15) return "#16a34a";
  if (bi < 0.3) return "#d97706";
  return "#dc2626";
}

function StopRow({
  s,
  maxMin,
  open,
  onToggle,
}: {
  s: HeadwaySummaryStop;
  maxMin: number;
  open: boolean;
  onToggle: () => void;
}) {
  const obs = s.median_headway_min ?? 0;
  const sched = s.sched_median_headway_min ?? 0;
  const scale = (m: number) => `${Math.min(100, (m / maxMin) * 100)}%`;
  return (
    <div className="obs-hw-row">
      <button className={"obs-hw-name" + (open ? " open" : "")} onClick={onToggle} title="Show hourly detail">
        {s.stop_name || s.stop_id}
      </button>
      <div className="obs-hw-track">
        <span className="obs-hw-sched" style={{ left: scale(sched) }} title={`scheduled ${sched} min`} />
        <span
          className="obs-hw-obs"
          style={{ left: scale(obs), background: bunchColor(s.bunching_index) }}
          title={`observed ${obs} min · bunching ${s.bunching_index ?? "—"}`}
        />
      </div>
      <div className="obs-hw-nums">
        <span title="observed median headway (minutes)">{obs ? `${obs}` : "—"}</span>{" "}
        <span className="sched" title="scheduled median headway (minutes)">/ {sched ? `${sched}` : "—"} min</span>
      </div>
    </div>
  );
}

function StopDetail({ route, stop }: { route: string; stop: HeadwaySummaryStop }) {
  const [data, setData] = useState<HeadwaysResponse | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    setData(null);
    setErr(false);
    getHeadways(route, stop.stop_id)
      .then(setData)
      .catch(() => setErr(true));
  }, [route, stop.stop_id]);

  if (err) return <div className="nyc-note">Hourly detail unavailable for this stop.</div>;
  if (!data) return <div className="nyc-note">Loading hourly detail…</div>;
  if (!data.series.length) return <div className="nyc-note">No hourly observations at this stop yet.</div>;

  // aggregate by local_hour across observed dates (median-ish via mean of medians)
  const byHour = new Map<number, { obs: number[]; sch: number[] }>();
  for (const p of data.series) {
    const g = byHour.get(p.local_hour) ?? { obs: [], sch: [] };
    if (p.median_headway_s != null) g.obs.push(p.median_headway_s / 60);
    if (p.sched_median_headway_s != null) g.sch.push(p.sched_median_headway_s / 60);
    byHour.set(p.local_hour, g);
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const obsY = hours.map((h) => {
    const v = mean(byHour.get(h)!.obs);
    return v == null ? null : Math.round(v * 10) / 10;
  });
  const schY = hours.map((h) => {
    const v = mean(byHour.get(h)!.sch);
    return v == null ? null : Math.round(v * 10) / 10;
  });

  return (
    <ArkPlotly
      title={`${stop.stop_name || stop.stop_id} — headway by hour`}
      subtitle="Observed vs scheduled median headway (minutes), by local hour, across observed days"
      data={[
        { type: "scatter", mode: "lines+markers", name: "Observed", x: hours, y: obsY, line: { color: "#2563eb" } },
        { type: "scatter", mode: "lines+markers", name: "Scheduled", x: hours, y: schY, line: { color: "#94a3b8", dash: "dot" } },
      ]}
      layout={{ xaxis: { title: { text: "local hour" }, dtick: 3 }, yaxis: { title: { text: "minutes" } } }}
      height={300}
      csvRows={hours.map((h, i) => ({
        local_hour: h,
        observed_headway_min: obsY[i],
        scheduled_headway_min: schY[i],
      }))}
      csvName={`headways_${route}_${stop.stop_id}.csv`}
      source={`Source: Observed headways derived from the 31s GTFS-RT archive (${data.archive.archive_depth_days} days) vs GTFS schedule. Stop ${stop.stop_id}.`}
    />
  );
}

export default function HeadwayStrip({ route, direction }: { route: string; direction: number }) {
  const [data, setData] = useState<HeadwaySummaryResponse | null>(null);
  const [err, setErr] = useState(false);
  const [openStop, setOpenStop] = useState<string | null>(null);

  useEffect(() => {
    setErr(false);
    getHeadwaysSummary(route, direction)
      .then(setData)
      .catch(() => setErr(true));
  }, [route, direction]);

  if (err) return <div className="nyc-note">Headway strip unavailable.</div>;
  if (!data) return <div className="nyc-note">Loading headway strip…</div>;
  const stops = data.stops.filter((s) => s.direction_id === direction || s.direction_id == null);
  if (!stops.length)
    return <div className="nyc-note">No per-stop headway observations for this direction yet.</div>;

  const maxMin = Math.max(
    5,
    ...stops.map((s) => Math.max(s.median_headway_min ?? 0, s.sched_median_headway_min ?? 0)),
  );
  const openStopObj = stops.find((s) => s.stop_id === openStop) ?? null;

  return (
    <section className="obs-panel">
      <div className="obs-panel-head">
        <h3 style={{ margin: 0 }}>Headways along the route</h3>
        <div className="obs-hw-key">
          <span><i className="obs-hw-sched key" /> scheduled</span>
          <span><i className="obs-hw-obs key" style={{ background: "#16a34a" }} /> steady</span>
          <span><i className="obs-hw-obs key" style={{ background: "#dc2626" }} /> bunching</span>
        </div>
      </div>
      <p className="nyc-note" style={{ marginTop: 0 }}>
        Each row is a stop, ordered along the route. The tick is the scheduled headway; the dot is observed
        (green = steady gaps, red = bunching). Click a stop for its hour-by-hour detail.
      </p>
      <div className="obs-hw-strip">
        {stops.map((s) => (
          <div key={`${s.stop_id}-${s.direction_id}`}>
            <StopRow
              s={s}
              maxMin={maxMin}
              open={openStop === s.stop_id}
              onToggle={() => setOpenStop(openStop === s.stop_id ? null : s.stop_id)}
            />
            {openStop === s.stop_id && openStopObj && <StopDetail route={route} stop={openStopObj} />}
          </div>
        ))}
      </div>
      <ArchiveBadge archive={data.archive} compact />
    </section>
  );
}
