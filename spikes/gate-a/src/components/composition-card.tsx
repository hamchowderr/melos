import type { Composition } from "@/lib/composition";

export function CompositionCard({ composition }: { composition: Composition }) {
  const minutes = Math.floor(composition.durationSec / 60);
  const seconds = String(composition.durationSec % 60).padStart(2, "0");
  return (
    <div
      data-testid="composition-card"
      style={{
        border: "1px solid #d4d4d8",
        borderRadius: 8,
        padding: 12,
        margin: "8px 0",
        background: "#fafafa",
      }}
    >
      <div data-testid="composition-title" style={{ fontWeight: 600 }}>
        {composition.title}
      </div>
      <div style={{ fontSize: 12, color: "#52525b" }}>
        ISWC {composition.iswc} · {minutes}:{seconds} · {composition.bpm} BPM ·{" "}
        {composition.key} · {composition.publisher}
      </div>
      <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
        {composition.writers.map((w) => (
          <li key={w.name}>
            {w.name} ({w.role}) {w.sharePct}%
          </li>
        ))}
      </ul>
      <div data-testid="composition-org" style={{ fontSize: 11, color: "#71717a" }}>
        org: {composition.context.organizationId ?? "none"}
      </div>
    </div>
  );
}
