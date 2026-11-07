import type { MusicWorkspaceDTO, RecordingDTO } from '../../../lib/dto/catalog';
import { REPORT_SECTIONS, type ReportSectionId } from '../../../lib/dto/reports';

/** One song's facts for a report block: its workspace, the recording shown, and its lyrics. */
export type ReportSong = {
  song: MusicWorkspaceDTO;
  recordingId: string | null;
  lyrics: string | null;
};

type Line = [label: string, value: string | number | null | undefined];

const percent = (bp: number) => `${Number((bp / 100).toFixed(2))}%`;
const list = (values: (string | null | undefined)[]) =>
  values.filter((value): value is string => Boolean(value)).join(', ') || null;
const clock = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const lines = (rows: Line[]) =>
  rows
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => `${label}: ${value}`);
const termsOf = (recording: RecordingDTO | undefined, type: string) =>
  list(recording?.terms.filter((term) => term.termType === type).map((term) => term.label) ?? []);
/** Values grouped by key, keys in first-seen order. */
const grouped = (pairs: [string, string][]) => {
  const groups = new Map<string, string[]>();
  for (const [key, value] of pairs) groups.set(key, [...(groups.get(key) ?? []), value]);
  return [...groups].map(([key, values]): Line => [key, values.join(', ')]);
};
const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, ' ');

/** A section's heading and body lines, in §6.12 order; an empty section prints nothing. */
function sectionLines(id: ReportSectionId, { song, recordingId, lyrics }: ReportSong): string[] {
  const { composition, rights } = song;
  const recording = song.recordings.find((row) => row.id === recordingId);
  const readiness = song.readiness.find((row) => row.recordingId === recordingId);
  switch (id) {
    case 'core':
      return lines([
        ['Alternate titles', list(composition?.altTitles ?? [])],
        ['Version', recording?.versionTitle],
        [
          'Artists',
          list(
            recording?.artists.map((a) =>
              a.role === 'featured' ? `feat. ${a.displayName}` : a.displayName,
            ) ?? [],
          ),
        ],
        ['BPM', recording?.bpm],
        ['Key', recording?.musicalKey],
        ['Duration', recording?.durationMs ? clock(recording.durationMs) : null],
        ['Genre', termsOf(recording, 'genre')],
        ['Description', composition?.description],
      ]);
    case 'rights':
      return lines([
        [
          'Writers',
          list(
            rights.writers.map(
              (w) => `${w.displayName}${w.shareBp === null ? '' : ` ${percent(w.shareBp)}`}`,
            ),
          ),
        ],
        ...rights.publishing.map(
          ({ territory, holders }): Line => [
            `Publishing (${territory})`,
            list(holders.map((h) => `${h.displayName} ${percent(h.shareBp)}`)),
          ],
        ),
        [
          'Master',
          list(
            rights.masters
              .filter((m) => m.recordingId === recordingId)
              .flatMap((m) => m.holders.map((h) => `${h.displayName} ${percent(h.shareBp)}`)),
          ),
        ],
      ]);
    case 'creators':
      return lines(
        grouped(
          (recording?.contributors ?? []).map((c): [string, string] => [
            roleLabel(c.role),
            c.creditText ? `${c.displayName} (${c.creditText})` : c.displayName,
          ]),
        ),
      );
    case 'composition':
      return lines([
        ['ISWC', composition?.iswc],
        ['Copyright registration', composition?.copyrightRegistrationNumber],
        ['Copyright date', composition?.copyrightDate],
        ...(composition?.registrations ?? []).map(
          (r): Line => [
            `Registration (${r.societyCode ?? r.registryKind.toUpperCase()})`,
            list([r.workCode, r.status, r.registeredOn]),
          ],
        ),
      ]);
    case 'recording':
      return lines([
        ['ISRC', recording?.isrc],
        ...song.releases
          .filter((release) => release.recordingId === recordingId)
          .map(
            (release): Line => [
              'Release',
              list([
                release.title,
                release.releaseType,
                release.releaseDate,
                release.upcEan && `UPC ${release.upcEan}`,
              ]),
            ],
          ),
        ...(recording?.registrations ?? []).map(
          (r): Line => [
            `Registration (${r.registryKind === 'soundexchange' ? 'SoundExchange' : 'other'})`,
            list([r.registrationCode, r.status, r.registeredOn]),
          ],
        ),
      ]);
    case 'metadata':
      return lines([
        ['Moods', termsOf(recording, 'mood')],
        ['Instruments', termsOf(recording, 'instrument')],
        ['Keywords', termsOf(recording, 'keyword')],
        ['Sounds like', termsOf(recording, 'sounds_like')],
      ]);
    case 'listen': {
      const link = recording?.primaryLink;
      const start = recording?.previewStartMs;
      return lines([['Link', link && (start ? `${link.url} (from ${clock(start)})` : link.url)]]);
    }
    case 'licensing':
      return lines([
        ['Licensing contacts', list(rights.licensingContacts.map((c) => c.displayName))],
        ['One-stop', readiness ? (readiness.oneStopReady ? 'yes' : 'no') : null],
      ]);
    case 'lyrics':
      return lyrics?.trim() ? [lyrics.trim()] : [];
  }
}

const HEADINGS: Record<ReportSectionId, string | null> = {
  ...{ core: null, rights: 'Rights', creators: 'Creators', composition: 'Composition' },
  ...{ recording: 'Recording', metadata: 'Metadata', listen: 'Listen', licensing: 'Licensing' },
  lyrics: 'Lyrics',
};

/** One song block: its title, then each enabled, non-empty section in §6.12 order. */
export function renderSong(item: ReportSong, enabled: ReadonlySet<ReportSectionId>): string {
  const recording = item.song.recordings.find((row) => row.id === item.recordingId);
  const title = item.song.composition?.title ?? recording?.title ?? '';
  const blocks = REPORT_SECTIONS.filter((id) => enabled.has(id)).flatMap((id) => {
    const body = sectionLines(id, item);
    if (!body.length) return [];
    const heading = HEADINGS[id];
    return [(heading ? [heading, ...body] : body).join('\n')];
  });
  return [title, ...blocks].join('\n\n');
}

/** The report text: song blocks in item order, separated by a rule (RPT-005). */
export const renderReport = (items: ReportSong[], enabled: ReadonlySet<ReportSectionId>) =>
  items.map((item) => renderSong(item, enabled)).join('\n\n---\n\n');
