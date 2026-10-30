'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveRecordingTerms } from '@/app/catalog/recording-actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { type MetadataTermDTO, TERM_TYPES } from '@/lib/dto/catalog';
import { words } from '@/lib/words';

type TermType = (typeof TERM_TYPES)[number];

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow this change.',
  NOT_FOUND: 'This recording no longer exists. Reload the page.',
  VALIDATION: 'Check the terms: each one needs a label.',
};

const textsOf = (terms: MetadataTermDTO[]) =>
  Object.fromEntries(
    TERM_TYPES.map((type) => [
      type,
      terms
        .filter(({ termType }) => termType === type)
        .map(({ label }) => label)
        .join(', '),
    ]),
  ) as Record<TermType, string>;

type Props = { recordingId: string; title: string; terms: MetadataTermDTO[] };

/**
 * Edits a recording's metadata terms (CAT-006) in a Dialog: comma-separated labels per type. A
 * label the workspace already has, in any case, reuses its term; a new label creates one (G-4).
 */
export function RecordingTermsEditor({ recordingId, title, terms }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState(() => textsOf(terms));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const set = TERM_TYPES.flatMap((termType) =>
        texts[termType]
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean)
          .map((label) => ({ termType, label })),
      );
      const result = await saveRecordingTerms(recordingId, set).catch(() => null);
      if (!result?.ok) return setError((result && REFUSED[result.code]) || 'Could not save.');
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="self-start" />}>
        Edit terms
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
            <DialogTitle>{`Terms for ${title}`}</DialogTitle>
            <DialogDescription>Separate labels with commas.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {TERM_TYPES.map((type) => (
              <Field key={type}>
                <FieldLabel htmlFor={`terms-${recordingId}-${type}`}>{words(type)}</FieldLabel>
                <Input
                  id={`terms-${recordingId}-${type}`}
                  value={texts[type]}
                  onChange={(event) => setTexts({ ...texts, [type]: event.target.value })}
                />
              </Field>
            ))}
          </FieldGroup>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
