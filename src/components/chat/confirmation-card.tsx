'use client';

import { useState } from 'react';
import { ToolCard } from '@/components/chat/tool-card';
import { Button } from '@/components/ui/button';
import type { ApprovalDecision, ApprovalRequest, ApprovalRow } from '@/lib/agent/approval';
import { formatShare } from '@/lib/shares';

function Rows({ label, rows }: { label: string; rows: ApprovalRow[] }) {
  return (
    <div className="min-w-0 flex-1">
      <h4 className="px-4 pb-1 text-xs text-muted-foreground">{label}</h4>
      {rows.length === 0 ? (
        <p className="px-4 py-2 text-muted-foreground">None</p>
      ) : (
        <ul aria-label={label} className="flex flex-col">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-4 py-1.5 odd:bg-muted/30">
              <span className="min-w-0 flex-1">
                {row.label}
                {row.detail ? (
                  <span className="text-muted-foreground">{` · ${row.detail}`}</span>
                ) : null}
              </span>
              {row.shareBp === undefined ? null : (
                <span className="tabular-nums">
                  {row.shareBp === null ? '—' : formatShare(row.shareBp)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The approval a suspended write asks for (§2.3, §7.4 steps 4 and 5): what changes, before and
 * after. Approve and Decline both answer with the request's inputHash, so a decline also resumes
 * the tool and is audited (AUD-002); the buttons lock once an answer is sent.
 */
export function ConfirmationCard({
  request,
  onDecide,
}: {
  request: ApprovalRequest;
  onDecide: (decision: ApprovalDecision) => Promise<unknown>;
}) {
  const [sent, setSent] = useState<'approved' | 'declined' | null>(null);
  const decide = (approved: boolean) => {
    if (sent) return;
    setSent(approved ? 'approved' : 'declined');
    void onDecide({ approved, inputHash: request.inputHash });
  };
  return (
    <ToolCard title="Approve This Change">
      <p className="px-4 pb-3">{request.summary}</p>
      <div className="flex flex-col gap-3 pb-3 sm:flex-row">
        <Rows label="Before" rows={request.before} />
        <Rows label="After" rows={request.after} />
      </div>
      <div className="flex items-center gap-2 px-4 pb-4">
        {sent ? (
          <p role="status" className="text-muted-foreground">
            {sent === 'approved' ? 'Approved. Saving...' : 'Declined. Nothing will change.'}
          </p>
        ) : (
          <>
            <Button size="sm" onClick={() => decide(true)}>
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide(false)}>
              Decline
            </Button>
          </>
        )}
      </div>
    </ToolCard>
  );
}
