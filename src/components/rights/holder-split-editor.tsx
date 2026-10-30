'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveMasterShares, savePublishingShares } from '@/app/rights/share-actions';
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import type { RightsHolderDTO } from '@/lib/dto/rights';
import { formatShare, percentToBp } from '@/lib/shares';

export type Option = { value: string; label: string };
type Row = { key: number; partyId: string | null; percent: string; agreementId: string };

export type HolderTarget =
  | { side: 'publishing'; compositionId: string; territory: string | null }
  | { side: 'master'; recordingId: string };

type Props = {
  target: HolderTarget;
  /** The button that opens the editor, and the form's name, such as Edit master. */
  label: string;
  /** The set's hash when the page loaded; Save refuses if the set changed since. */
  beforeHash: string;
  holders: RightsHolderDTO[];
  /** The people and organizations a holder can be (§4.2). */
  parties: Option[];
  /** Agreements a share can cite; the select shows only when there are some. */
  agreements: Option[];
};

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow changing splits.',
  NOT_FOUND: 'A chosen holder or agreement no longer exists. Reload the page and choose again.',
  mixes_world_and_countries:
    'Publishing is either WORLD or split by country, not both. Clear the other sets first.',
  unknown_territory: 'Use WORLD or a two-letter country code such as US.',
  VALIDATION: 'Check each holder: one party per row and a valid share.',
};

let nextKey = 0;
const rowsOf = (holders: RightsHolderDTO[]): Row[] =>
  holders.map(({ partyId, shareBp, agreementId }) => ({
    key: nextKey++,
    partyId,
    percent: (shareBp / 100).toFixed(2),
    agreementId: agreementId ?? '',
  }));

/**
 * The publishing and master split editor (§2.3 RightsSplitEditor, RGT-002, RGT-003, RGT-007): a
 * holder, a share with two decimals and an optional agreement per row, for one territory or one
 * recording. A new publishing set also takes its territory. Save is the confirmation (§6.3) and
 * sends the hash read at load, so a set changed in another tab shows a reload notice.
 */
export function HolderSplitEditor(props: Props) {
  const { target, label, beforeHash, holders, parties, agreements } = props;
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [territory, setTerritory] = useState('WORLD');
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!rows) {
    const edit = () => {
      setNotice(null);
      setRows(rowsOf(holders));
    };
    return (
      <Button type="button" variant="outline" className="self-start" onClick={edit}>
        {label}
      </Button>
    );
  }

  const shares = rows.map((row) => percentToBp(row.percent));
  const totalBp = shares.reduce<number>((sum, bp) => sum + (bp ?? 0), 0);
  const over = totalBp > 10_000;
  const incomplete = rows.some((row, i) => !row.partyId || shares[i] === null);
  const change = (key: number, patch: Partial<Row>) =>
    setRows(
      (current) => current?.map((row) => (row.key === key ? { ...row, ...patch } : row)) ?? null,
    );

  const save = () =>
    startTransition(async () => {
      setNotice(null);
      const set = {
        expectedBeforeHash: beforeHash,
        shares: rows.map(({ partyId, percent, agreementId }) => ({
          ...{ partyId: partyId as string, shareBp: percentToBp(percent) as number },
          agreementId: agreementId || null,
        })),
      };
      const result = await (target.side === 'publishing'
        ? savePublishingShares({
            ...set,
            compositionId: target.compositionId,
            territory: target.territory ?? territory.trim().toUpperCase(),
          })
        : saveMasterShares({ ...set, recordingId: target.recordingId })
      ).catch(() => null);
      if (result?.ok) {
        setRows(null);
        return router.refresh();
      }
      if (result?.code === 'STATE_CHANGED')
        return setNotice('Someone changed these splits after you opened them. Reload to see them.');
      setNotice(
        (result && (REFUSED[result.reason ?? ''] ?? REFUSED[result.code])) || 'Could not save.',
      );
    });

  return (
    <form
      aria-label={label}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {target.side === 'publishing' && target.territory === null ? (
        <Input
          aria-label="Publishing territory"
          className="w-28"
          value={territory}
          onChange={(event) => setTerritory(event.target.value)}
        />
      ) : null}
      {rows.map((row, i) => (
        <fieldset key={row.key} className="flex flex-col gap-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{`Holder ${i + 1}`}</legend>
          <Combobox
            items={parties}
            value={parties.find(({ value }) => value === row.partyId) ?? null}
            onValueChange={(item: Option | null) =>
              change(row.key, { partyId: item?.value ?? null })
            }
          >
            <ComboboxInput aria-label={`Holder ${i + 1} party`} placeholder="Choose a holder" />
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
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Holder ${i + 1} share`}
              inputMode="decimal"
              className="w-28"
              value={row.percent}
              aria-invalid={shares[i] === null}
              onChange={(event) => change(row.key, { percent: event.target.value })}
            />
            <span className="text-muted-foreground">%</span>
            {agreements.length ? (
              <NativeSelect
                aria-label={`Holder ${i + 1} agreement`}
                value={row.agreementId}
                onChange={(event) => change(row.key, { agreementId: event.target.value })}
              >
                <NativeSelectOption value="">No agreement</NativeSelectOption>
                {agreements.map(({ value, label: title }) => (
                  <NativeSelectOption key={value} value={value}>
                    {title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
              onClick={() => setRows(rows.filter(({ key }) => key !== row.key))}
            >
              {`Remove holder ${i + 1}`}
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() =>
          setRows([...rows, { key: nextKey++, partyId: null, percent: '', agreementId: '' }])
        }
      >
        Add holder
      </Button>
      <p className="text-sm tabular-nums">
        {`Total ${formatShare(totalBp)}, ${formatShare(Math.max(10_000 - totalBp, 0))} remaining`}
      </p>
      {over ? (
        <Alert variant="destructive">
          <AlertDescription>The total is over 100%. Lower a share to save.</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="destructive">
          <AlertDescription>{notice}</AlertDescription>
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
