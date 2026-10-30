'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveRecordingArtists } from '@/app/catalog/recording-actions';
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ARTIST_ROLES, type RecordingArtistDTO } from '@/lib/dto/catalog';
import { words } from '@/lib/words';

type Option = { value: string; label: string };
type Role = (typeof ARTIST_ROLES)[number];
type Row = { key: number; partyId: string; role: Role; aliasId: string };

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow this change.',
  NOT_FOUND: 'A chosen party or this recording no longer exists. Reload the page.',
  VALIDATION: 'Check each artist: a party once per role, with one of its own aliases.',
};

let nextKey = 0;
const rowsOf = (artists: RecordingArtistDTO[]): Row[] =>
  artists.map(({ partyId, role, artistAliasId }) => ({
    ...{ key: nextKey++, partyId, aliasId: artistAliasId ?? '' },
    role: role === 'featured' ? 'featured' : 'primary',
  }));

type Props = {
  recordingId: string;
  title: string;
  artists: RecordingArtistDTO[];
  /** The parties an artist can be. */
  parties: Option[];
  /** Every party's artist aliases. */
  aliases: { id: string; partyId: string; aliasName: string }[];
};

/**
 * Edits a recording's artists (CAT-003) in a Dialog: a party, a role and an optional alias per
 * credit, in billing order, which Move up changes. Save replaces the whole set.
 */
export function RecordingArtistsEditor({ recordingId, title, artists, parties, aliases }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(() => rowsOf(artists));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const change = (key: number, patch: Partial<Row>) =>
    setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const up = (i: number) =>
    setRows([...rows.slice(0, i - 1), rows[i], rows[i - 1], ...rows.slice(i + 1)]);

  const save = () =>
    startTransition(async () => {
      setError(null);
      const set = rows.map(({ partyId, role, aliasId }, billingOrder) => ({
        ...{ partyId, role, artistAliasId: aliasId || null, billingOrder },
      }));
      const result = await saveRecordingArtists(recordingId, set).catch(() => null);
      if (!result?.ok) return setError((result && REFUSED[result.code]) || 'Could not save.');
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="self-start" />}>
        Edit artists
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
            <DialogTitle>{`Artists for ${title}`}</DialogTitle>
          </DialogHeader>
          {rows.map((row, i) => (
            <fieldset
              key={row.key}
              className="flex flex-wrap items-center gap-2 rounded-md border p-3"
            >
              <legend className="px-1 text-sm font-medium">{`Artist ${i + 1}`}</legend>
              <NativeSelect
                aria-label={`Artist ${i + 1} party`}
                required
                value={row.partyId}
                onChange={(event) => change(row.key, { partyId: event.target.value, aliasId: '' })}
              >
                <NativeSelectOption value="">Choose a party</NativeSelectOption>
                {parties.map(({ value, label }) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label={`Artist ${i + 1} role`}
                value={row.role}
                onChange={(event) => change(row.key, { role: event.target.value as Role })}
              >
                {ARTIST_ROLES.map((role) => (
                  <NativeSelectOption key={role} value={role}>
                    {words(role)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label={`Artist ${i + 1} alias`}
                value={row.aliasId}
                onChange={(event) => change(row.key, { aliasId: event.target.value })}
              >
                <NativeSelectOption value="">No alias</NativeSelectOption>
                {aliases
                  .filter(({ partyId }) => partyId === row.partyId)
                  .map(({ id, aliasName }) => (
                    <NativeSelectOption key={id} value={id}>
                      {aliasName}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              {i > 0 ? (
                <Button type="button" variant="ghost" onClick={() => up(i)}>
                  {`Move artist ${i + 1} up`}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRows(rows.filter(({ key }) => key !== row.key))}
              >
                {`Remove artist ${i + 1}`}
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() =>
              setRows([...rows, { key: nextKey++, partyId: '', role: 'primary', aliasId: '' }])
            }
          >
            Add artist
          </Button>
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
