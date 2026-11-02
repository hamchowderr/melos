'use client';

import { useInterrupt } from '@copilotkit/react-core/v2';
import { ConfirmationCard } from '@/components/chat/confirmation-card';
import { type ApprovalRequest, approvalRequestSchema } from '@/lib/agent/approval';

type Suspension = { metadata?: { mastra?: { suspendPayload?: unknown } } } | null | undefined;

/**
 * The ApprovalRequest of a Mastra tool suspension (§7.4 step 4): from the standard interrupt's
 * metadata, or the legacy `on_interrupt` event's JSON value. Null for any other interrupt.
 */
export function approvalRequestOf(
  interrupt: Suspension,
  legacyValue?: unknown,
): ApprovalRequest | null {
  let payload = interrupt?.metadata?.mastra?.suspendPayload;
  if (payload === undefined && typeof legacyValue === 'string') {
    try {
      payload = (JSON.parse(legacyValue) as { suspendPayload?: unknown }).suspendPayload;
    } catch {
      return null;
    }
  }
  const parsed = approvalRequestSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Renders a ConfirmationCard in the chat for every approval interrupt. The answer always goes back
 * through `resolve`, never `cancel`: @ag-ui/mastra ends a cancelled interrupt without resuming the
 * tool, which would leave the decline unaudited (AUD-002).
 */
export function useApprovalInterrupts() {
  useInterrupt({
    enabled: (event) => approvalRequestOf(event.value as Suspension, event.value) !== null,
    render: ({ interrupt, event, resolve }) => {
      const request = approvalRequestOf(interrupt as Suspension, event.value);
      if (!request) return <span hidden />;
      return (
        <ConfirmationCard
          key={request.inputHash}
          request={request}
          onDecide={(decision) => resolve(decision, interrupt?.id)}
        />
      );
    },
  });
}
