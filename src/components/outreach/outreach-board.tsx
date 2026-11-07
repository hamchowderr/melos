'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createDraft, loadDraft, loadThread, saveDraft, sendDraft } from '@/app/outreach/actions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GridFrame } from '@/components/ui/grid-frame';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import type { MessageDraftDTO, OutboxMessageDTO, ThreadMessageDTO } from '@/lib/dto/outreach';

export type PitchOption = { pitchId: string; label: string };

const STATUS: Record<string, string> = { draft: 'Draft', sent: 'Sent', failed: 'Failed' };

/** The draft editor (§2.3 MessageDraftCard): subject, body and the To address, then send. */
function DraftEditor({
  row,
  draft,
  onDone,
}: {
  row: OutboxMessageDTO;
  draft: MessageDraftDTO;
  onDone: (note: string) => void;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.bodyText);
  const [to, setTo] = useState(draft.to[0]?.contactMethodId ?? '');
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const address = row.emails.find((email) => email.contactMethodId === to)?.address;
  const save = () =>
    saveDraft({ messageId: draft.messageId, subject, bodyText: body, to: to ? [to] : [] });
  const onSave = () =>
    start(async () => {
      const result = await save();
      setNote(result.ok ? 'Draft saved.' : `Not saved (${result.code}).`);
    });
  // OUT-004: the edits are saved first, so what is sent is what the dialog named.
  const onSend = () =>
    start(async () => {
      const saved = await save();
      if (!saved.ok) return setNote(`Not saved (${saved.code}).`);
      const sent = await sendDraft(draft.messageId);
      if (!sent.ok) return setNote(`Not sent (${sent.code}).`);
      onDone(sent.value.status === 'sent' ? 'Sent.' : `Not sent (${sent.value.failureReason}).`);
    });
  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <NativeSelect aria-label="To" value={to} onChange={(event) => setTo(event.target.value)}>
        <NativeSelectOption value="">No recipient</NativeSelectOption>
        {row.emails.map((email) => (
          <NativeSelectOption key={email.contactMethodId} value={email.contactMethodId}>
            {`${row.contactName} <${email.address}>`}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <Textarea
        aria-label="Body"
        className="min-h-48"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onSave}>
          Save draft
        </Button>
        <AlertDialog>
          <AlertDialogTrigger render={<Button size="sm" disabled={busy || !address} />}>
            Send…
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{`Send "${subject}"?`}</AlertDialogTitle>
              <AlertDialogDescription>{`It goes to ${address} now.`}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onSend}>Send</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </div>
    </div>
  );
}

/** A new follow-up draft on one of the workspace's pitches (OUT-001). */
function NewDraft({ pitches, onDone }: { pitches: PitchOption[]; onDone: () => void }) {
  const [pitchId, setPitchId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const create = () =>
    start(async () => {
      const result = await createDraft({ pitchId, purpose: 'follow_up', subject, bodyText: body });
      if (!result.ok) return setError(`Not created (${result.code}).`);
      onDone();
    });
  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <NativeSelect aria-label="Pitch" value={pitchId} onChange={(e) => setPitchId(e.target.value)}>
        <NativeSelectOption value="">Pick a pitch…</NativeSelectOption>
        {pitches.map((pitch) => (
          <NativeSelectOption key={pitch.pitchId} value={pitch.pitchId}>
            {pitch.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <Textarea
        aria-label="Body"
        className="min-h-40"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || !pitchId || !subject.trim() || !body.trim()}
          onClick={create}
        >
          Create draft
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

/** /outreach (§2.3): drafts and sent messages; a draft opens its editor, a sent one its text. */
export function OutreachBoard({
  rows,
  pitches,
}: {
  rows: OutboxMessageDTO[];
  pitches: PitchOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<OutboxMessageDTO | 'new' | null>(null);
  const [draft, setDraft] = useState<MessageDraftDTO | null>(null);
  const [sent, setSent] = useState<ThreadMessageDTO | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [, start] = useTransition();
  const show = (row: OutboxMessageDTO) =>
    start(async () => {
      setDraft(null);
      setSent(null);
      setOpen(row);
      if (row.status === 'draft') {
        const result = await loadDraft(row.messageId);
        if (result.ok) setDraft(result.value);
        return;
      }
      const thread = await loadThread(row.messageId);
      if (thread.ok)
        setSent(thread.value.messages.find((m) => m.messageId === row.messageId) ?? null);
    });
  const done = (message: string | null) => {
    setOpen(null);
    setNote(message);
    router.refresh();
  };
  const row = open && open !== 'new' ? open : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setOpen('new')}>
          New draft
        </Button>
        {note ? (
          <span role="status" className="text-xs text-muted-foreground">
            {note}
          </span>
        ) : null}
      </div>
      <GridFrame>
        <Table aria-label="Messages">
          <TableHeader>
            <TableRow>
              {['Subject', 'To', 'Status', 'Date'].map((heading) => (
                <TableHead key={heading}>{heading}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={r.messageId}
                tabIndex={0}
                aria-label={`${r.subject ?? 'No subject'} to ${r.contactName}`}
                className="cursor-pointer"
                onClick={() => show(r)}
                onKeyDown={(event) => event.key === 'Enter' && show(r)}
              >
                <TableCell className="font-medium whitespace-normal">
                  {r.subject ?? 'No subject'}
                </TableCell>
                <TableCell>{r.contactName}</TableCell>
                <TableCell>
                  <Badge variant={r.status === 'draft' ? 'outline' : 'secondary'}>
                    {STATUS[r.status] ?? r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {r.at.slice(0, 10)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </GridFrame>
      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {row ? (row.status === 'draft' ? 'Email draft' : 'Email') : 'New draft'}
            </SheetTitle>
          </SheetHeader>
          {open === 'new' ? (
            <NewDraft pitches={pitches} onDone={() => done('Draft created.')} />
          ) : null}
          {row && draft ? (
            <DraftEditor key={draft.messageId} row={row} draft={draft} onDone={done} />
          ) : null}
          {row && sent ? (
            <div className="flex flex-col gap-2 px-4 pb-4 text-sm">
              <p className="text-muted-foreground">{`To ${sent.to.join(', ')} · ${(sent.sentAt ?? '').slice(0, 10)}`}</p>
              <p className="font-medium">{sent.subject}</p>
              <p className="whitespace-pre-wrap">{sent.bodyText}</p>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
