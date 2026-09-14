import { resolveWorkspacePage } from '@/app/workspace-page';
import { SongGrid } from '@/components/catalog/song-grid';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { listSongs } from '@/server/services/catalog/read';

export const dynamic = 'force-dynamic';

export default async function CatalogPage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  // CatalogService checks catalog:read for the role resolved for this request (§6.2).
  const songs = await listSongs(workspace.tenant);

  return (
    <main>
      <WorkspaceHeader workspaceName={workspace.workspaceName} current="catalog" />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
        <h1 className="text-lg font-semibold">Catalog</h1>
        {songs.ok ? (
          <SongGrid songs={songs.value} />
        ) : (
          // listSongs refuses only with FORBIDDEN: this request's role lacks catalog:read (§6.2).
          <Alert>
            <AlertTitle>You do not have access to this catalog</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  );
}
