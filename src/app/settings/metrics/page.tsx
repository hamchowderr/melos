import { resolveWorkspacePage } from '@/app/workspace-page';
import { PageCard } from '@/components/page-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { GridFrame } from '@/components/ui/grid-frame';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { getNorthStarWeek } from '@/server/services/metrics/north-star';
import { SettingsNav } from '../settings-nav';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

/** The Mondays (UTC) of this week and the three before it, newest first. */
function recentWeeks(now = new Date()): string[] {
  const monday =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    ((now.getUTCDay() + 6) % 7) * DAY_MS;
  return [0, 1, 2, 3].map((back) =>
    new Date(monday - back * 7 * DAY_MS).toISOString().slice(0, 10),
  );
}

/** /settings/metrics (melos-ajt.1): the North Star and its inputs per week, for the owner only. */
export default async function MetricsPage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const weeks = await Promise.all(
    recentWeeks().map((week) => getNorthStarWeek(workspace.tenant, week)),
  );
  const first = weeks[0]?.ok ? weeks[0].value.firstCompletePackageAt : null;

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="settings">
      <div className="flex flex-col items-center gap-4 px-4 py-6">
        <SettingsNav current="metrics" />
        <PageCard title="North Star" className="max-w-2xl">
          {weeks.every((week) => week.ok) ? (
            <>
              <p className="text-muted-foreground">
                Songs sent to a pitch target with a complete metadata package: the song was one-stop
                ready when it was sent.{' '}
                {first
                  ? `First complete package ${first.slice(0, 10)}.`
                  : 'No complete package sent yet.'}
              </p>
              <GridFrame>
                <Table aria-label="North Star by week">
                  <TableHeader>
                    <TableRow>
                      {['Week of', 'Complete', 'Songs sent', 'Follow-ups on time'].map((h) => (
                        <TableHead key={h}>{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {weeks.flatMap((week) =>
                      week.ok
                        ? [
                            <TableRow
                              key={week.value.weekStart}
                              aria-label={`Week of ${week.value.weekStart}`}
                            >
                              <TableCell className="tabular-nums">{week.value.weekStart}</TableCell>
                              <TableCell className="font-medium">
                                {week.value.songsPitchedComplete}
                              </TableCell>
                              <TableCell>{week.value.songsPitched}</TableCell>
                              <TableCell>{`${week.value.followUpsOnTime} of ${week.value.followUpsSent}`}</TableCell>
                            </TableRow>,
                          ]
                        : [],
                    )}
                  </TableBody>
                </Table>
              </GridFrame>
            </>
          ) : (
            <Alert>
              <AlertTitle>Only the workspace owner sees these numbers</AlertTitle>
              <AlertDescription>Ask the owner if you need them.</AlertDescription>
            </Alert>
          )}
        </PageCard>
      </div>
    </WorkspaceShell>
  );
}
