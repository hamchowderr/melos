import { resolveWorkspacePage } from '@/app/workspace-page';
import { ReportBuilder } from '@/components/reports/report-builder';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PageHeader } from '@/components/workspace/page-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { listSongs } from '@/server/services/catalog/read';
import { requirePermission } from '@/server/services/permissions';
import { listReportTemplates } from '@/server/services/reports/templates';

export const dynamic = 'force-dynamic';

/** /reports (§2.3 ReportPreview): songs in order, a preset, section toggles and the text. */
export default async function ReportsPage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const { tenant } = workspace;
  const [songs, templates] = await Promise.all([listSongs(tenant), listReportTemplates(tenant)]);

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="reports">
      <PageHeader title="Reports" />
      <div className="px-4 pt-3 pb-6 md:px-6">
        {songs.ok && templates.ok ? (
          <ReportBuilder
            songs={songs.value}
            templates={templates.value}
            generates={requirePermission(tenant, { report: ['generate'] }).ok}
          />
        ) : (
          <Alert>
            <AlertTitle>You do not have access to reports</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </WorkspaceShell>
  );
}
