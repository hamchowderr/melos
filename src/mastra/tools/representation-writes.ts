import { createTool } from '@mastra/core/tools';
import { approvalDecisionSchema, approvalRequestSchema } from '../../lib/agent/approval';
import {
  ATTEST_REPRESENTATION_TOOL_NAME,
  licensingContactsInputSchema,
  representationInputSchema,
  UPDATE_LICENSING_CONTACTS_TOOL_NAME,
} from '../../lib/agent/rights-write-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { RightsSummaryDTO } from '../../lib/dto/rights';
import {
  attestRepresentation,
  previewLicensingContacts,
  previewRepresentation,
  updateLicensingContacts,
} from '../../server/services/rights/representation';
import { approvedWrite } from './approval';
import { modelOutput } from './run-tool';

/** The §3.6 summary of an approved representation or contact write. */
export const summarizeRepresentation = (dto: RightsSummaryDTO) => ({
  updated: 'representation' as const,
  compositionId: dto.compositionId,
  licensingContacts: dto.licensingContacts.map(({ partyId, displayName }) => ({
    partyId,
    displayName,
  })),
  issueCodes: [...new Set(dto.issues.map(({ code }) => code))],
});

/** attestRepresentation (§3.3): write-sensitive, so every agent call asks first (§6.3). */
export const attestRepresentationTool = createTool({
  id: ATTEST_REPRESENTATION_TOOL_NAME,
  description:
    'Attest, or clear, that the workspace represents one publishing or master interest. Always asks the member to approve first.',
  inputSchema: representationInputSchema,
  outputSchema: toolResultSchema<RightsSummaryDTO>(),
  suspendSchema: approvalRequestSchema,
  resumeSchema: approvalDecisionSchema,
  execute: approvedWrite({
    toolName: ATTEST_REPRESENTATION_TOOL_NAME,
    kind: 'representation',
    permissions: { rights: ['update'] },
    preview: async (tenant, input) => {
      const preview = await previewRepresentation(tenant, input);
      if (!preview.ok) return preview;
      const [holder] = preview.value.after;
      const verb = input.attested ? 'Attest representation of' : 'Clear the representation of';
      return { ok: true, value: { ...preview.value, summary: `${verb} ${holder.label}.` } };
    },
    apply: (tenant, input, expectedBeforeHash, origin) =>
      attestRepresentation(tenant, { ...input, expectedBeforeHash }, origin),
  }),
  toModelOutput: modelOutput(summarizeRepresentation),
});

/** updateLicensingContacts (§3.3): write-sensitive, so every agent call asks first (§6.3). */
export const updateLicensingContactsTool = createTool({
  id: UPDATE_LICENSING_CONTACTS_TOOL_NAME,
  description:
    'Replace who clears licenses for one recording or composition with the full contact set. Always asks the member to approve first.',
  inputSchema: licensingContactsInputSchema,
  outputSchema: toolResultSchema<RightsSummaryDTO>(),
  suspendSchema: approvalRequestSchema,
  resumeSchema: approvalDecisionSchema,
  execute: approvedWrite({
    toolName: UPDATE_LICENSING_CONTACTS_TOOL_NAME,
    kind: 'licensing_contact',
    permissions: { rights: ['update'] },
    preview: async (tenant, input) => {
      const preview = await previewLicensingContacts(tenant, input);
      if (!preview.ok) return preview;
      const names = preview.value.after.map(({ label }) => label).join(', ') || 'no one';
      const target = input.recordingId
        ? { entityType: 'recording', entityId: input.recordingId }
        : { entityType: 'composition', entityId: input.compositionId ?? '' };
      return {
        ok: true,
        value: { ...preview.value, target, summary: `Set the licensing contacts to ${names}.` },
      };
    },
    apply: (tenant, input, expectedBeforeHash, origin) =>
      updateLicensingContacts(tenant, { ...input, expectedBeforeHash }, origin),
  }),
  toModelOutput: modelOutput(summarizeRepresentation),
});
