import { createTool } from '@mastra/core/tools';
import { approvalDecisionSchema, approvalRequestSchema } from '../../lib/agent/approval';
import {
  masterSharesInputSchema,
  publishingSharesInputSchema,
  UPDATE_MASTER_SHARES_TOOL_NAME,
  UPDATE_PUBLISHING_SHARES_TOOL_NAME,
  UPDATE_WRITER_SHARES_TOOL_NAME,
  writerSharesInputSchema,
} from '../../lib/agent/rights-write-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { RightsSummaryDTO } from '../../lib/dto/rights';
import {
  previewMasterShares,
  previewPublishingShares,
  updateMasterShares,
  updatePublishingShares,
} from '../../server/services/rights/holder-shares';
import { previewWriterShares, updateWriterShares } from '../../server/services/rights/shares';
import { approvedWrite } from './approval';
import { modelOutput } from './run-tool';

/** The §3.6 summary of an approved write: the changed composition and its new writer totals. */
export const summarizeWriterShares = (dto: RightsSummaryDTO) => ({
  updated: 'writerShares' as const,
  compositionId: dto.compositionId,
  writers: dto.writers.map(({ partyId, displayName, shareBp }) => ({
    partyId,
    displayName,
    shareBp,
  })),
  writerTotalBp: dto.writerTotalBp,
});

const percent = (bp: number | null | undefined) => (bp == null ? 'unset' : `${bp / 100}%`);

/** updateWriterShares (§3.3): write-sensitive, so every agent call stops for approval (§6.3). */
export const updateWriterSharesTool = createTool({
  id: UPDATE_WRITER_SHARES_TOOL_NAME,
  description:
    "Replace a composition's writer split with the full set of writers, roles and shares. Always asks the member to approve first; nothing changes until they do. Shares are basis points (10000 = 100%).",
  inputSchema: writerSharesInputSchema,
  outputSchema: toolResultSchema<RightsSummaryDTO>(),
  suspendSchema: approvalRequestSchema,
  resumeSchema: approvalDecisionSchema,
  execute: approvedWrite({
    toolName: UPDATE_WRITER_SHARES_TOOL_NAME,
    kind: 'rights_change',
    permissions: { rights: ['update'] },
    preview: async (tenant, input) => {
      const preview = await previewWriterShares(tenant, input);
      if (!preview.ok) return preview;
      const { title, ...shown } = preview.value;
      const split = shown.after.map((row) => `${row.label} ${percent(row.shareBp)}`).join(', ');
      return {
        ok: true,
        value: {
          ...shown,
          target: { entityType: 'composition', entityId: input.compositionId },
          summary: `Change the writer split on ${title}: ${split}.`,
        },
      };
    },
    apply: (tenant, input, expectedBeforeHash, origin) =>
      updateWriterShares(tenant, { ...input, expectedBeforeHash }, origin),
  }),
  toModelOutput: modelOutput(summarizeWriterShares),
});

/** The §3.6 summary of an approved holder write: the changed sets' totals and holders. */
export const summarizeHolderShares = (dto: RightsSummaryDTO) => ({
  updated: 'holderShares' as const,
  compositionId: dto.compositionId,
  publishing: dto.publishing.map(({ territory, totalBp }) => ({ territory, totalBp })),
  masters: dto.masters.map(({ recordingId, totalBp }) => ({ recordingId, totalBp })),
});

const splitOf = (rows: { label: string; shareBp?: number | null }[]) =>
  rows.map((row) => `${row.label} ${percent(row.shareBp)}`).join(', ') || 'no holders';

/** updatePublishingShares (§3.3): one territory's full publisher set, always approved first. */
export const updatePublishingSharesTool = createTool({
  id: UPDATE_PUBLISHING_SHARES_TOOL_NAME,
  description:
    "Replace one territory's publishing split on a composition with the full set of publishers and shares. Always asks the member to approve first. Shares are basis points.",
  inputSchema: publishingSharesInputSchema,
  outputSchema: toolResultSchema<RightsSummaryDTO>(),
  suspendSchema: approvalRequestSchema,
  resumeSchema: approvalDecisionSchema,
  execute: approvedWrite({
    toolName: UPDATE_PUBLISHING_SHARES_TOOL_NAME,
    kind: 'rights_change',
    permissions: { rights: ['update'] },
    preview: async (tenant, { compositionId, territory, shares }) => {
      const held = shares.map(({ publisherPartyId: partyId, ...rest }) => ({ partyId, ...rest }));
      const preview = await previewPublishingShares(tenant, {
        compositionId,
        territory,
        shares: held,
      });
      if (!preview.ok) return preview;
      const summary = `Change the ${territory} publishing split: ${splitOf(preview.value.after)}.`;
      const target = { entityType: 'composition', entityId: compositionId };
      return { ok: true, value: { ...preview.value, summary, target } };
    },
    apply: (tenant, { compositionId, territory, shares }, expectedBeforeHash, origin) => {
      const held = shares.map(({ publisherPartyId: partyId, ...rest }) => ({ partyId, ...rest }));
      const input = { compositionId, territory, shares: held, expectedBeforeHash };
      return updatePublishingShares(tenant, input, origin);
    },
  }),
  toModelOutput: modelOutput(summarizeHolderShares),
});

/** updateMasterShares (§3.3): one recording's full owner set, always approved first. */
export const updateMasterSharesTool = createTool({
  id: UPDATE_MASTER_SHARES_TOOL_NAME,
  description:
    "Replace a recording's master split with the full set of owners and shares. Always asks the member to approve first. Shares are basis points.",
  inputSchema: masterSharesInputSchema,
  outputSchema: toolResultSchema<RightsSummaryDTO>(),
  suspendSchema: approvalRequestSchema,
  resumeSchema: approvalDecisionSchema,
  execute: approvedWrite({
    toolName: UPDATE_MASTER_SHARES_TOOL_NAME,
    kind: 'rights_change',
    permissions: { rights: ['update'] },
    preview: async (tenant, { recordingId, shares }) => {
      const held = shares.map(({ ownerPartyId: partyId, ...rest }) => ({ partyId, ...rest }));
      const preview = await previewMasterShares(tenant, { recordingId, shares: held });
      if (!preview.ok) return preview;
      const summary = `Change the master split: ${splitOf(preview.value.after)}.`;
      const target = { entityType: 'recording', entityId: recordingId };
      return { ok: true, value: { ...preview.value, summary, target } };
    },
    apply: (tenant, { recordingId, shares }, expectedBeforeHash, origin) => {
      const held = shares.map(({ ownerPartyId: partyId, ...rest }) => ({ partyId, ...rest }));
      return updateMasterShares(tenant, { recordingId, shares: held, expectedBeforeHash }, origin);
    },
  }),
  toModelOutput: modelOutput(summarizeHolderShares),
});
