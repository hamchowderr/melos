import { resolveWorkspacePage } from '@/app/workspace-page';
import { PartyTable } from '@/components/people/party-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { listParties } from '@/server/services/contacts/read';

export const dynamic = 'force-dynamic';

export default async function PeoplePage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  // ContactService checks contact:read for the role resolved for this request (§6.2, D-5).
  const parties = await listParties(workspace.tenant);
  const ofKind = (kind: string) =>
    parties.ok ? parties.value.filter(({ partyKind }) => partyKind === kind) : [];

  return (
    <main>
      <WorkspaceHeader workspaceName={workspace.workspaceName} current="people" />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
        <h1 className="text-lg font-semibold">People and organizations</h1>
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
    </main>
  );
}
