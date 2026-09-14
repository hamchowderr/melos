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
          <TableHead className="text-right">Recordings</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {songs.map((song) => (
          <TableRow key={song.compositionId ?? song.primaryRecordingId}>
            <TableCell className="whitespace-normal">
              <span className="font-medium">{song.title}</span>
              {song.altTitles.length > 0 ? (
                <span className="block text-xs text-muted-foreground">
                  Also known as {song.altTitles.join(', ')}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="whitespace-normal">
              {song.primaryArtistNames.join(', ')}
            </TableCell>
            <TableCell className="text-right tabular-nums">{song.recordings.length}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
