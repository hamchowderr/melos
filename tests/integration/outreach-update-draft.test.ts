import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let drafts: typeof import('../../src/server/services/outreach/drafts') &
  typeof import('../../src/server/services/outreach/update-draft');
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
  services = await prepareWorkspaceServices('outreach-update-draft');
  drafts = {
    ...(await import('../../src/server/services/outreach/drafts')),
    ...(await import('../../src/server/services/outreach/update-draft')),
  };
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.6: updateMessageDraft (OUT-004)', () => {
  it('saves edits, changing contentHash, and a no-op edit writes nothing', async () => {
    const draft = accepted(await drafts.draftPitchMessage(owner, followUp));
    const audits = await auditCount();
    const same = accepted(
      await drafts.updateMessageDraft(owner, {
        messageId: draft.messageId,
        subject: draft.subject,
      }),
    );
    expect(same.contentHash).toBe(draft.contentHash);
    expect(await auditCount()).toBe(audits);
    const edited = accepted(
      await drafts.updateMessageDraft(owner, {
        ...{ messageId: draft.messageId, bodyText: 'Hi Rebecca, any news?' },
        ...{ to: [], cc: [REBECCA_EMAIL] },
      }),
    );
    expect(edited).toMatchObject({ bodyText: 'Hi Rebecca, any news?', to: [] });
    expect(edited.cc).toEqual([
      { contactMethodId: REBECCA_EMAIL, address: 'rebecca@cartersync.example' },
    ]);
    expect(edited.contentHash).not.toBe(draft.contentHash);
    expect(await auditCount()).toBe(audits + 1);
    const database = await open();
    expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('refuses a sent message and a recipient that is not an email method', async () => {
    expect(
      await drafts.updateMessageDraft(owner, { messageId: k.msg_PAPER_1, subject: 'x' }),
    ).toEqual(refusal({ code: 'VALIDATION', field: 'messageId', reason: 'not_draft' }));
    const draft = accepted(await drafts.draftPitchMessage(owner, followUp));
    const phone = k['contact_methods:REBECCA_PHONE'];
    expect(
      await drafts.updateMessageDraft(owner, { messageId: draft.messageId, to: [phone] }),
    ).toEqual(refusal({ code: 'VALIDATION', field: 'to', reason: 'email_method_required' }));
  });
});
