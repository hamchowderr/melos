import { notFound, redirect } from 'next/navigation';
import { resolveWorkspacePage } from '@/app/workspace-page';
import { CompositionSection } from '@/components/catalog/composition-section';
import { DeleteSong } from '@/components/catalog/delete-song';
import { MetadataPanel } from '@/components/catalog/metadata-panel';
import { RecordingSection, recordingTitle } from '@/components/catalog/recording-section';
import { ReleaseSection } from '@/components/catalog/release-section';
import { HolderSplitEditor } from '@/components/rights/holder-split-editor';
import { LicensingContactsEditor } from '@/components/rights/licensing-contacts-editor';
import { PublishingEditor } from '@/components/rights/publishing-editor';
import { RightsPanel } from '@/components/rights/rights-panel';
import { RightsSplitEditor } from '@/components/rights/rights-split-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import type { CatalogFocus } from '@/lib/dto/catalog';
import { getMusicWorkspace } from '@/server/services/catalog/music-workspace';
import { listParties } from '@/server/services/contacts/read';
import { requirePermission } from '@/server/services/permissions';
import { listAgreements } from '@/server/services/rights/agreements';
import { getHolderSharesHashes } from '@/server/services/rights/holder-shares';
import { getWriterSharesHash } from '@/server/services/rights/shares';

/**
 * A song's page (§2.3 MusicWorkspaceCard, D-12) for the composition or recording id in its route.
 * A recording that belongs to a composition opens that composition's page instead.
 */
export async function SongPage({ focus }: { focus: CatalogFocus }) {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  // getMusicWorkspace checks catalog, rights and pitch read (§6.2) and looks the id up in this
  // workspace's database only.
  const song = await getMusicWorkspace(workspace.tenant, focus);
  if (!song.ok && song.error.code === 'NOT_FOUND') notFound();
  const composition = song.ok ? song.value.composition : null;
  const readiness = new Map(song.ok ? song.value.readiness.map((r) => [r.recordingId, r]) : []);
  if (focus.entityType === 'recording' && composition) {
    redirect(`/catalog/compositions/${composition.id}`);
  }
  // Edit and Delete show only for catalog:update and catalog:delete (§6.2).
  const can = (action: 'update' | 'delete') =>
    requirePermission(workspace.tenant, { catalog: [action] }).ok;
  // The editors show only for rights:update (§6.2); hashes, parties and agreements load only then.
  const { tenant } = workspace;
  const editable = song.ok && requirePermission(tenant, { rights: ['update'] }).ok;
  const recordingIds = song.ok ? song.value.recordings.map(({ id }) => id) : [];
  const [hash, hashes, everyone, agreements] = editable
    ? await Promise.all([
        composition ? getWriterSharesHash(tenant, composition.id) : null,
        getHolderSharesHashes(tenant, { compositionId: composition?.id ?? null, recordingIds }),
        listParties(tenant),
        listAgreements(tenant),
      ])
    : [];
  const option = ({ partyId, displayName }: { partyId: string; displayName: string }) => ({
    value: partyId,
    label: displayName,
  });
  const parties = everyone?.ok ? everyone.value.map(option) : [];
  const people = everyone?.ok
    ? everyone.value.filter((p) => p.partyKind === 'person').map(option)
    : [];
  const options = {
    parties,
    agreements: agreements?.ok
      ? agreements.value.map(({ id, title }) => ({ value: id, label: title }))
      : [],
  };
  const writerEditor =
    song.ok && composition && hash?.ok && everyone?.ok ? (
      <RightsSplitEditor
        compositionId={composition.id}
        beforeHash={hash.value}
        writers={song.value.rights.writers}
        people={people}
      />
    ) : undefined;
  const publishingEditor =
    song.ok && composition && hashes?.ok && everyone?.ok ? (
      <PublishingEditor
        {...options}
        compositionId={composition.id}
        publishing={song.value.rights.publishing}
        hashes={hashes.value}
      />
    ) : undefined;
  const masterEditors = new Map(
    song.ok && hashes?.ok && everyone?.ok
      ? song.value.rights.masters.map(({ recordingId, holders }) => [
          recordingId,
          <HolderSplitEditor
            key={recordingId}
            {...options}
            target={{ side: 'master', recordingId }}
            label="Edit master"
            beforeHash={hashes.value.masters[recordingId] ?? hashes.value.empty}
            holders={holders}
          />,
        ])
      : [],
  );

  const target = composition
    ? { compositionId: composition.id }
    : { recordingId: recordingIds[0] ?? '' };
  const contactsEditor =
    song.ok && everyone?.ok ? (
      <LicensingContactsEditor
        target={target}
        contacts={song.value.rights.licensingContacts}
        parties={parties}
      />
    ) : undefined;

  return (
    <main>
      <WorkspaceHeader workspaceName={workspace.workspaceName} current="catalog" />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
        {song.ok ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="mr-auto text-lg font-semibold">
                {composition?.title ?? song.value.recordings[0].title}
              </h1>
              {composition && can('update') ? (
                <MetadataPanel key={JSON.stringify(composition)} composition={composition} />
              ) : null}
              {composition && can('delete') ? (
                <DeleteSong compositionId={composition.id} title={composition.title} />
              ) : null}
            </div>
            {composition ? <CompositionSection composition={composition} /> : null}
            {song.value.recordings.map((recording) => (
              <RecordingSection
                key={recording.id}
                recording={recording}
                readiness={readiness.get(recording.id)}
              />
            ))}
            <RightsPanel
              rights={song.value.rights}
              recordingTitles={new Map(song.value.recordings.map((r) => [r.id, recordingTitle(r)]))}
              writerEditor={writerEditor}
              publishingEditor={publishingEditor}
              masterEditors={masterEditors}
              representable={Boolean(editable)}
              contactsEditor={contactsEditor}
            />
            <ReleaseSection releases={song.value.releases} recordings={song.value.recordings} />
          </>
        ) : (
          // The other refusal is FORBIDDEN: this request's role lacks a read it needs (§6.2).
          <Alert>
            <AlertTitle>You do not have access to this catalog</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  );
}
