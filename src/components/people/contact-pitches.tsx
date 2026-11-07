import Link from 'next/link';
import type { ReactNode } from 'react';
import type { PitchableSong } from '@/components/people/create-pitch';
import { Badge } from '@/components/ui/badge';
import { GridFrame } from '@/components/ui/grid-frame';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SongListItem } from '@/lib/dto/catalog';
import type { ContactDetailDTO } from '@/lib/dto/contacts';
import { PITCH_STATUS_LABELS, type PitchEligibilityDTO } from '@/lib/dto/pitches';

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const songHref = ({ itemType, itemId }: { itemType: string; itemId: string }) =>
  `/catalog/${itemType === 'composition' ? 'compositions' : 'recordings'}/${itemId}`;

/** Each song by its composition, or its recording when it has none (§3.7), for Create pitch. */
export const pitchableSongs = (songs: SongListItem[]): PitchableSong[] =>
  songs.flatMap(({ compositionId, primaryRecordingId, title }): PitchableSong[] => {
    if (compositionId)
      return [
        { key: compositionId, title, item: { itemType: 'composition', itemId: compositionId } },
      ];
    if (primaryRecordingId)
      return [
        {
          key: primaryRecordingId,
          title,
          item: { itemType: 'recording', itemId: primaryRecordingId },
        },
      ];
    return [];
  });

/** A contact's pitch cells and recent messages (§2.3 ContactCard, CRM-001). */
export function ContactPitches({
  contact,
  create,
}: {
  contact: ContactDetailDTO;
  create: ReactNode;
}) {
  return (
    <section aria-label="Pitch history" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-medium">
          Pitches{' '}
          <span className="font-normal text-muted-foreground">{contact.pitchItems.length}</span>
        </h2>
        {create}
      </div>
      <GridFrame>
        <Table aria-label="Pitched songs">
          <TableHeader>
            <TableRow>
              <TableHead>Song</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Follow up</TableHead>
              <TableHead>Last contact</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contact.pitchItems.map((cell) => (
              <TableRow key={cell.pitchItemId} aria-label={cell.itemTitle}>
                <TableCell className="font-medium">
                  <Link href={songHref(cell)} className="hover:underline">
                    {cell.itemTitle}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{PITCH_STATUS_LABELS[cell.currentStatus]}</Badge>
                </TableCell>
                <TableCell>{cell.followUpDue ? 'Due' : day(cell.nextFollowUpAt)}</TableCell>
                <TableCell className="text-muted-foreground">{day(cell.lastContactedAt)}</TableCell>
              </TableRow>
            ))}
            {contact.pitchItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No songs pitched yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </GridFrame>
      <h2 className="mt-2 text-sm font-medium">Recent messages</h2>
      <ul
        aria-label="Recent messages"
        className="flex flex-col gap-0.5 rounded-lg bg-muted/40 p-1.5 text-sm"
      >
        {contact.recentMessages.map((message) => (
          <li key={message.messageId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">
              {message.direction === 'outbound' ? 'Sent' : 'Reply'}
            </span>
            <span className="min-w-0 flex-1 truncate">{message.subject ?? 'No subject'}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {day(message.sentAt ?? message.receivedAt ?? message.createdAt)}
            </span>
          </li>
        ))}
        {contact.recentMessages.length === 0 ? (
          <li className="px-2 py-1.5 text-muted-foreground">No messages yet.</li>
        ) : null}
      </ul>
    </section>
  );
}

/** "Who hasn't heard this" on a song page (§2.3 ContactGrid, CRM-006, P-36). */
export function WhoHasntHeard({ eligibility }: { eligibility: PitchEligibilityDTO }) {
  const lists = [
    ['Planned, not contacted', eligibility.plannedNotContacted],
    ['Never pitched', eligibility.neverPitched],
  ] as const;
  return (
    <section
      aria-label="Who hasn't heard this"
      className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3"
    >
      <h2 className="text-sm font-medium">Who hasn't heard this</h2>
      {lists.map(([title, contacts]) => (
        <div key={title} className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">{title}</h3>
          <ul aria-label={title} className="flex flex-col gap-0.5 text-sm">
            {contacts.map((contact) => (
              <li key={contact.contactId}>{contact.displayName}</li>
            ))}
            {contacts.length === 0 ? <li className="text-muted-foreground">No one.</li> : null}
          </ul>
        </div>
      ))}
    </section>
  );
}
