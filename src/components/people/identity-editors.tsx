'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type IdentitySet, saveIdentitySet } from '@/app/people/actions';
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
import { ALIAS_TYPES, IDENTIFIER_TYPES, type PartyDetailDTO } from '@/lib/dto/contacts';
import { words } from '@/lib/words';
import { REFUSED } from './party-form';

type Value = string | boolean;
type Row = { key: number; values: Record<string, Value> };
/** One column of a set editor: a text or date input, a select, or a checkbox. */
type Column = {
  name: string;
  label: string;
  type?: 'date' | 'checkbox';
  options?: readonly (readonly [string, string])[];
};

const IDENTITY_REFUSED: Record<string, string> = {
  ...REFUSED,
  VALIDATION: 'Check each row: a value, no repeats, one primary per type and dates in order.',
  CONFLICT: 'Another party already holds this identifier.',
};

let nextKey = 0;
const choices = (values: readonly string[]) =>
  values.map((value) => [value, words(value)] as const);

type Props = {
  partyId: string;
  title: string;
  /** The singular row name, as in Add alias and Remove alias 2. */
  noun: string;
  columns: Column[];
  rows: Record<string, Value>[];
  blank: Record<string, Value>;
  /** Turns the editor's rows into the set the service replaces; blank strings become null. */
  toSet: (rows: Record<string, Value>[]) => IdentitySet;
};

/** A party's whole alias, identifier or society set (CAT-008) in a Dialog; Save replaces it. */
function SetEditor({ partyId, title, noun, columns, rows: held, blank, toSet }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const change = (key: number, name: string, value: Value) =>
    setRows((current) =>
      current.map((row) =>
        row.key === key ? { ...row, values: { ...row.values, [name]: value } } : row,
      ),
    );

  const toggle = (opening: boolean) => {
    setOpen(opening);
    setError(null);
    if (opening) setRows(held.map((values) => ({ key: nextKey++, values })));
  };
  const save = () =>
    startTransition(async () => {
      setError(null);
      const set = toSet(rows.map(({ values }) => values));
      const result = await saveIdentitySet(partyId, set).catch(() => null);
      if (!result?.ok)
        return setError((result && IDENTITY_REFUSED[result.code]) || 'Could not save.');
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={toggle}>
      <DialogTrigger render={<Button variant="outline" />}>{title}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {rows.map((row, i) => (
          <div key={row.key} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            {columns.map(({ name, label, type, options }) => {
              const aria = `${words(noun)} ${i + 1} ${label}`;
              const value = row.values[name];
              if (type === 'checkbox')
                return (
                  <label key={name} className="inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(event) => change(row.key, name, event.target.checked)}
                    />
                    {label}
                  </label>
                );
              if (options)
                return (
                  <NativeSelect
                    key={name}
                    aria-label={aria}
                    value={String(value)}
                    onChange={(event) => change(row.key, name, event.target.value)}
                  >
                    {options.map(([option, text]) => (
                      <NativeSelectOption key={option} value={option}>
                        {text}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                );
              return (
                <Input
                  key={name}
                  aria-label={aria}
                  type={type}
                  className="min-w-0 flex-1"
                  value={String(value)}
                  onChange={(event) => change(row.key, name, event.target.value)}
                />
              );
            })}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRows(rows.filter(({ key }) => key !== row.key))}
            >
              {`Remove ${noun} ${i + 1}`}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => setRows([...rows, { key: nextKey++, values: blank }])}
        >
          {`Add ${noun}`}
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

const text = (value: Value) => String(value).trim() || null;

/** The party page's alias, identifier and society editors (CAT-008), for contact:update. */
export function IdentityEditors({ party }: { party: PartyDetailDTO }) {
  const { partyId, aliases, identifiers, societyAffiliations } = party;
  const aliasOptions: [string, string][] = [
    ['', 'No alias'],
    ...aliases.map(({ id, aliasName }): [string, string] => [id, aliasName]),
  ];
  return (
    <>
      <SetEditor
        partyId={partyId}
        title="Aliases"
        noun="alias"
        columns={[
          { name: 'aliasName', label: 'name' },
          { name: 'aliasType', label: 'type', options: choices(ALIAS_TYPES) },
          { name: 'isPrimary', label: 'Primary', type: 'checkbox' },
        ]}
        rows={aliases.map(({ id, aliasName, aliasType, isPrimary }) => ({
          ...{ id, aliasName, aliasType, isPrimary },
        }))}
        blank={{ aliasName: '', aliasType: 'stage_name', isPrimary: false }}
        toSet={(rows) => ({
          set: 'aliases',
          rows: rows.map((row) => ({
            ...(row.id ? { id: String(row.id) } : {}),
            aliasName: String(row.aliasName),
            aliasType: row.aliasType as (typeof ALIAS_TYPES)[number],
            isPrimary: Boolean(row.isPrimary),
          })),
        })}
      />
      <SetEditor
        partyId={partyId}
        title="Identifiers"
        noun="identifier"
        columns={[
          { name: 'identifierType', label: 'type', options: IDENTIFIER_TYPES.map((t) => [t, t]) },
          { name: 'identifierValue', label: 'value' },
          { name: 'artistAliasId', label: 'alias', options: aliasOptions },
          { name: 'isPrimary', label: 'Primary', type: 'checkbox' },
        ]}
        rows={identifiers.map((row) => ({
          ...{
            id: row.id,
            identifierType: row.identifierType,
            identifierValue: row.identifierValue,
          },
          ...{ artistAliasId: row.artistAliasId ?? '', isPrimary: row.isPrimary },
          issuingBody: row.issuingBody ?? '',
        }))}
        blank={{ identifierType: 'IPI', identifierValue: '', artistAliasId: '', isPrimary: false }}
        toSet={(rows) => ({
          set: 'identifiers',
          rows: rows.map((row) => ({
            ...(row.id ? { id: String(row.id) } : {}),
            identifierType: row.identifierType as (typeof IDENTIFIER_TYPES)[number],
            identifierValue: String(row.identifierValue),
            issuingBody: row.issuingBody === undefined ? undefined : text(row.issuingBody),
            artistAliasId: text(row.artistAliasId ?? ''),
            isPrimary: Boolean(row.isPrimary),
          })),
        })}
      />
      <SetEditor
        partyId={partyId}
        title="Societies"
        noun="society"
        columns={[
          { name: 'societyCode', label: 'code' },
          {
            name: 'role',
            label: 'role',
            options: [['', 'Any role'], ...choices(['writer', 'publisher'])],
          },
          { name: 'startsOn', label: 'start', type: 'date' },
          { name: 'endsOn', label: 'end', type: 'date' },
        ]}
        rows={societyAffiliations.map(({ id, societyCode, role, startsOn, endsOn }) => ({
          ...{ id, societyCode, role: role ?? '', startsOn: startsOn ?? '', endsOn: endsOn ?? '' },
        }))}
        blank={{ societyCode: '', role: '', startsOn: '', endsOn: '' }}
        toSet={(rows) => ({
          set: 'societyAffiliations',
          rows: rows.map((row) => ({
            ...(row.id ? { id: String(row.id) } : {}),
            societyCode: String(row.societyCode),
            role: text(row.role) as 'writer' | 'publisher' | null,
            ...{ startsOn: text(row.startsOn), endsOn: text(row.endsOn) },
          })),
        })}
      />
    </>
  );
}
