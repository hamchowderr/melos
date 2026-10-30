import Link from 'next/link';
import { ReadinessBadges } from '@/components/rights/readiness-badges';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SongListItem } from '@/lib/dto/catalog';

/** A song's page (D-12): its composition's, or its only recording's when it has no composition. */
const songHref = ({ compositionId, recordings }: SongListItem) =>
  compositionId
    ? `/catalog/compositions/${compositionId}`
    : `/catalog/recordings/${recordings[0].recordingId}`;

/** A song is ready when every one of its live recordings is (§6.5). */
const songReadiness = ({ recordings }: SongListItem) => ({
  oneStopReady: recordings.every(({ oneStopReady }) => oneStopReady),
  syncReady: recordings.every(({ syncReady }) => syncReady),
});

/** A song's title, linked to its page, with any alternate titles under it. */
function SongTitle({ song }: { song: SongListItem }) {
  return (
    <>
      <Link href={songHref(song)} className="font-medium underline-offset-4 hover:underline">
        {song.title}
      </Link>
      {song.altTitles.length > 0 ? (
        <span className="block text-xs text-muted-foreground">
          Also known as {song.altTitles.join(', ')}
        </span>
      ) : null}
    </>
  );
}

const songKey = (song: SongListItem) => song.compositionId ?? song.primaryRecordingId;

/** The catalog's songs (§2.3, CAT-009), in the order CatalogService lists them. */
export function SongGrid({ songs }: { songs: SongListItem[] }) {
  if (songs.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No songs yet</EmptyTitle>
          <EmptyDescription>Songs in this workspace are listed here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      {/* Phone width: one card per song, so the Recordings column isn't cut off. */}
      <ul aria-label="Songs" className="flex flex-col gap-2 sm:hidden">
        {songs.map((song) => (
          <li key={songKey(song)} className="flex flex-col gap-1.5 rounded-lg border p-3">
            <SongTitle song={song} />
            <p className="text-sm">
              {song.primaryArtistNames.join(', ')}
              <span className="text-muted-foreground">
                {' · '}
                {song.recordings.length === 1
                  ? '1 recording'
                  : `${song.recordings.length} recordings`}
              </span>
            </p>
            <ReadinessBadges {...songReadiness(song)} />
          </li>
        ))}
      </ul>
      <Table className="hidden sm:table">
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Primary artists</TableHead>
            <TableHead>Readiness</TableHead>
            <TableHead className="text-right">Recordings</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {songs.map((song) => (
            <TableRow key={songKey(song)}>
              <TableCell className="whitespace-normal">
                <SongTitle song={song} />
              </TableCell>
              <TableCell className="whitespace-normal">
                {song.primaryArtistNames.join(', ')}
              </TableCell>
              <TableCell>
                <ReadinessBadges {...songReadiness(song)} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{song.recordings.length}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
