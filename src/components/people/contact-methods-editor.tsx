'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveContactMethods } from '@/app/people/actions';
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
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { type ContactMethodInput, METHOD_TYPES, type PartyDetailDTO } from '@/lib/dto/contacts';
import { words } from '@/lib/words';
import { REFUSED } from './party-form';

type Row = ContactMethodInput & { key: number };
let nextKey = 0;

/**
 * A party's whole contact method set (§4.2) in a Dialog: type, value and a primary flag per row.
 * Save replaces the set; a kept row sends its id, so messages that name it keep their link.
 */
export function ContactMethodsEditor({ party }: { party: PartyDetailDTO }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const change = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const toggle = (opening: boolean) => {
    setOpen(opening);
    if (!opening) return;
    setError(null);
    setRows(
      party.methods.map(({ id, methodType, value, label, isPrimary }) => ({
        ...{ key: nextKey++, id, methodType: methodType as Row['methodType'], value, label },
        isPrimary,
      })),
    );
  };
  const save = () =>
    startTransition(async () => {
      setError(null);
      const methods = rows.map(({ key: _, ...method }) => method);
      const result = await saveContactMethods(party.partyId, methods).catch(() => null);
      if (!result?.ok) return setError((result && REFUSED[result.code]) || 'Could not save.');
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={toggle}>
      <DialogTrigger render={<Button variant="outline" />}>Contact methods</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Contact methods</DialogTitle>
        </DialogHeader>
        {rows.map((row, i) => (
          <div key={row.key} className="flex flex-wrap items-center gap-2">
            <NativeSelect
              aria-label={`Method ${i + 1} type`}
              value={row.methodType}
              onChange={(event) =>
                change(row.key, { methodType: event.target.value as Row['methodType'] })
              }
            >
              {METHOD_TYPES.map((type) => (
                <NativeSelectOption key={type} value={type}>
                  {words(type)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Input
              aria-label={`Method ${i + 1} value`}
              className="min-w-0 flex-1"
              value={row.value}
              onChange={(event) => change(row.key, { value: event.target.value })}
            />
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={Boolean(row.isPrimary)}
                onChange={(event) => change(row.key, { isPrimary: event.target.checked })}
              />
              Primary
            </label>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRows(rows.filter(({ key }) => key !== row.key))}
            >
              {`Remove method ${i + 1}`}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => setRows([...rows, { key: nextKey++, methodType: 'phone', value: '' }])}
        >
          Add method
        </Button>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" disabled={pending} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
