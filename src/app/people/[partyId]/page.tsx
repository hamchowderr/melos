import { notFound } from 'next/navigation';
import { resolveWorkspacePage } from '@/app/workspace-page';
import { PartyDetails } from '@/components/people/party-details';
import { PartyForm } from '@/components/people/party-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { getParty } from '@/server/services/contacts/read';
import { requirePermission } from '@/server/services/permissions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ partyId: string }> };

export default async function PartyPage({ params }: Props) {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const { partyId } = await params;
  // ContactService checks contact:read (§6.2, D-5) and looks the id up in this workspace's database only.
  const party = await getParty(workspace.tenant, partyId);
  if (!party.ok && party.error.code === 'NOT_FOUND') notFound();
  // Edit controls follow the §6.2 roles; the services check them again on save.
  const editable = requirePermission(workspace.tenant, { contact: ['update'] }).ok;

  return (
    <main>
      <WorkspaceHeader workspaceName={workspace.workspaceName} current="people" />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
        {party.ok ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="mr-auto text-lg font-semibold">{party.value.displayName}</h1>
              {editable ? (
                <PartyForm kind={party.value.partyKind} party={party.value} label="Edit" />
              ) : null}
            </div>
            <PartyDetails party={party.value} />
          </>
        ) : (
          // The other refusal is FORBIDDEN: this request's role lacks contact:read (§6.2).
          <Alert>
            <AlertTitle>You do not have access to these people</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  );
}
