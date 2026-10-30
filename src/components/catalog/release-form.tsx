'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveNewRelease } from '@/app/catalog/release-actions';
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RELEASE_TYPES, type ReleaseType } from '@/lib/dto/catalog';
import { words } from '@/lib/words';

type Option = { value: string; label: string };
type Track = { key: number; recordingId: string; disc: string; track: string };

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow this change.',
  NOT_FOUND: 'A chosen label, distributor or recording no longer exists. Reload the page.',
  VALIDATION: 'Check the fields: a title, one row per recording and one per disc and track number.',
  INVALID_UPC_EAN: 'The UPC/EAN is not valid. Check its digits.',
  CONFLICT: 'Another release already has this UPC/EAN.',
};

let nextKey = 0;
const number = (text: string) => (text.trim() ? Number(text) : null);

type Props = {
  /** The song's recordings, which the tracks choose from. */
  recordings: Option[];
  /** The organizations a label or distributor can be. */
  organizations: Option[];
};

/**
 * Adds a release from the song page (CAT-007) in a Dialog: title, type, UPC/EAN, label and
 * distributor, date, and tracks with disc and track numbers. The service checks the UPC/EAN check
 * digit (D-1) and refuses a repeated recording or position.
 */
export function ReleaseForm({ recordings, organizations }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState({ title: '', type: 'single', upc: '', date: '' });
  const [parties, setParties] = useState({ label: '', distributor: '' });
  const [tracks, setTracks] = useState<Track[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const change = (key: number, patch: Partial<Track>) =>
    setTracks(tracks.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const toggle = (opening: boolean) => {
    setOpen(opening);
    setError(null);
    if (!opening) return;
    setFields({ title: '', type: 'single', upc: '', date: '' });
    setParties({ label: '', distributor: '' });
    const first = recordings[0]?.value ?? '';
    setTracks([{ key: nextKey++, recordingId: first, disc: '1', track: '1' }]);
  };
  const save = () =>
    startTransition(async () => {
      setError(null);
      const result = await saveNewRelease({
        title: fields.title,
        releaseType: fields.type as ReleaseType,
        upcEan: fields.upc.trim() || null,
        releaseDate: fields.date || null,
        labelPartyId: parties.label || null,
        distributorPartyId: parties.distributor || null,
        tracks: tracks.map(({ recordingId, disc, track }) => ({
          ...{ recordingId, discNumber: number(disc) ?? 1, trackNumber: number(track) },
        })),
      }).catch(() => null);
      if (!result?.ok) return setError((result && REFUSED[result.code]) || 'Could not save.');
      setOpen(false);
      router.refresh();
    });
  const picker = (name: 'label' | 'distributor', text: string) => (
    <Field>
      <FieldLabel htmlFor={`release-${name}`}>{text}</FieldLabel>
      <NativeSelect
        id={`release-${name}`}
        value={parties[name]}
        onChange={(event) => setParties({ ...parties, [name]: event.target.value })}
      >
        <NativeSelectOption value="">None</NativeSelectOption>
        {organizations.map(({ value, label }) => (
          <NativeSelectOption key={value} value={value}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={toggle}>
      <DialogTrigger render={<Button variant="outline" className="self-start" />}>
        Add release
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
            <DialogTitle>Add release</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="release-title">Title</FieldLabel>
              <Input
                id="release-title"
                required
                value={fields.title}
                onChange={(event) => setFields({ ...fields, title: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="release-type">Type</FieldLabel>
              <NativeSelect
                id="release-type"
                value={fields.type}
                onChange={(event) => setFields({ ...fields, type: event.target.value })}
              >
                {RELEASE_TYPES.map((type) => (
                  <NativeSelectOption key={type} value={type}>
                    {words(type)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="release-upc">UPC/EAN</FieldLabel>
              <Input
                id="release-upc"
                inputMode="numeric"
                value={fields.upc}
                onChange={(event) => setFields({ ...fields, upc: event.target.value })}
              />
            </Field>
            {picker('label', 'Label')}
            {picker('distributor', 'Distributor')}
            <Field>
              <FieldLabel htmlFor="release-date">Release date</FieldLabel>
              <Input
                id="release-date"
                type="date"
                value={fields.date}
                onChange={(event) => setFields({ ...fields, date: event.target.value })}
              />
            </Field>
          </FieldGroup>
          {tracks.map((row, i) => (
            <fieldset
              key={row.key}
              className="flex flex-wrap items-center gap-2 rounded-md border p-2"
            >
              <legend className="px-1 text-sm font-medium">{`Track row ${i + 1}`}</legend>
              <NativeSelect
                aria-label={`Track row ${i + 1} recording`}
                value={row.recordingId}
                onChange={(event) => change(row.key, { recordingId: event.target.value })}
              >
                {recordings.map(({ value, label }) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Input
                aria-label={`Track row ${i + 1} disc`}
                inputMode="numeric"
                className="w-16"
                value={row.disc}
                onChange={(event) => change(row.key, { disc: event.target.value })}
              />
              <Input
                aria-label={`Track row ${i + 1} track`}
                inputMode="numeric"
                className="w-16"
                value={row.track}
                onChange={(event) => change(row.key, { track: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => setTracks(tracks.filter(({ key }) => key !== row.key))}
              >
                {`Remove track row ${i + 1}`}
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() =>
              setTracks([
                ...tracks,
                { key: nextKey++, recordingId: recordings[0]?.value ?? '', disc: '1', track: '' },
              ])
            }
          >
            Add track
          </Button>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending || !fields.title.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
