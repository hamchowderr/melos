'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveLicensingContacts } from '@/app/rights/licensing-actions';
import type { Option } from '@/components/rights/holder-split-editor';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import type { LicensingContactDTO } from '@/lib/dto/rights';

type Row = { key: number; partyId: string | null };
type Props = {
  /** The song's composition, or for a recording without one, the recording. */
  target: { compositionId: string } | { recordingId: string };
  contacts: LicensingContactDTO[];
  parties: Option[];
};

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow changing licensing contacts.',
  NOT_FOUND: 'A chosen contact no longer exists. Reload the page and choose again.',
  VALIDATION: 'Choose each contact once.',
};

let nextKey = 0;

/**
 * The licensing contacts editor (RGT-005): who a licensee talks to. Explicit contacts replace the
 * implicit one, the master self party at full control (P-28); an empty set goes back to it.
 */
export function LicensingContactsEditor({ target, contacts, parties }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!rows) {
    const edit = () => {
      setError(null);
      const explicit = contacts.filter(({ implicit }) => !implicit);
      setRows(explicit.map(({ partyId }) => ({ key: nextKey++, partyId })));
    };
    return (
      <Button type="button" variant="outline" className="self-start" onClick={edit}>
        Edit licensing contacts
      </Button>
    );
  }

  const save = () =>
    startTransition(async () => {
      setError(null);
      const chosen = rows.flatMap(({ partyId }) => (partyId ? [{ partyId }] : []));
      const result = await saveLicensingContacts({ ...target, contacts: chosen }).catch(() => null);
      if (result?.ok) {
        setRows(null);
        return router.refresh();
      }
      setError((result && REFUSED[result.code]) || 'Could not save.');
    });

  return (
    <form
      aria-label="Edit licensing contacts"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {rows.map((row, i) => (
        <div key={row.key} className="flex items-center gap-2">
          <Combobox
            items={parties}
            value={parties.find(({ value }) => value === row.partyId) ?? null}
            onValueChange={(item: Option | null) =>
              setRows(
                rows.map((r) => (r.key === row.key ? { ...r, partyId: item?.value ?? null } : r)),
              )
            }
          >
            <ComboboxInput aria-label={`Contact ${i + 1}`} placeholder="Choose a contact" />
            <ComboboxContent>
              <ComboboxEmpty>No people or organizations found.</ComboboxEmpty>
              <ComboboxList>
                {(item: Option) => (
                  <ComboboxItem key={item.value} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setRows(rows.filter(({ key }) => key !== row.key))}
          >
            {`Remove contact ${i + 1}`}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => setRows([...rows, { key: nextKey++, partyId: null }])}
      >
        Add contact
      </Button>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={() => setRows(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
