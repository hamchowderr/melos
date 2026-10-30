import Link from 'next/link';
import { ReadinessBadges } from '@/components/rights/readiness-badges';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { GridFrame } from '@/components/ui/grid-frame';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ReadinessReportDTO } from '@/lib/dto/rights';

type Props = { recordings: ReadinessReportDTO['recordings']; onlyNotReady: boolean };

/** A recording's song page (D-12): its composition's, or its own without one. */
const songHref = ({ compositionId, recordingId }: Props['recordings'][number]) =>
  compositionId ? `/catalog/compositions/${compositionId}` : `/catalog/recordings/${recordingId}`;

/** Blocking issues and warnings per recording (§2.3 ReadinessChecklist, §6.5), by title. */
export function ReadinessChecklist({ recordings, onlyNotReady }: Props) {
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
    <GridFrame className="overflow-x-auto">
      <Table aria-label="Recordings">
        <TableHeader>
          <TableRow>
            <TableHead>Recording</TableHead>
            <TableHead>Readiness</TableHead>
            <TableHead className="text-right">Blocking</TableHead>
            <TableHead>Issues</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recordings.map((recording) => (
            <TableRow key={recording.recordingId}>
              <TableCell className="whitespace-normal font-medium">
                <Link href={songHref(recording)} className="underline-offset-4 hover:underline">
                  {recording.title}
                </Link>
              </TableCell>
              <TableCell>
                <ReadinessBadges {...recording} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {recording.issues.filter(({ severity }) => severity === 'blocking').length}
              </TableCell>
              <TableCell className="whitespace-normal">
                {recording.issues.length > 0 ? (
                  <ul aria-label={`${recording.title} issues`} className="flex flex-col gap-1 py-1">
                    {recording.issues.map((issue) => (
                      <li key={issue.code} className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge
                          variant={issue.severity === 'blocking' ? 'destructive' : 'outline'}
                          className="font-mono text-[0.65rem]"
                        >
                          {issue.code}
                        </Badge>
                        <span className="text-muted-foreground">{issue.detail}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </GridFrame>
  );
}
