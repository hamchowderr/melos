'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveRepresentation } from '@/app/rights/licensing-actions';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import type { RightsHolderDTO } from '@/lib/dto/rights';

type Props = {
  interestType: 'publishing' | 'master';
  holder: RightsHolderDTO;
  /** The agreements an attestation can cite (§6.5), as options. */
  agreements?: { value: string; label: string }[];
};

/**
 * Attests, or clears, that the workspace may license another holder's share (RGT-005: "can you
 * just deal with me"), optionally backed by an agreement (§6.5). An attested holder counts as
 * controlled, so the song can be One Stop Ready. The self party needs no attestation, so it shows
 * no control.
 */
export function RepresentationControls({ interestType, holder, agreements = [] }: Props) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [agreementId, setAgreementId] = useState('');
  const [pending, startTransition] = useTransition();
  if (holder.isSelf) return null;
  const attest = !holder.representationAttested;
  const toggle = () =>
    startTransition(async () => {
      const input = { interestType, interestId: holder.interestId, attested: attest };
      const backed = attest && agreementId ? { agreementId } : {};
      const result = await saveRepresentation({ ...input, ...backed }).catch(() => null);
      setFailed(!result?.ok);
      if (result?.ok) router.refresh();
    });
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {attest && agreements.length ? (
        <NativeSelect
          size="sm"
          aria-label={`Agreement for ${holder.displayName}`}
          value={agreementId}
          onChange={(event) => setAgreementId(event.target.value)}
        >
          <NativeSelectOption value="">No agreement</NativeSelectOption>
          {agreements.map(({ value, label }) => (
            <NativeSelectOption key={value} value={value}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={toggle}>
        {failed ? 'Could not save. Retry' : `${attest ? 'Attest' : 'Clear'} ${holder.displayName}`}
      </Button>
    </span>
  );
}
