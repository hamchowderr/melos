import { notFound, redirect } from 'next/navigation';
import { resolveWorkspacePage } from '@/app/workspace-page';
import { CompositionSection } from '@/components/catalog/composition-section';
import { RecordingSection } from '@/components/catalog/recording-section';
import { ReleaseSection } from '@/components/catalog/release-section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import type { CatalogFocus } from '@/lib/dto/catalog';
import { getSongCatalog } from '@/server/services/catalog/read';

/**
 * A song's page (§2.3 MusicWorkspaceCard, D-12) for the composition or recording id in its route.
 * A recording that belongs to a composition opens that composition's page instead.
 */
export async function SongPage({ focus }: { focus: CatalogFocus }) {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  // CatalogService checks catalog:read (§6.2) and looks the id up in this workspace's database only.
  const song = await getSongCatalog(workspace.tenant, focus);
  if (!song.ok && song.error.code === 'NOT_FOUND') notFound();
  const composition = song.ok ? song.value.composition : null;
  if (focus.entityType === 'recording' && composition) {
    redirect(`/catalog/compositions/${composition.id}`);
  }

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
              <RecordingSection key={recording.id} recording={recording} />
            ))}
            <ReleaseSection releases={song.value.releases} recordings={song.value.recordings} />
          </>
        ) : (
          // The other refusal is FORBIDDEN: this request's role lacks catalog:read (§6.2).
          <Alert>
            <AlertTitle>You do not have access to this catalog</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  );
}
