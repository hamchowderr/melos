import { createTool } from '@mastra/core/tools';
import { approvalDecisionSchema, approvalRequestSchema } from '../../lib/agent/approval';
import {
  UPDATE_WRITER_SHARES_TOOL_NAME,
  writerSharesInputSchema,
} from '../../lib/agent/rights-write-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { RightsSummaryDTO } from '../../lib/dto/rights';
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
