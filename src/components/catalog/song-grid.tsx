'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ReadinessBadges } from '@/components/rights/readiness-badges';
import { buttonVariants } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { GridFrame } from '@/components/ui/grid-frame';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SongListItem } from '@/lib/dto/catalog';
import { formatIsrc, formatIswc } from '@/lib/identifiers';

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

const songKey = (song: SongListItem) => song.compositionId ?? song.primaryRecordingId;
const artistsOf = (song: SongListItem) => song.primaryArtistNames.join(', ');
const isrcsOf = (song: SongListItem) =>
  song.recordings.flatMap(({ isrc }) => (isrc ? [formatIsrc(isrc)] : [])).join(', ');

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

type SortKey = 'title' | 'artists' | 'recordings';
type Sort = { key: SortKey; descending: boolean } | null;

const SORTERS: Record<SortKey, (a: SongListItem, b: SongListItem) => number> = {
  title: (a, b) => a.title.localeCompare(b.title),
  artists: (a, b) => artistsOf(a).localeCompare(artistsOf(b)),
  recordings: (a, b) => a.recordings.length - b.recordings.length,
};

/** A column heading that sorts the grid; a third click returns to CatalogService's order. */
function SortHead({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: Sort;
  onSort: (sort: Sort) => void;
  className?: string;
}) {
  const active = sort?.key === column;
  const Icon = !active ? ArrowUpDown : sort.descending ? ArrowDown : ArrowUp;
  const next: Sort = !active
    ? { key: column, descending: false }
    : sort.descending
      ? null
      : { key: column, descending: true };
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(next)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        <Icon className="size-3" aria-hidden />
      </button>
    </TableHead>
  );
}

/** One song's summary in the side panel, with the way to its full page. */
function SongPanel({ song, onClose }: { song: SongListItem | null; onClose: () => void }) {
  return (
    <Sheet open={song !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent>
        {song ? (
          <>
            <SheetHeader className="border-b">
              <SheetTitle>{song.title}</SheetTitle>
              <SheetDescription>{artistsOf(song) || 'No primary artist'}</SheetDescription>
            </SheetHeader>
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4">
              <dt className="text-muted-foreground">Readiness</dt>
              <dd>
                <ReadinessBadges {...songReadiness(song)} />
              </dd>
              <dt className="text-muted-foreground">ISWC</dt>
              <dd className="tabular-nums">{song.iswc ? formatIswc(song.iswc) : '—'}</dd>
              <dt className="text-muted-foreground">Also known as</dt>
              <dd>{song.altTitles.join(', ') || '—'}</dd>
              <dt className="text-muted-foreground">Recordings</dt>
              <dd>
                <ul className="flex flex-col gap-1">
                  {song.recordings.map((recording) => (
                    <li key={recording.recordingId}>
                      {recording.title}
                      {recording.versionTitle ? ` (${recording.versionTitle})` : ''}
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {recording.isrc ? formatIsrc(recording.isrc) : 'No ISRC'}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
            <SheetFooter className="border-t">
              <Link href={songHref(song)} className={buttonVariants()}>
                Open song
              </Link>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** The catalog's songs (§2.3, CAT-009), in the order CatalogService lists them until sorted. */
export function SongGrid({ songs }: { songs: SongListItem[] }) {
  const [sort, setSort] = useState<Sort>(null);
  const [open, setOpen] = useState<SongListItem | null>(null);
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

  const sorted = sort
    ? [...songs].sort((a, b) => SORTERS[sort.key](a, b) * (sort.descending ? -1 : 1))
    : songs;
  return (
    <>
      {/* Phone width: one card per song, so no column is cut off. */}
      <ul aria-label="Songs" className="flex flex-col gap-2 sm:hidden">
        {songs.map((song) => (
          <li key={songKey(song)} className="flex flex-col gap-1.5 rounded-lg border p-3">
            <SongTitle song={song} />
            <p className="text-sm">
              {artistsOf(song)}
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
      <GridFrame className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead label="Title" column="title" sort={sort} onSort={setSort} />
              <SortHead label="Primary artists" column="artists" sort={sort} onSort={setSort} />
              <TableHead>ISWC</TableHead>
              <TableHead>ISRC</TableHead>
              <TableHead>Readiness</TableHead>
              <SortHead
                label="Recordings"
                column="recordings"
                sort={sort}
                onSort={setSort}
                className="text-right"
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((song) => (
              <TableRow
                key={songKey(song)}
                className="cursor-pointer"
                // A click anywhere but the title link opens the side panel.
                onClick={(event) => {
                  if (!(event.target as HTMLElement).closest('a,button')) setOpen(song);
                }}
              >
                <TableCell className="whitespace-normal">
                  <SongTitle song={song} />
                </TableCell>
                <TableCell className="whitespace-normal">{artistsOf(song)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {song.iswc ? formatIswc(song.iswc) : ''}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {isrcsOf(song)}
                </TableCell>
                <TableCell>
                  <ReadinessBadges {...songReadiness(song)} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{song.recordings.length}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </GridFrame>
      <SongPanel song={open} onClose={() => setOpen(null)} />
    </>
  );
}
