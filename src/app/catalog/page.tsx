import { resolveWorkspacePage } from '@/app/workspace-page';
import { SearchResults } from '@/components/catalog/search-results';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { READINESS_FILTERS, type ReleaseListItem } from '@/lib/dto/catalog';
import { listSongs, normalizeTitle } from '@/server/services/catalog/read';
import { listReleases } from '@/server/services/catalog/releases';
import { READINESS, searchMusic } from '@/server/services/catalog/search';

export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<{ q?: string; readiness?: string }> };

/** The page's search: `q` cut to searchMusic's 200 characters, and a known readiness filter. */
async function searchOf(searchParams: Props['searchParams']) {
  const { q, readiness } = await searchParams;
  const query = typeof q === 'string' ? q.trim().slice(0, 200) : '';
  const filter = READINESS_FILTERS.find((known) => known === readiness);
  return { query, readiness: filter };
}

/**
 * The catalog (CAT-009): every song and release, or with `?q=` the songs searchMusic matches and
 * the releases whose title holds the query or that hold a matched song's recording; `?readiness=`
 * keeps the songs that pass the filter, and their releases.
 */
export default async function CatalogPage({ searchParams }: Props) {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const { query, readiness } = await searchOf(searchParams);
  // CatalogService checks catalog:read, and rights:read for readiness, for this request (§6.2).
  const [songs, releases] = await Promise.all([
    query
      ? searchMusic(workspace.tenant, { query, readiness, limit: 20 })
      : listSongs(workspace.tenant).then((listed) =>
          listed.ok && readiness
            ? { ...listed, value: listed.value.filter(READINESS[readiness]) }
            : listed,
        ),
    listReleases(workspace.tenant),
  ]);
  const shown = new Set(
    songs.ok ? songs.value.flatMap((song) => song.recordings.map((r) => r.recordingId)) : [],
  );
  const wanted = normalizeTitle(query);
  const matching = ({ title, recordingIds }: ReleaseListItem) =>
    (query === '' && readiness === undefined) ||
    (query !== '' && normalizeTitle(title).includes(wanted)) ||
    recordingIds.some((id) => shown.has(id));

  return (
    <main>
      <WorkspaceHeader workspaceName={workspace.workspaceName} current="catalog" />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
        <h1 className="text-lg font-semibold">Catalog</h1>
        {songs.ok && releases.ok ? (
          <SearchResults
            query={query}
            readiness={readiness}
            songs={songs.value}
            releases={releases.value.filter(matching)}
          />
        ) : (
          // The catalog reads refuse only with FORBIDDEN: this role lacks catalog:read (§6.2).
          <Alert>
            <AlertTitle>You do not have access to this catalog</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  );
}
