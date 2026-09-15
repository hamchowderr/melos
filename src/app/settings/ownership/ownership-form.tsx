'use client';

import { useState, useTransition } from 'react';
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import type { PartyListItem } from '@/lib/dto/contacts';
import {
  SELF_PARTY_SIDES,
  type SelfPartiesDTO,
  type SelfPartiesInput,
  type SelfPartySide,
} from '@/lib/dto/self-parties';
import { saveSelfParties } from './actions';

type Option = { value: string; label: string };

const LABELS: Record<SelfPartySide, string> = {
  writer: 'Writer',
  publishing: 'Publishing',
  master: 'Master',
};

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow changing ownership.',
  NOT_FOUND: 'A chosen party no longer exists. Reload the page and choose again.',
  VALIDATION: 'The writer must be a person.',
};

/** Each side's party, read-only, for a role without rights:update (§6.2). */
export function SelfPartyList({ selfParties }: { selfParties: SelfPartiesDTO }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
      {SELF_PARTY_SIDES.flatMap((side) => [
        <dt key={`${side}-label`} className="text-muted-foreground">
          {LABELS[side]}
        </dt>,
        <dd key={side}>{selfParties[side]?.displayName ?? 'Not set'}</dd>,
      ])}
    </dl>
  );
}

type Props = { selfParties: SelfPartiesDTO; parties: PartyListItem[] };

/**
 * A party picker per side: people for the writer side (§4.2), people and organizations otherwise.
 * Save sends the full set, and the service refuses anything this form lets through.
 */
export function OwnershipForm({ selfParties, parties }: Props) {
  const initial = SELF_PARTY_SIDES.map((side) => [side, selfParties[side]?.partyId ?? null]);
  const [ids, setIds] = useState(() => Object.fromEntries(initial) as SelfPartiesInput);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setNotice(null);
      const result = await saveSelfParties(ids).catch(() => null);
      const text = result?.ok ? 'Saved.' : (result && REFUSED[result.code]) || 'Could not save.';
      setNotice({ error: !result?.ok, text });
    });

  return (
    <FieldGroup>
      {SELF_PARTY_SIDES.map((side) => {
        const items: Option[] = parties
          .filter(({ partyKind }) => side !== 'writer' || partyKind === 'person')
          .map(({ partyId, displayName }) => ({ value: partyId, label: displayName }));
        const choose = (item: Option | null) =>
          setIds((current) => ({ ...current, [side]: item?.value ?? null }));
        return (
          <Field key={side}>
            <FieldLabel htmlFor={`self-party-${side}`}>{LABELS[side]}</FieldLabel>
            <Combobox
              items={items}
              value={items.find(({ value }) => value === ids[side]) ?? null}
              onValueChange={choose}
            >
              <ComboboxInput id={`self-party-${side}`} placeholder="Not set" showClear />
              <ComboboxContent>
                <ComboboxEmpty>No parties found.</ComboboxEmpty>
                <ComboboxList>
                  {(item: Option) => (
                    <ComboboxItem key={item.value} value={item}>
                      {item.label}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </Field>
        );
      })}
      <Button type="button" className="self-start" disabled={pending} onClick={save}>
        Save
      </Button>
      {notice?.error ? (
        <Alert variant="destructive">
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}
      {notice && !notice.error ? (
        <output className="text-muted-foreground">{notice.text}</output>
      ) : null}
    </FieldGroup>
  );
}
