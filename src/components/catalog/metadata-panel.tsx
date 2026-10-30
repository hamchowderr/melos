'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { checkSongDuplicates, saveNewSong, saveSong } from '@/app/catalog/actions';
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
import { Textarea } from '@/components/ui/textarea';
import type { CompositionDTO, CompositionDuplicate, CompositionPatch } from '@/lib/dto/catalog';
import { formatIswc } from '@/lib/identifiers';

export const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow this change.',
  NOT_FOUND: 'This song no longer exists. Reload the page.',
  VALIDATION: 'Check the fields: a title is required.',
  INVALID_ISWC: 'The ISWC is not valid. It looks like T-123.456.789-0.',
  CONFLICT: 'Another song already holds this ISWC.',
};

const FIELDS = [
  ['title', 'Title'],
  ['altTitles', 'Alternate titles'],
  ['iswc', 'ISWC'],
  ['copyrightRegistrationNumber', 'Copyright registration'],
  ['copyrightDate', 'Copyright date'],
  ['description', 'Description'],
  ['lyrics', 'Lyrics'],
] as const;

type Key = (typeof FIELDS)[number][0];
type Values = Record<Key, string>;

const valuesOf = (composition?: CompositionDTO): Values => ({
  title: composition?.title ?? '',
  altTitles: composition?.altTitles.join(', ') ?? '',
  iswc: composition?.iswc ? formatIswc(composition.iswc) : '',
  copyrightRegistrationNumber: composition?.copyrightRegistrationNumber ?? '',
  copyrightDate: composition?.copyrightDate ?? '',
  description: composition?.description ?? '',
  lyrics: '',
});

/**
 * The fields that differ from `initial`, as a patch: blank clears, alternate titles split on commas.
 * Lyrics are never loaded, so blank lyrics keep what is on file. An unchanged ISWC is left out, so a
 * stored ISWC whose check digit fails still lets the other fields save (D-2).
 */
function patchOf(values: Values, initial: Values): CompositionPatch {
  const patch: Record<string, unknown> = {};
  for (const [key] of FIELDS) {
    const value = values[key].trim();
    if (value === initial[key].trim() || (key === 'lyrics' && !value)) continue;
    patch[key] =
      key === 'altTitles'
        ? value
            .split(',')
            .map((title) => title.trim())
            .filter(Boolean)
        : value || null;
  }
  return patch as CompositionPatch;
}

/**
 * Creates a song or edits `composition` (CAT-001) in a Dialog: the composition's metadata, in
 * composition mode. A new song also gets its first recording with the same title (D-10); before it
 * saves, live songs with the same title or ISWC show as a possible duplicate (§6.15).
 */
export function MetadataPanel({ composition }: { composition?: CompositionDTO }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [initial] = useState(() => valuesOf(composition));
  const [values, setValues] = useState(initial);
  const [matches, setMatches] = useState<CompositionDuplicate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const label = composition ? 'Edit' : 'New song';

  const check = () => {
    if (composition) return;
    const query = { title: values.title, iswc: values.iswc || null };
    checkSongDuplicates(query).then(setMatches, () => setMatches([]));
  };
  const save = () =>
    startTransition(async () => {
      setError(null);
      const patch = patchOf(values, initial);
      const result = await (composition
        ? saveSong(composition.id, patch)
        : saveNewSong({ ...patch, title: values.title })
      ).catch(() => null);
      if (!result?.ok) return setError((result && REFUSED[result.code]) || 'Could not save.');
      setOpen(false);
      if (composition) router.refresh();
      else router.push(`/catalog/compositions/${result.compositionId}`);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={composition ? 'outline' : 'default'} />}>
        {label}
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
            <DialogTitle>{composition ? 'Edit song' : 'New song'}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            {FIELDS.map(([key, name]) => {
              const Control = key === 'description' || key === 'lyrics' ? Textarea : Input;
              return (
                <Field key={key}>
                  <FieldLabel htmlFor={`song-${key}`}>{name}</FieldLabel>
                  <Control
                    id={`song-${key}`}
                    required={key === 'title'}
                    type={key === 'copyrightDate' ? 'date' : undefined}
                    value={values[key]}
                    onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                    onBlur={key === 'title' || key === 'iswc' ? check : undefined}
                  />
                  {key === 'altTitles' ? (
                    <FieldDescription>Separate titles with commas.</FieldDescription>
                  ) : null}
                  {key === 'lyrics' && composition?.hasLyrics ? (
                    <FieldDescription>Lyrics are on file. New text replaces them.</FieldDescription>
                  ) : null}
                </Field>
              );
            })}
          </FieldGroup>
          {matches.length ? (
            <Alert>
              <AlertDescription>
                {'Possible duplicate: '}
                {matches.map(({ compositionId, title }, index) => (
                  <span key={compositionId}>
                    {index > 0 && ', '}
                    <Link href={`/catalog/compositions/${compositionId}`} className="underline">
                      {title}
                    </Link>
                  </span>
                ))}
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
