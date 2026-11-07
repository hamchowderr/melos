import Link from 'next/link';
import { songHref } from '@/components/catalog/song-grid';
import { ToolCard } from '@/components/chat/tool-card';
import { ReadinessBadges } from '@/components/rights/readiness-badges';
import type { MusicSearchResult } from '@/lib/dto/catalog';
import { formatIswc } from '@/lib/identifiers';

/** searchMusic's SongGrid (§3.3): one row per song with its artists, ISWC and readiness. */
export function SongResults({ results }: { results: MusicSearchResult[] }) {
  const title = 'Song Search Results';
  if (results.length === 0) {
    return (
      <ToolCard title={title}>
        <p className="px-4 pb-3 text-muted-foreground">No songs matched.</p>
      </ToolCard>
    );
  }
  return (
    <ToolCard title={title}>
      <ul aria-label="Songs" className="flex flex-col">
        {results.map((song) => {
          const primary =
            song.recordings.find((r) => r.recordingId === song.primaryRecordingId) ??
            song.recordings[0];
          return (
            <li
              key={song.compositionId ?? song.recordings[0]?.recordingId}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 odd:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={songHref(song)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {song.title}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {song.primaryArtistNames.join(', ') || 'No artist'}
                  {song.iswc ? ` · ISWC ${formatIswc(song.iswc)}` : ''}
                  {song.recordings.length > 1 ? ` · ${song.recordings.length} recordings` : ''}
                </p>
              </div>
              {primary ? <ReadinessBadges {...primary} /> : null}
            </li>
          );
        })}
      </ul>
    </ToolCard>
  );
}
