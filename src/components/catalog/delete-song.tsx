'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { removeSong } from '@/app/catalog/actions';
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
import { REFUSED } from './metadata-panel';

/**
 * Deletes a song and its recordings after an explicit confirmation (§6.2: owners and admins). A
 * song whose recordings or composition something still holds, such as a release, a share or a
 * pitch, is refused with REFERENCED, and the dialog lists what holds it.
 */
export function DeleteSong({ compositionId, title }: { compositionId: string; title: string }) {
  const router = useRouter();
  const [blocked, setBlocked] = useState<[string, number][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () =>
    startTransition(async () => {
      const result = await removeSong(compositionId).catch(() => null);
      if (result?.ok) return router.push('/catalog');
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
          <AlertDialogTitle>{`Delete ${title}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            The song and its recordings leave the catalog. Their history stays in the audit log.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocked ? (
          <Alert variant="destructive">
            <AlertTitle>{`${title} is still in use`}</AlertTitle>
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
