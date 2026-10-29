import { ExternalLinkIcon } from 'lucide-react';
import { ArtistChips } from '@/components/catalog/artist-chips';
import { DetailList } from '@/components/catalog/detail-list';
import { ReadinessBadges } from '@/components/rights/readiness-badges';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { RecordingDTO } from '@/lib/dto/catalog';
import type { RecordingReadiness } from '@/lib/dto/rights';
import { formatIsrc, formatPlaybackTime } from '@/lib/identifiers';
import { words } from '@/lib/words';

/** A recording's title with its version title, if any. */
export const recordingTitle = ({ title, versionTitle }: RecordingDTO) =>
  versionTitle ? `${title} (${versionTitle})` : title;

type Props = {
  recording: RecordingDTO;
  readiness?: Pick<RecordingReadiness, 'oneStopReady' | 'syncReady'>;
};

/**
 * One of the song's recordings (§3.4): its readiness (§6.5), identifiers, musical details, links,
 * credits and terms.
 */
export function RecordingSection({ recording, readiness }: Props) {
  const { primaryLink, previewStartMs, isrc, durationMs } = recording;
  const title = recordingTitle(recording);
  const start = previewStartMs === null ? '' : ` · starts ${formatPlaybackTime(previewStartMs)}`;
  const credits = recording.contributors.map(
    ({ displayName, role, creditText }) => `${displayName} (${creditText ?? words(role)})`,
  );
  // CatalogService lists terms by type, then label.
  const terms = [...Map.groupBy(recording.terms, (term) => term.termType)].map(
    ([type, list]): [string, string] => [words(type), list.map(({ label }) => label).join(', ')],
  );
  const others = recording.links.filter((link) => !link.isPrimary);
  const otherLinks = others.map(({ id, url, label, linkType }) => (
    <a key={id} href={url} target="_blank" rel="noreferrer" className="mr-3 underline">
      {label ?? words(linkType)}
    </a>
  ));

  return (
    <section aria-label={title}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{title}</h2>
          </CardTitle>
          <ArtistChips artists={recording.artists} />
          {readiness ? <ReadinessBadges {...readiness} /> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {primaryLink ? (
            // D-8: the primary link opens its external player; AudioPlayer plays uploaded audio only.
            <a
              href={primaryLink.url}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', className: 'self-start' })}
            >
              {`Open player${start}`}
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          ) : null}
          <DetailList
            details={[
              ['ISRC', isrc && formatIsrc(isrc)],
              ['Duration', durationMs === null ? null : formatPlaybackTime(durationMs)],
              ['BPM', recording.bpm],
              ['Key', recording.musicalKey],
              ['Contributors', credits.join(', ')],
              ...terms,
              ['Other links', others.length === 0 ? null : otherLinks],
            ]}
          />
        </CardContent>
      </Card>
    </section>
  );
}
