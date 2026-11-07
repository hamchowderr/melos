import { notFound } from 'next/navigation';
import { resolveWorkspacePage } from '@/app/workspace-page';
import { ContactMethodsEditor } from '@/components/people/contact-methods-editor';
import { ContactPitches, pitchableSongs } from '@/components/people/contact-pitches';
import { CreatePitch } from '@/components/people/create-pitch';
import { DeleteParty } from '@/components/people/delete-party';
import { IdentityEditors } from '@/components/people/identity-editors';
import { PartyDetails } from '@/components/people/party-details';
import { PartyForm } from '@/components/people/party-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { listSongs } from '@/server/services/catalog/read';
import { getContact } from '@/server/services/contacts/contacts';
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
  const can = (action: 'update' | 'delete') =>
    requirePermission(workspace.tenant, { contact: [action] }).ok;
  // A contact's pitch history needs pitch:read; Create pitch needs pitch:create and the catalog.
  const contactId = party.ok ? party.value.contact?.contactId : undefined;
  const contact = contactId ? await getContact(workspace.tenant, contactId) : null;
  const songs = requirePermission(workspace.tenant, { pitch: ['create'] }).ok
    ? await listSongs(workspace.tenant)
    : null;
  const pitchable = songs?.ok ? pitchableSongs(songs.value) : null;

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="people">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
        {party.ok ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="mr-auto text-lg font-semibold">{party.value.displayName}</h1>
              {can('update') ? (
                <>
                  <PartyForm kind={party.value.partyKind} party={party.value} label="Edit" />
                  <ContactMethodsEditor party={party.value} />
                  <IdentityEditors party={party.value} />
                </>
              ) : null}
              {can('delete') ? (
                <DeleteParty partyId={party.value.partyId} displayName={party.value.displayName} />
              ) : null}
            </div>
            <PartyDetails party={party.value} />
            {contact?.ok ? (
              <ContactPitches
                contact={contact.value}
                create={
                  pitchable ? (
                    <CreatePitch contactId={contact.value.contactId} songs={pitchable} />
                  ) : null
                }
              />
            ) : null}
          </>
        ) : (
          // The other refusal is FORBIDDEN: this request's role lacks contact:read (§6.2).
          <Alert>
            <AlertTitle>You do not have access to these people</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </WorkspaceShell>
  );
}
