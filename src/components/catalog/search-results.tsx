import { SongGrid } from '@/components/catalog/song-grid';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { GridFrame } from '@/components/ui/grid-frame';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { READINESS_FILTERS, type ReleaseListItem, type SongListItem } from '@/lib/dto/catalog';
import { words } from '@/lib/words';

type Readiness = (typeof READINESS_FILTERS)[number];

type Props = {
  query: string;
  readiness: Readiness | undefined;
  songs: SongListItem[];
  releases: ReleaseListItem[];
};

const LABELS: Record<Readiness, string> = {
  one_stop_ready: 'One Stop Ready',
  not_one_stop_ready: 'Not one-stop ready',
  sync_ready: 'Sync ready',
  not_sync_ready: 'Not sync ready',
};

/** The /catalog search box: a GET form, so a search is a shareable URL and works without script. */
function SearchForm({ query, readiness }: Pick<Props, 'query' | 'readiness'>) {
  return (
    <search aria-label="Catalog">
      <form method="get" className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={query}
          maxLength={200}
          aria-label="Search songs"
          placeholder="Title, artist, writer or lyric"
          className="min-w-48 flex-1 sm:max-w-sm"
        />
        <NativeSelect
          name="readiness"
          defaultValue={readiness ?? ''}
          aria-label="Readiness"
          className="w-auto"
        >
          <NativeSelectOption value="">Any readiness</NativeSelectOption>
          {READINESS_FILTERS.map((filter) => (
            <NativeSelectOption key={filter} value={filter}>
              {LABELS[filter]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
    </search>
  );
}

/** The releases in the list, by title (CAT-007); a release has no page of its own yet. */
function ReleaseList({ releases }: { releases: ReleaseListItem[] }) {
  if (releases.length === 0) return <p className="text-sm text-muted-foreground">No releases</p>;
  return (
    <GridFrame>
      <Table aria-label="Releases">
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Release date</TableHead>
            <TableHead className="text-right">Tracks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {releases.map((release) => (
            <TableRow key={release.id}>
              <TableCell className="whitespace-normal font-medium">{release.title}</TableCell>
              <TableCell>{release.releaseType ? words(release.releaseType) : ''}</TableCell>
              <TableCell className="tabular-nums">{release.releaseDate ?? ''}</TableCell>
              <TableCell className="text-right tabular-nums">
                {release.recordingIds.length}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </GridFrame>
  );
}

/**
 * The /catalog list and its search (§2.3 SearchResults, CAT-009): the songs in SongGrid, or the
 * empty state when a search matches none, then the Releases section.
 */
export function SearchResults({ query, readiness, songs, releases }: Props) {
  const searching = query !== '' || readiness !== undefined;
  return (
    <div className="flex flex-col gap-5">
      <SearchForm query={query} readiness={readiness} />
      <section aria-label="Songs" className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Songs</h2>
        {searching && songs.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No matching songs</EmptyTitle>
              <EmptyDescription>Try another title, name or readiness.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SongGrid songs={songs} />
        )}
      </section>
      <section aria-label="Releases" className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Releases
        </h2>
        <ReleaseList releases={releases} />
      </section>
    </div>
  );
}
