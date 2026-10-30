'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { checkDuplicates, saveParty } from '@/app/people/actions';
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
import { Textarea } from '@/components/ui/textarea';
import type { PartyDetailDTO, PartyKind, PartyMatch } from '@/lib/dto/contacts';

export const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow this change.',
  NOT_FOUND: 'This party no longer exists. Reload the page.',
  VALIDATION: 'Check the fields: a name is required and an email must be valid.',
  CONFLICT: 'Another party already holds this value.',
};

type Props = { kind: PartyKind; party?: PartyDetailDTO; label: string };

/**
 * Creates a person or an organization, or edits `party` (§2.3, CRM-001), in a Dialog. A new party
 * can start with a primary email. Before saving a new one, the names and emails it shares with live
 * parties show as a possible duplicate warning (§6.15) that never blocks the save.
 */
export function PartyForm({ kind, party, label }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(party?.displayName ?? '');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState(party?.notes ?? '');
  const [matches, setMatches] = useState<PartyMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const check = () => {
    if (party) return;
    checkDuplicates({ displayName: name, email }).then(setMatches, () => setMatches([]));
  };
  const save = () =>
    startTransition(async () => {
      setError(null);
      const input = { partyKind: kind, displayName: name, notes: notes.trim() || null };
      const methods = email.trim()
        ? [{ methodType: 'email' as const, value: email, isPrimary: true }]
        : undefined;
      const result = await saveParty(party?.partyId ?? null, input, methods).catch(() => null);
      if (!result?.ok) {
        setError((result && REFUSED[result.code]) || 'Could not save.');
        return;
      }
      setOpen(false);
      if (party) router.refresh();
      else router.push(`/people/${result.partyId}`);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={party ? 'outline' : 'default'} />}>
        {label}
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
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="party-name">Name</FieldLabel>
              <Input
                id="party-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={check}
              />
            </Field>
            {party ? null : (
              <Field>
                <FieldLabel htmlFor="party-email">Email</FieldLabel>
                <Input
                  id="party-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onBlur={check}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="party-notes">Notes</FieldLabel>
              <Textarea
                id="party-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {matches.length ? (
            <Alert>
              <AlertDescription>
                {'Possible duplicate: '}
                {matches.map(({ partyId, displayName }, index) => (
                  <span key={partyId}>
                    {index > 0 && ', '}
                    <Link href={`/people/${partyId}`} className="underline">
                      {displayName}
                    </Link>
                  </span>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
