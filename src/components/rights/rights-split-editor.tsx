'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveWriterShares } from '@/app/rights/share-actions';
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
import { Input } from '@/components/ui/input';
import { type RightsSummaryDTO, WRITER_ROLES } from '@/lib/dto/rights';
import { formatShare, percentToBp } from '@/lib/shares';
import { words } from '@/lib/words';

type Option = { value: string; label: string };
type Role = (typeof WRITER_ROLES)[number];
type Row = { key: number; partyId: string | null; roles: Role[]; percent: string };

type Props = {
  compositionId: string;
  /** The writer set's hash when the page loaded; Save refuses if the set changed since. */
  beforeHash: string;
  writers: RightsSummaryDTO['writers'];
  /** The people a writer can be (§4.2). */
  people: Option[];
};

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow changing splits.',
  NOT_FOUND: 'A chosen person no longer exists. Reload the page and choose again.',
  VALIDATION: 'Check each writer: one person per row, at least one role and a valid share.',
};

let nextKey = 0;
const rowsOf = (writers: Props['writers']): Row[] =>
  writers.map(({ partyId, roles, shareBp }) => ({
    key: nextKey++,
    partyId,
    roles: roles.filter((role): role is Role => WRITER_ROLES.includes(role as Role)),
    percent: shareBp === null ? '' : (shareBp / 100).toFixed(2),
  }));

/**
 * The writer split editor (§2.3 RightsSplitEditor, RGT-001): a person, roles and a share with two
 * decimals per writer. The meter shows the total and what remains; nothing is redistributed (P-29
 * is agent-only). Save is the confirmation (§6.3) and sends the hash read at load, so a set changed
 * in another tab shows a reload notice instead of overwriting it.
 */
export function RightsSplitEditor({ compositionId, beforeHash, writers, people }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [notice, setNotice] = useState<{ stale: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (!rows) {
    const edit = () => {
      setNotice(null);
      setRows(rowsOf(writers));
    };
    return (
      <Button type="button" variant="outline" className="self-start" onClick={edit}>
        Edit writers
      </Button>
    );
  }

  const shares = rows.map((row) => (row.percent.trim() ? percentToBp(row.percent) : 0));
  const totalBp = shares.reduce<number>((sum, bp) => sum + (bp ?? 0), 0);
  const over = totalBp > 10_000;
  const incomplete = rows.some((row, i) => !row.partyId || !row.roles.length || shares[i] === null);
  const change = (key: number, patch: Partial<Row>) =>
    setRows(
      (current) => current?.map((row) => (row.key === key ? { ...row, ...patch } : row)) ?? null,
    );

  const save = () =>
    startTransition(async () => {
      setNotice(null);
      const input = {
        compositionId,
        expectedBeforeHash: beforeHash,
        shares: rows.map(({ partyId, roles, percent }) => ({
          ...{ partyId: partyId as string, roles },
          shareBp: percent.trim() ? percentToBp(percent) : null,
        })),
      };
      const result = await saveWriterShares(input).catch(() => null);
      if (result?.ok) {
        setRows(null);
        router.refresh();
      } else if (result?.code === 'STATE_CHANGED') {
        const text = 'Someone changed these splits after you opened them. Reload to see them.';
        setNotice({ stale: true, text });
      } else {
        setNotice({ stale: false, text: (result && REFUSED[result.code]) || 'Could not save.' });
      }
    });

  return (
    <form
      aria-label="Edit writers"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {rows.map((row, i) => (
        <fieldset key={row.key} className="flex flex-col gap-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{`Writer ${i + 1}`}</legend>
          <Combobox
            items={people}
            value={people.find(({ value }) => value === row.partyId) ?? null}
            onValueChange={(item: Option | null) =>
              change(row.key, { partyId: item?.value ?? null })
            }
          >
            <ComboboxInput aria-label={`Writer ${i + 1} person`} placeholder="Choose a person" />
            <ComboboxContent>
              <ComboboxEmpty>No people found.</ComboboxEmpty>
              <ComboboxList>
                {(item: Option) => (
                  <ComboboxItem key={item.value} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {WRITER_ROLES.map((role) => (
              <label key={role} className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={row.roles.includes(role)}
                  onChange={(event) =>
                    change(row.key, {
                      roles: event.target.checked
                        ? WRITER_ROLES.filter((r) => r === role || row.roles.includes(r))
                        : row.roles.filter((r) => r !== role),
                    })
                  }
                />
                {words(role)}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label={`Writer ${i + 1} share`}
              inputMode="decimal"
              className="w-28"
              value={row.percent}
              aria-invalid={shares[i] === null}
              onChange={(event) => change(row.key, { percent: event.target.value })}
            />
            <span className="text-muted-foreground">%</span>
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
              onClick={() => setRows(rows.filter(({ key }) => key !== row.key))}
            >
              {`Remove writer ${i + 1}`}
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() =>
          setRows([...rows, { key: nextKey++, partyId: null, roles: ['songwriter'], percent: '' }])
        }
      >
        Add writer
      </Button>
      <div className="flex flex-col gap-1">
        <meter
          aria-label="Writer total"
          className="h-2 w-full"
          min={0}
          max={10_000}
          high={10_000}
          value={Math.min(totalBp, 10_000)}
        />
        <p className="text-sm tabular-nums" data-testid="split-total">
          {`Total ${formatShare(totalBp)}, ${formatShare(Math.max(10_000 - totalBp, 0))} remaining`}
        </p>
      </div>
      {over ? (
        <Alert variant="destructive">
          <AlertDescription>The total is over 100%. Lower a share to save.</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="destructive">
          <AlertDescription>
            {notice.text}{' '}
            {notice.stale ? (
              <Button type="button" variant="link" onClick={() => window.location.reload()}>
                Reload
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || over || incomplete}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={() => setRows(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
