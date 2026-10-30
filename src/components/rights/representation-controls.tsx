'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveRepresentation } from '@/app/rights/licensing-actions';
import { Button } from '@/components/ui/button';
import type { RightsHolderDTO } from '@/lib/dto/rights';

type Props = { interestType: 'publishing' | 'master'; holder: RightsHolderDTO };

/**
 * Attests, or clears, that the workspace may license another holder's share (RGT-005: "can you
 * just deal with me"). An attested holder counts as controlled, so the song can be One Stop Ready.
 * The self party needs no attestation, so it shows no control.
 */
export function RepresentationControls({ interestType, holder }: Props) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  if (holder.isSelf) return null;
  const attest = !holder.representationAttested;
  const toggle = () =>
    startTransition(async () => {
      const input = { interestType, interestId: holder.interestId, attested: attest };
      const result = await saveRepresentation(input).catch(() => null);
      setFailed(!result?.ok);
      if (result?.ok) router.refresh();
    });
  return (
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={toggle}>
      {failed ? 'Could not save. Retry' : `${attest ? 'Attest' : 'Clear'} ${holder.displayName}`}
    </Button>
  );
}
