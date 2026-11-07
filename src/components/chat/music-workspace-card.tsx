import Link from 'next/link';
import { ToolCard } from '@/components/chat/tool-card';
import { ReadinessBadges } from '@/components/rights/readiness-badges';
import type { MusicWorkspaceDTO } from '@/lib/dto/catalog';
import { formatIsrc, formatIswc } from '@/lib/identifiers';
import { formatShare } from '@/lib/shares';

const workspaceHref = ({ composition, recordings }: MusicWorkspaceDTO) =>
  composition
    ? `/catalog/compositions/${composition.id}`
    : `/catalog/recordings/${recordings[0]?.id}`;

/** A detail line that keeps quiet labels beside its values. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** getMusicWorkspace's MusicWorkspaceCard (§3.3): identifiers, recordings, writers and pitches. */
export function MusicWorkspaceCard({ workspace }: { workspace: MusicWorkspaceDTO }) {
  const { composition, recordings, releases, rights, readiness, pitchSummary } = workspace;
  const title = composition?.title ?? recordings[0]?.title ?? 'Untitled';
  const flags = new Map(readiness.map((entry) => [entry.recordingId, entry]));
  const artists = [
    ...new Set(
      recordings.flatMap((r) =>
        r.artists.filter((a) => a.role === 'primary').map((a) => a.displayName),
      ),
    ),
  ];

  return (
    <ToolCard title="Song">
      <div className="flex items-start justify-between gap-3 px-4 pb-2">
        <div className="min-w-0">
          <p className="text-base font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{artists.join(', ') || 'No artist'}</p>
        </div>
        <Link
          href={workspaceHref(workspace)}
          className="shrink-0 rounded-md bg-muted px-2.5 py-1 text-xs font-medium hover:bg-muted/70"
        >
          Open Song
        </Link>
      </div>
      <dl className="flex flex-col gap-1 px-4 pb-3 text-sm">
        {composition ? (
          <Fact label="ISWC">{composition.iswc ? formatIswc(composition.iswc) : '—'}</Fact>
        ) : null}
        <Fact label="Writers">
          {rights.writers.length > 0
            ? rights.writers
                .map((w) =>
                  w.shareBp === null ? w.displayName : `${w.displayName} ${formatShare(w.shareBp)}`,
                )
                .join(', ')
            : 'None yet'}
        </Fact>
        <Fact label="Releases">
          {releases.length > 0 ? releases.map((release) => release.title).join(', ') : 'None'}
        </Fact>
        <Fact label="Pitches">
          {pitchSummary.itemCount > 0 ? `${pitchSummary.itemCount} pitched` : 'Not pitched yet'}
        </Fact>
      </dl>
      <ul aria-label="Recordings" className="flex flex-col">
        {recordings.map((recording) => {
          const flag = flags.get(recording.id);
          return (
            <li
              key={recording.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-muted/30 px-4 py-2 not-last:mb-px"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {recording.title}
                  {recording.versionTitle ? ` (${recording.versionTitle})` : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  ISRC {recording.isrc ? formatIsrc(recording.isrc) : '—'}
                  {recording.primaryLink ? (
                    <>
                      {' · '}
                      <a
                        href={recording.primaryLink.url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline-offset-4 hover:underline"
                      >
                        Listen
                      </a>
                    </>
                  ) : null}
                </p>
              </div>
              {flag ? <ReadinessBadges {...flag} /> : null}
            </li>
          );
        })}
      </ul>
    </ToolCard>
  );
}
