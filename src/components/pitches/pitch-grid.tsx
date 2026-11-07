'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { changePitchStatus, loadPitch, notePitch } from '@/app/pitches/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { GridFrame } from '@/components/ui/grid-frame';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  PITCH_STATUS_LABELS,
  PITCH_TRANSITIONS,
  type PitchDTO,
  type PitchStatus,
  type PitchSummary,
  TERMINAL_STATUSES,
} from '@/lib/dto/pitches';

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const label = (status: PitchStatus | null) => (status ? PITCH_STATUS_LABELS[status] : 'new');

/** The pitch's events in time order, newest last (PitchTimeline, §2.3). */
function Timeline({ pitch }: { pitch: PitchDTO }) {
  return (
    <ol aria-label="Timeline" className="flex flex-col gap-1 text-xs">
      {pitch.events.map((event) => (
        <li key={event.eventId} className="flex gap-3">
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {day(event.occurredAt)}
          </span>
          <span>
            {[
              event.eventType.replace(/_/g, ' '),
              event.toStatus ? `${label(event.fromStatus)} to ${label(event.toStatus)}` : null,
              event.note,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One cell's status change: the §6.4 moves; won, lost and archived take a second click. */
function StatusChange({ cell, onDone }: { cell: PitchSummary; onDone: (pitch: PitchDTO) => void }) {
  const moves = cell.currentStatus === 'archived' ? [] : PITCH_TRANSITIONS[cell.currentStatus];
  const [to, setTo] = useState<PitchStatus | ''>('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  if (moves.length === 0) return null;
  const terminal = to !== '' && TERMINAL_STATUSES.includes(to);
  const save = () => {
    if (to === '') return;
    if (terminal && !confirming) return setConfirming(true);
    start(async () => {
      const result = await changePitchStatus({ pitchItemId: cell.pitchItemId, toStatus: to });
      setConfirming(false);
      if (result.ok) onDone(result.pitch);
      else setError(`Not changed (${result.code}).`);
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        size="sm"
        aria-label={`New status for ${cell.itemTitle}`}
        value={to}
        onChange={(event) => {
          setTo(event.target.value as PitchStatus);
          setConfirming(false);
        }}
      >
        <NativeSelectOption value="">Change status</NativeSelectOption>
        {moves.map((status) => (
          <NativeSelectOption key={status} value={status}>
            {PITCH_STATUS_LABELS[status]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button size="sm" disabled={to === '' || saving} onClick={save}>
        {confirming ? `Confirm: ${label(to || null)}` : 'Save'}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

/** The side panel: the pitch's songs with their status changes, a note, and the timeline. */
function PitchPanel({
  pitch,
  updates,
  onChange,
}: {
  pitch: PitchDTO;
  updates: boolean;
  onChange: (pitch: PitchDTO) => void;
}) {
  const [note, setNote] = useState('');
  const [saving, start] = useTransition();
  const addNote = () =>
    start(async () => {
      const result = await notePitch({ pitchId: pitch.pitchId, note });
      if (result.ok) {
        setNote('');
        onChange(result.pitch);
      }
    });
  return (
    <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
      <ul aria-label="Songs in this pitch" className="flex flex-col gap-3">
        {pitch.items.map((cell) => (
          <li key={cell.pitchItemId} className="flex flex-col gap-1.5 rounded-lg bg-muted/40 p-3">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-medium">{cell.itemTitle}</span>
              <Badge variant="secondary">{PITCH_STATUS_LABELS[cell.currentStatus]}</Badge>
            </div>
            {updates ? <StatusChange cell={cell} onDone={onChange} /> : null}
          </li>
        ))}
      </ul>
      {updates ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Note"
            placeholder="Add a note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button
            size="sm"
            className="self-start"
            disabled={!note.trim() || saving}
            onClick={addNote}
          >
            Add note
          </Button>
        </div>
      ) : null}
      <Timeline pitch={pitch} />
    </div>
  );
}

/** /pitches (§2.3 PitchTable, CRM-003): one row per cell; a row opens its pitch in the side panel. */
export function PitchGrid({ cells, updates }: { cells: PitchSummary[]; updates: boolean }) {
  const router = useRouter();
  const [pitch, setPitch] = useState<PitchDTO | null>(null);
  const [, start] = useTransition();
  const open = (cell: PitchSummary) =>
    start(async () => {
      const result = await loadPitch(cell.pitchId);
      if (result.ok) setPitch(result.pitch);
    });
  const changed = (next: PitchDTO) => {
    setPitch(next);
    router.refresh();
  };
  if (cells.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No pitches</EmptyTitle>
          <EmptyDescription>No song has been pitched with this status.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <GridFrame>
        <Table aria-label="Pitch list">
          <TableHeader>
            <TableRow>
              {['Song', 'Contact', 'Status', 'Follow up', 'Last contact'].map((heading) => (
                <TableHead key={heading}>{heading}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {cells.map((cell) => (
              <TableRow
                key={cell.pitchItemId}
                tabIndex={0}
                aria-label={`${cell.itemTitle} to ${cell.contactName}`}
                className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
                onClick={() => open(cell)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') open(cell);
                }}
              >
                <TableCell className="font-medium whitespace-normal">{cell.itemTitle}</TableCell>
                <TableCell className="whitespace-normal">{cell.contactName}</TableCell>
                <TableCell>{PITCH_STATUS_LABELS[cell.currentStatus]}</TableCell>
                <TableCell>{cell.followUpDue ? 'Due' : day(cell.nextFollowUpAt)}</TableCell>
                <TableCell>{day(cell.lastContactedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </GridFrame>
      <Sheet open={pitch !== null} onOpenChange={(isOpen) => (isOpen ? null : setPitch(null))}>
        <SheetContent>
          {pitch ? (
            <>
              <SheetHeader>
                <SheetTitle>{pitch.contactName}</SheetTitle>
                <SheetDescription>{pitch.subject ?? 'Pitch'}</SheetDescription>
              </SheetHeader>
              <PitchPanel pitch={pitch} updates={updates} onChange={changed} />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
