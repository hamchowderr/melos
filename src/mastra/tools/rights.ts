import { createTool } from '@mastra/core/tools';
import {
  catalogFocusSchema,
  defaultOwnershipInputSchema,
  GET_READINESS_ISSUES_TOOL_NAME,
  GET_RIGHTS_SUMMARY_TOOL_NAME,
  PROPOSE_DEFAULT_OWNERSHIP_TOOL_NAME,
  readinessIssuesInputSchema,
} from '../../lib/agent/catalog-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { CatalogFocus } from '../../lib/dto/catalog';
import type {
  DefaultOwnershipProposal,
  ReadinessIssue,
  ReadinessReportDTO,
  RightsHolderDTO,
  RightsSummaryDTO,
} from '../../lib/dto/rights';
import { proposeDefaultOwnership } from '../../server/services/rights/default-ownership';
import { getReadinessIssues, getRightsSummary } from '../../server/services/rights/read';
import { modelOutput, runTool } from './run-tool';

const codes = (issues: ReadinessIssue[]) => [...new Set(issues.map(({ code }) => code))];
const holder = ({ interestId, partyId, displayName, shareBp }: RightsHolderDTO) => ({
  interestId,
  partyId,
  displayName,
  shareBp,
});

/** getRightsSummary's §3.6 model fields. Licensing contacts stay in the UI. */
export const summarizeRights = (dto: RightsSummaryDTO) => ({
  compositionId: dto.compositionId,
  writers: dto.writers,
  writerTotalBp: dto.writerTotalBp,
  publishing: dto.publishing.map(({ territory, totalBp, holders }) => ({
    territory,
    totalBp,
    holders: holders.map((h) => ({
      ...holder(h),
      isSelf: h.isSelf,
      representationAttested: h.representationAttested,
    })),
  })),
  masters: dto.masters.map(({ recordingId, totalBp, holders }) => ({
    recordingId,
    totalBp,
    holders: holders.map(holder),
  })),
  issueCodes: codes(dto.issues),
});

/** getReadinessIssues's §3.6 model fields: one entry per recording with its issue codes. */
export const summarizeReadiness = (dto: ReadinessReportDTO) =>
  dto.recordings.map(({ recordingId, compositionId, title, oneStopReady, syncReady, issues }) => ({
    recordingId,
    compositionId,
    title,
    oneStopReady,
    syncReady,
    issueCodes: codes(issues),
  }));

/** proposeDefaultOwnership's §3.6 model fields: proposed rows with party ids, and why not. */
export const summarizeProposal = ({
  writerShares,
  publishingShares,
  masterShares,
  blockedReasons,
}: DefaultOwnershipProposal) => ({ writerShares, publishingShares, masterShares, blockedReasons });

export const getRightsSummaryTool = createTool({
  id: GET_RIGHTS_SUMMARY_TOOL_NAME,
  description:
    "Who owns a song: writers with roles and shares, publishing per territory, masters per recording, representation, and the song's readiness issue codes. Shares are basis points (10000 = 100%).",
  inputSchema: catalogFocusSchema,
  outputSchema: toolResultSchema<RightsSummaryDTO>(),
  execute: (input, context) => runTool(context, (tenant) => getRightsSummary(tenant, input)),
  toModelOutput: modelOutput(summarizeRights),
});

export const getReadinessIssuesTool = createTool({
  id: GET_READINESS_ISSUES_TOOL_NAME,
  description:
    'Which recordings are not one-stop or sync ready, and why. Without an id it covers the whole catalog; onlyNotReady defaults to true.',
  inputSchema: readinessIssuesInputSchema,
  outputSchema: toolResultSchema<ReadinessReportDTO>(),
  execute: (input, context) => runTool(context, (tenant) => getReadinessIssues(tenant, input)),
  toModelOutput: modelOutput(summarizeReadiness),
});

export const proposeDefaultOwnershipTool = createTool({
  id: PROPOSE_DEFAULT_OWNERSHIP_TOOL_NAME,
  description:
    "Propose the workspace's own parties at 100% for a song's empty writer, publishing or master sides. Writes nothing; a side that already has rows is never overwritten.",
  inputSchema: defaultOwnershipInputSchema,
  outputSchema: toolResultSchema<DefaultOwnershipProposal>(),
  execute: ({ compositionId, recordingId, sides }, context) =>
    runTool(context, async (tenant) => {
      const focus: CatalogFocus = recordingId
        ? { entityType: 'recording', entityId: recordingId }
        : { entityType: 'composition', entityId: compositionId ?? '' };
      const result = await proposeDefaultOwnership(tenant, focus);
      if (!result.ok || !sides) return result;
      const keep = new Set<string>(sides);
      const p = result.value;
      return {
        ok: true,
        value: {
          ...p,
          writerShares: keep.has('writer') ? p.writerShares : null,
          publishingShares: keep.has('publishing') ? p.publishingShares : null,
          masterShares: keep.has('master') ? p.masterShares : null,
          blockedReasons: p.blockedReasons.filter(({ side }) => keep.has(side)),
        },
      };
    }),
  toModelOutput: modelOutput(summarizeProposal),
});
