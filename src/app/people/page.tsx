import { resolveWorkspacePage } from '@/app/workspace-page';
import { PartyForm } from '@/components/people/party-form';
import { PartyTable } from '@/components/people/party-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/workspace/page-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { listParties } from '@/server/services/contacts/read';
import { requirePermission } from '@/server/services/permissions';

export const dynamic = 'force-dynamic';

const partyCount = (count: number) => (count === 1 ? '1 entry' : `${count} entries`);

export default async function PeoplePage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  // ContactService checks contact:read for the role resolved for this request (§6.2, D-5).
  const parties = await listParties(workspace.tenant);
  const creates = requirePermission(workspace.tenant, { contact: ['create'] }).ok;
  const ofKind = (kind: string) =>
    parties.ok ? parties.value.filter(({ partyKind }) => partyKind === kind) : [];

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="people">
      <PageHeader
        title="People and organizations"
        count={parties.ok ? partyCount(parties.value.length) : undefined}
      >
        {creates ? (
          <>
            <PartyForm kind="person" label="New person" />
            <PartyForm kind="organization" label="New organization" />
          </>
        ) : null}
      </PageHeader>
      <div className="flex flex-col gap-4 px-4 pt-3 pb-6 md:px-6">
        {parties.ok ? (
          <Tabs defaultValue="person">
            <TabsList>
              <TabsTrigger value="person">People</TabsTrigger>
              <TabsTrigger value="organization">Organizations</TabsTrigger>
            </TabsList>
            <TabsContent value="person">
              <PartyTable parties={ofKind('person')} noun="people" />
            </TabsContent>
            <TabsContent value="organization">
              <PartyTable parties={ofKind('organization')} noun="organizations" />
            </TabsContent>
          </Tabs>
        ) : (
          // listParties refuses only with FORBIDDEN: this request's role lacks contact:read (§6.2).
          <Alert>
            <AlertTitle>You do not have access to these people</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </WorkspaceShell>
  );
}
