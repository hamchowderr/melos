'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveNewAgreement } from '@/app/rights/agreement-actions';
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
import { AGREEMENT_TYPES } from '@/lib/dto/rights';
import { words } from '@/lib/words';

type Option = { value: string; label: string };

const BLANK = { agreementType: 'representation', title: '', counterpartyPartyId: '' };
const DATES = { effectiveOn: '', expiresOn: '' };

/** A refusal's message, by its field for VALIDATION. */
const refusal = ({ code, field }: { code: string; field?: string }) =>
  code === 'VALIDATION' && field === 'expiresOn'
    ? 'The expiry date is before the effective date.'
    : code === 'VALIDATION'
      ? 'Check the fields: a type, a title and real dates.'
      : code === 'NOT_FOUND'
        ? 'The chosen counterparty no longer exists. Reload the page.'
        : code === 'FORBIDDEN'
          ? 'Your workspace role does not allow recording agreements.'
          : 'Could not save.';

/**
 * Records an agreement (RGT-006) from the rights panel in a Dialog: type, title, counterparty and
 * effective and expiry dates. An attestation can then cite it (§6.5).
 */
export function AgreementForm({ parties }: { parties: Option[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(BLANK);
  const [dates, setDates] = useState(DATES);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toggle = (opening: boolean) => {
    setOpen(opening);
    setError(null);
    setFields(BLANK);
    setDates(DATES);
  };
  const save = () =>
    startTransition(async () => {
      setError(null);
      const result = await saveNewAgreement({ ...fields, ...dates }).catch(() => null);
      if (!result?.ok) return setError(result ? refusal(result) : 'Could not save.');
      setOpen(false);
      router.refresh();
    });
  const date = (name: keyof typeof DATES, label: string) => (
    <Field>
      <FieldLabel htmlFor={`agreement-${name}`}>{label}</FieldLabel>
      <Input
        id={`agreement-${name}`}
        type="date"
        value={dates[name]}
        onChange={(event) => setDates({ ...dates, [name]: event.target.value })}
      />
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={toggle}>
      <DialogTrigger render={<Button variant="outline" className="self-start" />}>
        Record agreement
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Record agreement</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agreement-type">Type</FieldLabel>
              <NativeSelect
                id="agreement-type"
                value={fields.agreementType}
                onChange={(event) => setFields({ ...fields, agreementType: event.target.value })}
              >
                {AGREEMENT_TYPES.map((type) => (
                  <NativeSelectOption key={type} value={type}>
                    {words(type)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="agreement-title">Agreement title</FieldLabel>
              <Input
                id="agreement-title"
                required
                value={fields.title}
                onChange={(event) => setFields({ ...fields, title: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agreement-counterparty">Counterparty</FieldLabel>
              <NativeSelect
                id="agreement-counterparty"
                value={fields.counterpartyPartyId}
                onChange={(event) =>
                  setFields({ ...fields, counterpartyPartyId: event.target.value })
                }
              >
                <NativeSelectOption value="">None</NativeSelectOption>
                {parties.map(({ value, label }) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            {date('effectiveOn', 'Effective on')}
            {date('expiresOn', 'Expires on')}
          </FieldGroup>
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
