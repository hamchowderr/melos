import { ToolCard } from '@/components/chat/tool-card';
import { PITCH_STATUS_LABELS, type PitchDTO, type PitchSummary } from '@/lib/dto/pitches';

/** An ISO time as its calendar date. */
export const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/** A cell's status, then its follow-up: "Awaiting reply · follow-up due" or "· follow up 2026-09-10". */
export function cellStatus(cell: PitchSummary) {
  const followUp = cell.followUpDue
    ? 'follow-up due'
    : cell.nextFollowUpAt
      ? `follow up ${day(cell.nextFollowUpAt)}`
      : null;
  return [PITCH_STATUS_LABELS[cell.currentStatus], followUp].filter(Boolean).join(' · ');
}

/** PitchCard (§3.3): one song × contact cell. */
export function PitchCard({
  cell,
  show,
}: {
  cell: PitchSummary;
  show: 'song' | 'contact' | 'both';
}) {
  const name =
    show === 'song'
      ? cell.itemTitle
      : show === 'contact'
        ? cell.contactName
        : `${cell.itemTitle} to ${cell.contactName}`;
  return (
    <li
      data-pitch-item-id={cell.pitchItemId}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 odd:bg-muted/30"
    >
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{cellStatus(cell)}</span>
    </li>
  );
}

/** searchPitches's PitchTable (§3.3): one PitchCard row per cell, newest pitch first. */
export function PitchTable({ cells }: { cells: PitchSummary[] }) {
  const title = 'Pitches';
  if (cells.length === 0) {
    return (
      <ToolCard title={title}>
        <p className="px-4 pb-3 text-muted-foreground">No pitches matched.</p>
      </ToolCard>
    );
  }
  return (
    <ToolCard title={title}>
      <ul aria-label="Pitch list" className="flex flex-col">
        {cells.map((cell) => (
          <PitchCard key={cell.pitchItemId} cell={cell} show="both" />
        ))}
      </ul>
    </ToolCard>
  );
}

/** getPitch's PitchCard header (§3.3); PitchTimeline goes below it. */
export function PitchDetail({ pitch }: { pitch: PitchDTO }) {
  return (
    <ToolCard title="Pitch">
      <div className="px-4 pb-2">
        <p className="font-medium">{pitch.contactName}</p>
        {pitch.subject ? <p className="text-xs text-muted-foreground">{pitch.subject}</p> : null}
      </div>
      <ul aria-label="Songs in this pitch" className="flex flex-col">
        {pitch.items.map((cell) => (
          <PitchCard key={cell.pitchItemId} cell={cell} show="song" />
        ))}
      </ul>
    </ToolCard>
  );
}
