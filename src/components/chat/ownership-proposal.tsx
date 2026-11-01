import { ToolCard } from '@/components/chat/tool-card';
import type { DefaultOwnershipProposal } from '@/lib/dto/rights';
import { formatShare } from '@/lib/shares';

const SIDE = { writer: 'Writer', publishing: 'Publishing', master: 'Master' } as const;
const BLOCKED = {
  has_rows: 'already has shares, so it stays as it is',
  no_self_party: 'has no own party set in Settings',
  no_composition: 'has no composition',
} as const;

/** proposeDefaultOwnership's proposal state (§3.3, RGT-008): what would be filled, not saved. */
export function OwnershipProposal({ proposal }: { proposal: DefaultOwnershipProposal }) {
  const { selfParties, writerShares, publishingShares, masterShares, blockedReasons } = proposal;
  const several = (masterShares?.length ?? 0) > 1;
  const rows = [
    ...(writerShares ?? []).map((share) => ({
      side: 'Writer',
      name: selfParties.writer?.displayName,
      detail: share.roles.join(', '),
      shareBp: share.shareBp,
    })),
    ...(publishingShares?.shares ?? []).map((share) => ({
      side: 'Publishing',
      name: selfParties.publishing?.displayName,
      detail: publishingShares?.territory === 'WORLD' ? 'World' : publishingShares?.territory,
      shareBp: share.shareBp,
    })),
    ...(masterShares ?? []).flatMap((set, index) =>
      set.shares.map((share) => ({
        side: several ? `Master, recording ${index + 1}` : 'Master',
        name: selfParties.master?.displayName,
        detail: '',
        shareBp: share.shareBp,
      })),
    ),
  ];

  return (
    <ToolCard title="Proposed ownership">
      {rows.length > 0 ? (
        <ul aria-label="Proposed shares" className="flex flex-col">
          {rows.map((row) => (
            <li
              key={`${row.side} ${row.name}`}
              className="flex items-center gap-3 px-4 py-2 odd:bg-muted/30"
            >
              <span className="w-36 shrink-0 text-muted-foreground">{row.side}</span>
              <span className="min-w-0 flex-1">
                {row.name}
                {row.detail ? (
                  <span className="text-muted-foreground">{` · ${row.detail}`}</span>
                ) : null}
              </span>
              <span className="tabular-nums">
                {row.shareBp === null ? '—' : formatShare(row.shareBp)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {blockedReasons.length > 0 ? (
        <ul
          aria-label="Not proposed"
          className="flex flex-col gap-0.5 px-4 pt-2 text-muted-foreground"
        >
          {blockedReasons.map(({ side, code }) => (
            <li key={side}>{`${SIDE[side]} ${BLOCKED[code]}.`}</li>
          ))}
        </ul>
      ) : null}
      <p className="px-4 pt-2 pb-3 text-xs text-muted-foreground">
        A proposal only. Nothing is saved until you fill it in from the song page.
      </p>
    </ToolCard>
  );
}
