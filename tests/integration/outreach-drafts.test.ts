import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let drafts: typeof import('../../src/server/services/outreach/drafts');
let owner: TenantContext;
const k = NORTHSTAR.keys;
const REBECCA_EMAIL = k['contact_methods:REBECCA_EMAIL'];

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const refusal = (error: object) => ({ ok: false, error });
const open = () => services.connections.getWorkspaceDatabase(owner.workspaceId);
const auditCount = async () =>
  (await (await open()).all<{ n: number }>(sql`SELECT count(*) AS n FROM audit_log`))[0].n;
const followUp = {
  pitchId: k.pit_PAPER_REBECCA,
  purpose: 'follow_up',
  subject: 'Re: Paper Planes at 2AM: one-stop track for sync',
  bodyText: 'Hi Rebecca, checking in on Paper Planes at 2AM.',
  replyToMessageId: k.msg_PAPER_1,
} as const;

beforeAll(async () => {
  services = await prepareWorkspaceServices('outreach-drafts');
  drafts = await import('../../src/server/services/outreach/drafts');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.6: draftPitchMessage and updateMessageDraft (OUT-001, OUT-004)', () => {
  it('DEMO-006: drafts the follow-up to Rebecca with its source facts', async () => {
    const audits = await auditCount();
    const draft = accepted(await drafts.draftPitchMessage(owner, followUp));
    expect(draft).toMatchObject({
      ...{ pitchId: k.pit_PAPER_REBECCA, purpose: 'follow_up', status: 'draft' },
      subject: followUp.subject,
      to: [{ contactMethodId: REBECCA_EMAIL, address: 'rebecca@cartersync.example' }],
      ...{ cc: [], bcc: [] },
      sourceFacts: {
        contactName: 'Rebecca Carter',
        items: [{ itemType: 'recording', itemId: k.rec_PAPER, title: 'Paper Planes at 2AM' }],
        replyToMessageId: k.msg_PAPER_1,
        generatedReportId: null,
      },
    });
    expect(draft.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await auditCount()).toBe(audits + 1);
    const [row] = await (await open())
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, draft.messageId));
    expect(row.action).toBe('message.draft_created');
  });

  it('refuses bad input and roles without outreach:draft', async () => {
    const audits = await auditCount();
    expect(await drafts.draftPitchMessage(owner, { ...followUp, subject: ' ' })).toEqual(
      refusal({ code: 'VALIDATION', field: 'subject', reason: 'required' }),
    );
    expect(
      await drafts.draftPitchMessage(owner, { ...followUp, replyToMessageId: k.msg_NEON_MAYA_1 }),
    ).toEqual(refusal({ code: 'NOT_FOUND' }));
    expect(await drafts.draftPitchMessage(withRole(owner, 'viewer'), followUp)).toEqual(
      refusal({ code: 'FORBIDDEN' }),
    );
    expect(await drafts.getMessageDraft(owner, k.msg_PAPER_1)).toEqual(
      refusal({ code: 'NOT_FOUND' }),
    );
    expect(await auditCount()).toBe(audits);
  });
});
