import { DetailList } from '@/components/catalog/detail-list';
import { recordingTitle } from '@/components/catalog/recording-section';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { RecordingDTO, SongReleaseDTO } from '@/lib/dto/catalog';

type Props = { releases: SongReleaseDTO[]; recordings: RecordingDTO[] };

/** The live releases that carry the song's recordings (§3.4), one entry per track. */
export function ReleaseSection({ releases, recordings }: Props) {
  const titles = new Map(recordings.map((recording) => [recording.id, recordingTitle(recording)]));
  return (
    <section aria-label="Releases">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Releases</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {releases.length === 0 ? (
            <p className="text-muted-foreground">This song is not on a release yet.</p>
          ) : null}
          {releases.map((track) => (
            <div key={`${track.id}:${track.recordingId}`} className="flex flex-col gap-1">
              <h3 className="font-medium">{track.title}</h3>
              <DetailList
                details={[
                  ['Type', track.releaseType],
                  ['UPC/EAN', track.upcEan],
                  ['Release date', track.releaseDate],
                  // Which recording a release carries matters once the song has more than one.
                  ['Recording', recordings.length > 1 ? titles.get(track.recordingId) : null],
                  ['Disc', track.discNumber],
                  ['Track', track.trackNumber],
                ]}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
