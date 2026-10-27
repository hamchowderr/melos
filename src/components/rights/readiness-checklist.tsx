import Link from 'next/link';
import { ReadinessBadges } from '@/components/rights/readiness-badges';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
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
    <ul aria-label="Recordings" className="flex flex-col gap-3">
      {recordings.map((recording) => (
        <li key={recording.recordingId}>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  <Link href={songHref(recording)} className="underline-offset-4 hover:underline">
                    {recording.title}
                  </Link>
                </h2>
              </CardTitle>
              <ReadinessBadges {...recording} />
            </CardHeader>
            {recording.issues.length > 0 ? (
              <CardContent>
                <ul aria-label={`${recording.title} issues`} className="flex flex-col gap-1">
                  {recording.issues.map((issue) => (
                    <li key={issue.code} className="flex flex-wrap items-center gap-2">
                      <Badge variant={issue.severity === 'blocking' ? 'destructive' : 'outline'}>
                        {issue.code}
                      </Badge>
                      <span className="text-muted-foreground">{issue.detail}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            ) : null}
          </Card>
        </li>
      ))}
    </ul>
  );
}
