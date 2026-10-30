'use client';

import Link from 'next/link';
import { useState } from 'react';
import { IssueItem } from '@/components/rights/issue-item';
import { ReadinessBadges } from '@/components/rights/readiness-badges';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { GridFrame } from '@/components/ui/grid-frame';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
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
import type { ReadinessReportDTO } from '@/lib/dto/rights';

type Recording = ReadinessReportDTO['recordings'][number];
type Props = { recordings: Recording[]; onlyNotReady: boolean };

/** A recording's song page (D-12): its composition's, or its own without one. */
const songHref = ({ compositionId, recordingId }: Recording) =>
  compositionId ? `/catalog/compositions/${compositionId}` : `/catalog/recordings/${recordingId}`;

const countOf = (recording: Recording, severity: 'blocking' | 'warning') =>
  recording.issues.filter((issue) => issue.severity === severity).length;

/** A count as a soft chip: red for blocking issues, amber for warnings, nothing when zero. */
function CountChip({ count, severity }: { count: number; severity: 'blocking' | 'warning' }) {
  if (count === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge
      variant="secondary"
      className={
        severity === 'blocking'
          ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
      }
    >
      {count} {severity === 'blocking' ? 'blocking' : count === 1 ? 'warning' : 'warnings'}
    </Badge>
  );
}

/** One recording's issues in the side panel: each as words with its detail, and its code. */
function IssuesPanel({ recording, onClose }: { recording: Recording | null; onClose: () => void }) {
  return (
    <Sheet open={recording !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent>
        {recording ? (
          <>
            <SheetHeader>
              <SheetTitle>{recording.title}</SheetTitle>
              <SheetDescription render={<div />}>
                <ReadinessBadges {...recording} />
              </SheetDescription>
            </SheetHeader>
            <ul aria-label={`${recording.title} issues`} className="flex flex-col gap-2 px-4">
              {recording.issues.map((issue) => (
                <IssueItem key={issue.code} issue={issue} />
              ))}
            </ul>
            <SheetFooter>
              <Link href={songHref(recording)} className={buttonVariants()}>
                Open song
              </Link>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Blocking issues and warnings per recording (§2.3 ReadinessChecklist, §6.5), by title. */
export function ReadinessChecklist({ recordings, onlyNotReady }: Props) {
  const [open, setOpen] = useState<Recording | null>(null);
  if (recordings.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>{onlyNotReady ? 'Every recording is ready' : 'No recordings yet'}</EmptyTitle>
          <EmptyDescription>
            {onlyNotReady
              ? 'No recording has a blocking issue.'
              : 'Recordings in this workspace are listed here.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <GridFrame className="overflow-x-auto">
        <Table aria-label="Recordings">
          <TableHeader>
            <TableRow>
              <TableHead>Recording</TableHead>
              <TableHead>Readiness</TableHead>
              <TableHead>Blocking</TableHead>
              <TableHead>Warnings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recordings.map((recording) => (
              <TableRow
                key={recording.recordingId}
                className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
                // A click anywhere but the title link, or Enter on the row, opens its issues.
                tabIndex={0}
                aria-label={`${recording.title} readiness`}
                onClick={(event) => {
                  if (!(event.target as HTMLElement).closest('a,button')) setOpen(recording);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.target === event.currentTarget) {
                    setOpen(recording);
                  }
                }}
              >
                <TableCell className="whitespace-normal font-medium">
                  <Link href={songHref(recording)} className="underline-offset-4 hover:underline">
                    {recording.title}
                  </Link>
                </TableCell>
                <TableCell>
                  <ReadinessBadges {...recording} />
                </TableCell>
                <TableCell>
                  <CountChip count={countOf(recording, 'blocking')} severity="blocking" />
                </TableCell>
                <TableCell>
                  <CountChip count={countOf(recording, 'warning')} severity="warning" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </GridFrame>
      <IssuesPanel recording={open} onClose={() => setOpen(null)} />
    </>
  );
}
