// Download row per DOWNLOAD_AND_FORMATS + the ARKMAP D-4 geospatial carve-out:
// geospatial = GeoJSON + GeoParquet; tabular = CSV/XLSX/Parquet (no plain JSON).
// Inventory comes from the backend registry (correct content-types server-side).
import { useEffect, useState } from "react";

export interface DownloadItem {
  key: string;
  label: string;
  group: string;
  format: string;
  bytes: number;
  note: string;
  href: string;
}

const FMT_LABEL: Record<string, string> = {
  geojson: "GeoJSON", geoparquet: "GeoParquet", parquet: "Parquet", csv: "CSV", xlsx: "XLSX",
};

function fmtBytes(b: number): string {
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}

export default function DownloadRow({ groups, exclude }: { groups?: string[]; exclude?: string[] }) {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetch("/api/downloads")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: DownloadItem[]) => setItems(d))
      .catch(() => setErr(true));
  }, []);

  let show = groups ? items.filter((i) => groups.includes(i.group)) : items;
  if (exclude) show = show.filter((i) => !exclude.includes(i.group));
  if (err) return <div className="nyc-note">Downloads temporarily unavailable.</div>;
  if (!show.length) return null;

  const byGroup = new Map<string, DownloadItem[]>();
  for (const i of show) {
    const g = byGroup.get(i.group) ?? [];
    g.push(i);
    byGroup.set(i.group, g);
  }

  return (
    <div>
      {[...byGroup.entries()].map(([g, its]) => (
        <div key={g} style={{ margin: "0.8rem 0" }}>
          <strong style={{ fontSize: "0.92rem" }}>{g}</strong>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginTop: "0.4rem" }}>
            {its.map((i) => (
              <a
                key={i.key}
                href={i.href}
                title={i.note || i.label}
                style={{
                  border: "1px solid var(--ark-border, #d4d8dd)",
                  borderRadius: 8,
                  padding: "0.3rem 0.65rem",
                  fontSize: "0.8rem",
                  textDecoration: "none",
                  color: "inherit",
                  background: "var(--ark-surface, transparent)",
                }}
              >
                <span style={{ fontWeight: 600 }}>{i.label}</span>{" "}
                <span style={{ opacity: 0.65 }}>
                  · {FMT_LABEL[i.format] ?? i.format} · {fmtBytes(i.bytes)}
                </span>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
