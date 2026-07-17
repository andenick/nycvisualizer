// R/Python code toggle per CONTENT_RENDERING_STANDARD (boxed code, copy button).
import { useState } from "react";

export interface CodeToggleProps {
  title: string;
  python: string;
  r?: string;
}

export default function CodeToggle({ title, python, r }: CodeToggleProps) {
  const [lang, setLang] = useState<"python" | "r">("python");
  const [copied, setCopied] = useState(false);
  const code = lang === "python" ? python : (r ?? python);

  const copy = () => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };

  const tab = (l: "python" | "r", label: string) => (
    <button
      onClick={() => setLang(l)}
      style={{
        border: "none",
        background: lang === l ? "var(--ark-accent, #2563eb)" : "transparent",
        color: lang === l ? "var(--ark-on-accent, #fff)" : "inherit",
        borderRadius: 6,
        padding: "0.15rem 0.6rem",
        fontSize: "0.78rem",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <section style={{ margin: "1.2rem 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
          marginBottom: "0.3rem",
        }}
      >
        <strong style={{ fontSize: "0.95rem" }}>{title}</strong>
        <span style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
          {tab("python", "Python")}
          {r ? tab("r", "R") : null}
          <button
            onClick={copy}
            style={{
              border: "1px solid var(--ark-border, #d4d8dd)",
              background: "transparent",
              color: "inherit",
              borderRadius: 6,
              padding: "0.15rem 0.6rem",
              fontSize: "0.78rem",
              cursor: "pointer",
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <pre
        style={{
          border: "1px solid var(--ark-border, #d4d8dd)",
          borderRadius: 10,
          padding: "0.8rem 1rem",
          overflowX: "auto",
          fontSize: "0.82rem",
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        <code>{code}</code>
      </pre>
    </section>
  );
}
