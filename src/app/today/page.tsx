import { resolveWorkspacePage } from '@/app/workspace-page';
import { ReadinessChecklist } from '@/components/rights/readiness-checklist';
import { FollowUpQueue, TodaySide } from '@/components/today/follow-up-queue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PageHeader } from '@/components/workspace/page-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { getTodayWorkspace } from '@/server/services/pitches/today';

export const dynamic = 'force-dynamic';

const longDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    ...{ weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' },
  });

/** /today (§2.3 TodayWorkspace, CRM-005): follow-ups due, replies, readiness and ready to pitch. */
export default async function TodayPage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const today = await getTodayWorkspace(workspace.tenant);

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="today">
      <PageHeader title="Today" count={today.ok ? longDate(today.value.date) : undefined} />
      <div className="flex flex-col gap-5 px-4 pt-3 pb-6 md:px-6">
        {today.ok ? (
          <>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
              <FollowUpQueue cells={today.value.followUpsDue} />
              <TodaySide today={today.value} />
            </div>
            <section aria-label="Readiness issues" className="flex flex-col gap-1.5">
              <h2 className="text-sm font-medium">
                Readiness issues{' '}
                <span className="font-normal text-muted-foreground">
                  {today.value.readinessIssues.recordings.length}
                </span>
              </h2>
              <ReadinessChecklist
                recordings={today.value.readinessIssues.recordings}
                onlyNotReady
              />
            </section>
          </>
        ) : (
          <Alert>
            <AlertTitle>You do not have access to today's work</AlertTitle>
            <AlertDescription>
              Ask the workspace owner for access to pitches and rights.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </WorkspaceShell>
  );
}
