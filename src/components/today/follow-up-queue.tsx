import Link from 'next/link';
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
import { PITCH_STATUS_LABELS, type PitchSummary, type TodayWorkspaceDTO } from '@/lib/dto/pitches';

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

/** A cell's song page: its composition, or its recording (§3.7). */
export const songHref = (cell: Pick<PitchSummary, 'itemType' | 'itemId'>) =>
  `/catalog/${cell.itemType === 'composition' ? 'compositions' : 'recordings'}/${cell.itemId}`;

/** FollowUpQueue (§2.3, CRM-005): the cells due today, in P-31 priority order. */
export function FollowUpQueue({ cells }: { cells: PitchSummary[] }) {
  return (
    <section aria-labelledby="follow-ups" className="flex flex-col gap-1.5">
      <h2 id="follow-ups" className="text-sm font-medium">
        Follow-ups due <span className="font-normal text-muted-foreground">{cells.length}</span>
      </h2>
      <GridFrame>
        <Table aria-label="Follow-up queue">
          <TableHeader>
            <TableRow>
              <TableHead>Song</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Contact</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cells.map((cell) => (
              <TableRow
                key={cell.pitchItemId}
                aria-label={`${cell.itemTitle} to ${cell.contactName}`}
              >
                <TableCell className="font-medium">
                  <Link href={songHref(cell)} className="hover:underline">
                    {cell.itemTitle}
                  </Link>
                </TableCell>
                <TableCell>{cell.contactName}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{PITCH_STATUS_LABELS[cell.currentStatus]}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {day(cell.lastContactedAt)}
                </TableCell>
              </TableRow>
            ))}
            {cells.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  Nothing is due today.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </GridFrame>
    </section>
  );
}

/** A short titled list in the side column; an empty list says so. */
function SideList({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h2 className="text-sm font-medium">
        {title} <span className="font-normal text-muted-foreground">{children.length}</span>
      </h2>
      <ul className="flex flex-col gap-0.5 rounded-lg bg-muted/40 p-1.5 text-sm">
        {children.length ? (
          children
        ) : (
          <li className="px-2 py-1.5 text-muted-foreground">{empty}</li>
        )}
      </ul>
    </section>
  );
}

/** Replies received in the last 7 days and one-stop-ready songs agents have not heard. */
export function TodaySide({ today }: { today: TodayWorkspaceDTO }) {
  return (
    <div className="flex flex-col gap-4">
      <SideList title="Recent Replies" empty="No replies this week.">
        {today.recentReplies.map((cell) => (
          <li key={cell.pitchItemId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <Link href={songHref(cell)} className="min-w-0 flex-1 truncate hover:underline">
              {cell.itemTitle}{' '}
              <span className="text-muted-foreground">from {cell.contactName}</span>
            </Link>
            <span className="text-xs text-muted-foreground tabular-nums">
              {day(cell.receivedAt)}
            </span>
          </li>
        ))}
      </SideList>
      <SideList title="Ready to Pitch" empty="No one-stop-ready song is waiting.">
        {today.readyToPitch.map((song) => (
          <li key={song.recordingId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <Link
              href={`/catalog/recordings/${song.recordingId}`}
              className="min-w-0 flex-1 truncate hover:underline"
            >
              {song.title}
            </Link>
            <span className="text-xs text-muted-foreground">
              {song.neverPitchedLicensingAgentCount === 1
                ? '1 agent not pitched'
                : `${song.neverPitchedLicensingAgentCount} agents not pitched`}
            </span>
          </li>
        ))}
      </SideList>
    </div>
  );
}
