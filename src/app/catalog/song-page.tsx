import { notFound, redirect } from 'next/navigation';
import { resolveWorkspacePage } from '@/app/workspace-page';
import { CompositionSection } from '@/components/catalog/composition-section';
import { RecordingSection, recordingTitle } from '@/components/catalog/recording-section';
import { ReleaseSection } from '@/components/catalog/release-section';
import { RightsPanel } from '@/components/rights/rights-panel';
import { RightsSplitEditor } from '@/components/rights/rights-split-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import type { CatalogFocus } from '@/lib/dto/catalog';
import { getMusicWorkspace } from '@/server/services/catalog/music-workspace';
import { listParties } from '@/server/services/contacts/read';
import { requirePermission } from '@/server/services/permissions';
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
  // Edit shows only for rights:update (§6.2); the hash and people load only then.
  const { tenant } = workspace;
  const editable = song.ok && composition && requirePermission(tenant, { rights: ['update'] }).ok;
  const [hash, people] = editable
    ? await Promise.all([
        getWriterSharesHash(tenant, composition.id),
        listParties(tenant, { kind: 'person' }),
      ])
    : [];
  const writerEditor =
    song.ok && composition && hash?.ok && people?.ok ? (
      <RightsSplitEditor
        compositionId={composition.id}
        beforeHash={hash.value}
        writers={song.value.rights.writers}
        people={people.value.map(({ partyId, displayName }) => ({
          value: partyId,
          label: displayName,
        }))}
      />
    ) : undefined;

  return (
    <main>
      <WorkspaceHeader workspaceName={workspace.workspaceName} current="catalog" />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
        {song.ok ? (
          <>
            <h1 className="text-lg font-semibold">
              {composition?.title ?? song.value.recordings[0].title}
            </h1>
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
