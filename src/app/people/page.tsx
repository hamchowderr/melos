import { resolveWorkspacePage } from '@/app/workspace-page';
import { PartyForm } from '@/components/people/party-form';
import { PartyTable } from '@/components/people/party-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { listParties } from '@/server/services/contacts/read';
import { requirePermission } from '@/server/services/permissions';

export const dynamic = 'force-dynamic';

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
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-lg font-semibold">People and organizations</h1>
          {creates ? (
            <>
              <PartyForm kind="person" label="New person" />
              <PartyForm kind="organization" label="New organization" />
            </>
          ) : null}
        </div>
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
