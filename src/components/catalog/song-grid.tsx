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
    <Table>
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
          <TableRow key={song.compositionId ?? song.primaryRecordingId}>
            <TableCell className="whitespace-normal">
              <Link
                href={songHref(song)}
                className="font-medium underline-offset-4 hover:underline"
              >
                {song.title}
              </Link>
              {song.altTitles.length > 0 ? (
                <span className="block text-xs text-muted-foreground">
                  Also known as {song.altTitles.join(', ')}
                </span>
              ) : null}
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
  );
}
