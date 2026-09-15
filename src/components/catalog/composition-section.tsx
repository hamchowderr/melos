import { DetailList } from '@/components/catalog/detail-list';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CompositionDTO } from '@/lib/dto/catalog';
import { formatIswc } from '@/lib/identifiers';

/** The song's composition (§3.4): titles, identifiers and copyright; lyrics show only as on file. */
export function CompositionSection({ composition }: { composition: CompositionDTO }) {
  const { iswc, description } = composition;
  return (
    <section aria-label="Composition">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Composition</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {description ? <p>{description}</p> : null}
          <DetailList
            details={[
              ['Also known as', composition.altTitles.join(', ')],
              ['ISWC', iswc && formatIswc(iswc)],
              ['Copyright registration', composition.copyrightRegistrationNumber],
              ['Copyright date', composition.copyrightDate],
              ['Lyrics', composition.hasLyrics ? 'On file' : null],
            ]}
          />
        </CardContent>
      </Card>
    </section>
  );
}
