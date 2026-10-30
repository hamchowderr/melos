import { resolveWorkspacePage } from '@/app/workspace-page';
import { PageCard } from '@/components/page-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { listParties } from '@/server/services/contacts/read';
import { requirePermission } from '@/server/services/permissions';
import { getSelfParties } from '@/server/services/rights/self-parties';
import { SettingsNav } from '../settings-nav';
import { OwnershipForm, SelfPartyList } from './ownership-form';

export const dynamic = 'force-dynamic';

export default async function OwnershipPage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const { tenant } = workspace;
  // The services check rights:read and contact:read for this request's role (§6.2, D-5).
  const [selfParties, parties] = await Promise.all([getSelfParties(tenant), listParties(tenant)]);

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="settings">
      <div className="flex flex-col items-center gap-4 px-4 py-6">
        <SettingsNav current="ownership" />
        <PageCard title="Ownership" className="max-w-2xl">
          <p className="text-muted-foreground">
            The parties that are this workspace on each rights side, for readiness and default
            ownership.
          </p>
          {!selfParties.ok || !parties.ok ? (
            // Both reads refuse only with FORBIDDEN: this request's role cannot read them (§6.2).
            <Alert>
              <AlertTitle>You do not have access to ownership</AlertTitle>
              <AlertDescription>Ask the workspace owner for access.</AlertDescription>
            </Alert>
          ) : requirePermission(tenant, { rights: ['update'] }).ok ? (
            <OwnershipForm selfParties={selfParties.value} parties={parties.value} />
          ) : (
            <SelfPartyList selfParties={selfParties.value} />
          )}
        </PageCard>
      </div>
    </WorkspaceShell>
  );
}
