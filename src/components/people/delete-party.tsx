'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { removeParty } from '@/app/people/actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { words } from '@/lib/words';
import { REFUSED } from './party-form';

/**
 * Deletes a party after an explicit confirmation (§6.2: owners and admins). A party that shares,
 * agreements or credits still hold is refused with REFERENCED, and the dialog lists what holds it.
 */
export function DeleteParty({ partyId, displayName }: { partyId: string; displayName: string }) {
  const router = useRouter();
  const [blocked, setBlocked] = useState<[string, number][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () =>
    startTransition(async () => {
      const result = await removeParty(partyId).catch(() => null);
      if (result?.ok) return router.push('/people');
      if (result?.code === 'REFERENCED') return setBlocked(Object.entries(result.counts ?? {}));
      setError((result && REFUSED[result.code]) || 'Could not delete.');
    });

  return (
    <AlertDialog
      onOpenChange={() => {
        setBlocked(null);
        setError(null);
      }}
    >
      <AlertDialogTrigger render={<Button variant="destructive" />}>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete ${displayName}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            The party leaves People and every picker. Its history stays in the audit log.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocked ? (
          <Alert variant="destructive">
            <AlertTitle>{`${displayName} is still in use`}</AlertTitle>
            <AlertDescription>
              <ul>
                {blocked.map(([table, count]) => (
                  <li key={table}>{`${words(table)}: ${count}`}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending || Boolean(blocked)} onClick={confirm}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
