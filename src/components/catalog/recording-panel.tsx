'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  checkRecordingDuplicates,
  saveNewRecording,
  saveRecording,
} from '@/app/catalog/recording-actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { RecordingDTO, RecordingDuplicate, RecordingPatch } from '@/lib/dto/catalog';
import { formatIsrc, formatPlaybackTime } from '@/lib/identifiers';

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow this change.',
  NOT_FOUND: 'This song or recording no longer exists. Reload the page.',
  VALIDATION: 'Check the fields: a title is required, and times look like 3:15.',
  INVALID_ISRC: 'The ISRC is not valid. It looks like US-DMO-26-00009.',
  CONFLICT: 'Another recording already holds this ISRC.',
};

const FIELDS = [
  ['title', 'Title'],
  ['versionTitle', 'Version'],
  ['isrc', 'ISRC'],
  ['duration', 'Duration'],
  ['bpm', 'BPM'],
  ['musicalKey', 'Key'],
  ['previewStart', 'Preview start'],
] as const;

type Key = (typeof FIELDS)[number][0];
type Values = Record<Key, string>;
const TIMES: Key[] = ['duration', 'previewStart'];

const time = (ms: number | null) => (ms === null ? '' : formatPlaybackTime(ms));
const valuesOf = (recording?: RecordingDTO, title = ''): Values => ({
  title: recording?.title ?? title,
  versionTitle: recording?.versionTitle ?? '',
  isrc: recording?.isrc ? formatIsrc(recording.isrc) : '',
  duration: time(recording?.durationMs ?? null),
  bpm: recording?.bpm?.toString() ?? '',
  musicalKey: recording?.musicalKey ?? '',
  previewStart: time(recording?.previewStartMs ?? null),
});

/** m:ss as milliseconds, null for blank, or NaN, which the service refuses as VALIDATION. */
function msOf(text: string): number | null {
  if (!text) return null;
  const match = /^(\d+):([0-5]\d)$/.exec(text);
  return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : Number.NaN;
}

/** The fields that differ from `initial`, as a patch: blank clears. */
function patchOf(values: Values, initial: Values): RecordingPatch {
  const patch: Record<string, unknown> = {};
  for (const [key] of FIELDS) {
    const value = values[key].trim();
    if (value === initial[key].trim()) continue;
    if (TIMES.includes(key))
      patch[key === 'duration' ? 'durationMs' : 'previewStartMs'] = msOf(value);
    else if (key === 'bpm') patch.bpm = value ? Number(value) : null;
    else patch[key] = value || null;
  }
  return patch as RecordingPatch;
}

type Props = { compositionId: string; songTitle: string; recording?: RecordingDTO };

/**
 * Adds a recording to a song (CAT-002) or edits `recording` (CAT-004) in a Dialog: MetadataPanel's
 * recording mode. Before a new one saves, live recordings with the same ISRC, or the same title and
 * version on this song, show as a possible duplicate (§6.15) that never blocks the save.
 */
export function RecordingPanel({ compositionId, songTitle, recording }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [initial] = useState(() => valuesOf(recording, songTitle));
  const [values, setValues] = useState(initial);
  const [matches, setMatches] = useState<RecordingDuplicate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = recording?.id ?? 'new';

  const check = () => {
    if (recording) return;
    const { title, versionTitle, isrc } = values;
    const query = { compositionId, title, versionTitle: versionTitle || null, isrc: isrc || null };
    checkRecordingDuplicates(query).then(setMatches, () => setMatches([]));
  };
  const save = () =>
    startTransition(async () => {
      setError(null);
      const patch = patchOf(values, valuesOf());
      const result = await (recording
        ? saveRecording(recording.id, patchOf(values, initial))
        : saveNewRecording({ ...patch, compositionId, title: values.title })
      ).catch(() => null);
      if (!result?.ok) return setError((result && REFUSED[result.code]) || 'Could not save.');
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="self-start" />}>
        {recording ? 'Edit recording' : 'Add recording'}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{recording ? 'Edit recording' : 'Add recording'}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            {FIELDS.map(([key, name]) => (
              <Field key={key}>
                <FieldLabel htmlFor={`recording-${id}-${key}`}>{name}</FieldLabel>
                <Input
                  id={`recording-${id}-${key}`}
                  required={key === 'title'}
                  inputMode={key === 'bpm' ? 'numeric' : undefined}
                  value={values[key]}
                  onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                  onBlur={key === 'isrc' || key === 'versionTitle' ? check : undefined}
                />
                {TIMES.includes(key) ? (
                  <FieldDescription>Minutes and seconds, such as 3:15.</FieldDescription>
                ) : null}
              </Field>
            ))}
          </FieldGroup>
          {matches.length ? (
            <Alert>
              <AlertDescription>
                {`Possible duplicate: ${matches
                  .map((match) =>
                    match.versionTitle ? `${match.title} (${match.versionTitle})` : match.title,
                  )
                  .join(', ')}`}
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending || !values.title.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
