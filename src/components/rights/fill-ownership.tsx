'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  saveMasterShares,
  savePublishingShares,
  saveWriterShares,
} from '@/app/rights/share-actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { DefaultOwnershipProposal } from '@/lib/dto/rights';

type Props = {
  /** The song's composition, or null for a recording without one. */
  compositionId: string | null;
  proposal: DefaultOwnershipProposal;
  /** The writer set's hash at load; the other sides are empty, so they send `emptyHash`. */
  writerHash: string;
  emptyHash: string;
  recordingTitles: Record<string, string>;
};

/**
 * "Fill with my ownership" (RGT-008): shows the workspace's own parties at 100% for the song's
 * empty share sets for review, and Save stores them through the normal share actions. Sides that
 * already have rows are never in the proposal, so nothing is overwritten.
 */
export function FillOwnership({ compositionId, proposal, writerHash, emptyHash, ...rest }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { selfParties, writerShares, publishingShares, masterShares } = proposal;
  const lines = [
    writerShares && `${selfParties.writer?.displayName}: writer (songwriter) 100%`,
    publishingShares && `${selfParties.publishing?.displayName}: publishing, World 100%`,
    ...(masterShares ?? []).map(
      ({ recordingId }) =>
        `${selfParties.master?.displayName}: master for ${rest.recordingTitles[recordingId]} 100%`,
    ),
  ].filter((line): line is string => Boolean(line));

  const save = () =>
    startTransition(async () => {
      setError(null);
      const saves = [
        compositionId && writerShares
          ? () =>
              saveWriterShares({
                compositionId,
                shares: writerShares,
                expectedBeforeHash: writerHash,
              })
          : null,
        compositionId && publishingShares
          ? () =>
              savePublishingShares({
                compositionId,
                ...publishingShares,
                expectedBeforeHash: emptyHash,
              })
          : null,
        ...(masterShares ?? []).map(
          (set) => () => saveMasterShares({ ...set, expectedBeforeHash: emptyHash }),
        ),
      ];
      for (const run of saves) {
        const result = run ? await run().catch(() => null) : { ok: true };
        if (!result?.ok) {
          setError(
            'Some sets could not be saved, for example because they changed. Reload to see them.',
          );
          return router.refresh();
        }
      }
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="outline" className="self-start" disabled={!lines.length} />}
      >
        Fill with my ownership
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fill with my ownership</DialogTitle>
          <DialogDescription>
            These empty share sets get your workspace's own parties. Sets that already have rows
            stay as they are.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-sm">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
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
