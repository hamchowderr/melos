import type { CatalogFocus } from '../../../lib/dto/catalog';
import type { DefaultOwnershipProposal } from '../../../lib/dto/rights';
import type { SelfPartySide } from '../../../lib/dto/self-parties';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getRightsSummary } from './read';
import { getSelfParties } from './self-parties';

type Blocked = DefaultOwnershipProposal['blockedReasons'];

/**
 * Proposes the workspace's own parties at 100% for a song's empty share sets (RGT-008) with
 * rights:read; it writes nothing. A side that already has rows, has no self party, or has no
 * composition to hold it is null with a reason, so a proposal never overwrites (owner decision
 * 2026-09-12). The user reviews it and saves it through the normal share tools.
 */
export async function proposeDefaultOwnership(
  tenant: TenantContext,
  focus: CatalogFocus,
): Promise<ServiceResult<DefaultOwnershipProposal>> {
  const [self, rights] = await Promise.all([
    getSelfParties(tenant),
    getRightsSummary(tenant, focus),
  ]);
  if (!self.ok) return failure(self.error);
  if (!rights.ok) return failure(rights.error);
  const selfParties = self.value;
  const { compositionId, writers, publishing, masters } = rights.value;
  const blockedReasons: Blocked = [];
  /** The side's self party when the side can be filled, otherwise null with its reason. */
  const fillable = (side: SelfPartySide, hasRows: boolean, songLevel: boolean) => {
    const code = songLevel && !compositionId ? 'no_composition' : hasRows ? 'has_rows' : null;
    const party = selfParties[side];
    if (code || !party) blockedReasons.push({ side, code: code ?? 'no_self_party' });
    return code ? null : party;
  };

  const writer = fillable('writer', writers.length > 0, true);
  const publisher = fillable('publishing', publishing.length > 0, true);
  const empty = masters.filter(({ holders }) => holders.length === 0);
  const master = fillable('master', empty.length === 0, false);
  return success({
    selfParties,
    writerShares: writer
      ? [{ partyId: writer.partyId, roles: ['songwriter'], shareBp: 10_000 }]
      : null,
    publishingShares: publisher
      ? { territory: 'WORLD', shares: [{ partyId: publisher.partyId, shareBp: 10_000 }] }
      : null,
    masterShares: master
      ? empty.map(({ recordingId }) => ({
          recordingId,
          shares: [{ partyId: master.partyId, shareBp: 10_000 }],
        }))
      : null,
    blockedReasons,
  });
}
