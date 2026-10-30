import Link from 'next/link';
import { resolveWorkspacePage } from '@/app/workspace-page';
import { ReadinessChecklist } from '@/components/rights/readiness-checklist';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/workspace/page-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { getReadinessIssues } from '@/server/services/rights/read';

export const dynamic = 'force-dynamic';

const recordingCount = (count: number) => (count === 1 ? '1 recording' : `${count} recordings`);

type Props = { searchParams: Promise<{ all?: string }> };

/** The readiness checklist (RGT-005, DEMO-003): not-ready recordings, or with `?all=1` every one. */
export default async function RightsPage({ searchParams }: Props) {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const onlyNotReady = (await searchParams).all !== '1';
  // RightsService checks rights:read for the role resolved for this request (§6.2).
  const report = await getReadinessIssues(workspace.tenant, { onlyNotReady, limit: 200 });

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="rights">
      <PageHeader
        title="Rights readiness"
        count={report.ok ? recordingCount(report.value.recordings.length) : undefined}
      >
        {/* A link, so the filter is in the URL and works without client JavaScript. */}
        <Link
          href={onlyNotReady ? '/rights?all=1' : '/rights'}
          role="switch"
          aria-checked={onlyNotReady}
          className={buttonVariants({ variant: onlyNotReady ? 'secondary' : 'outline' })}
        >
          Only not ready
        </Link>
      </PageHeader>
      <div className="flex flex-col gap-4 p-4">
        {report.ok ? (
          <ReadinessChecklist recordings={report.value.recordings} onlyNotReady={onlyNotReady} />
        ) : (
          // getReadinessIssues refuses only with FORBIDDEN here: no recording filter is passed.
          <Alert>
            <AlertTitle>You do not have access to these rights</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </WorkspaceShell>
  );
}
