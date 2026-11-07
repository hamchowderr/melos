import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pitchEvents } from '../../src/server/db/schema/workspace.generated';
import type { EmailTransport } from '../../src/server/services/outreach/email-transport';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let drafts: typeof import('../../src/server/services/outreach/drafts');
let update: typeof import('../../src/server/services/outreach/update-draft');
let send: typeof import('../../src/server/services/outreach/send');
let pitches: typeof import('../../src/server/services/pitches/read');
let writes: typeof import('../../src/server/services/pitches/write');
let sandbox: InstanceType<
  typeof import('../../src/server/services/outreach/email-transport')['SandboxEmailTransport']
>;
let owner: TenantContext;
const k = NORTHSTAR.keys;
const DAY_MS = 86_400_000;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const open = () => services.connections.getWorkspaceDatabase(owner.workspaceId);
const followUp = {
  pitchId: k.pit_PAPER_REBECCA,
  purpose: 'follow_up',
  subject: 'Re: Paper Planes at 2AM: one-stop track for sync',
  bodyText: 'Hi Rebecca, checking in.',
  replyToMessageId: k.msg_PAPER_1,
} as const;
/** The hashes an approval would bind for this message right now. */
const binding = async (messageId: string) => {
  const message = await drafts.loadMessage(await open(), messageId);
  if (!message) throw new Error('no message');
  return { beforeHash: send.sendBeforeHashOf(message), contentHash: drafts.contentHashOf(message) };
};

beforeAll(async () => {
  services = await prepareWorkspaceServices('outreach-send');
  drafts = await import('../../src/server/services/outreach/drafts');
  update = await import('../../src/server/services/outreach/update-draft');
  send = await import('../../src/server/services/outreach/send');
  pitches = await import('../../src/server/services/pitches/read');
  writes = await import('../../src/server/services/pitches/write');
  const { SandboxEmailTransport } = await import(
    '../../src/server/services/outreach/email-transport'
  );
  sandbox = new SandboxEmailTransport();
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.7: sendMessage (OUT-002, OUT-004, P-39)', () => {
  it('DEMO-007: sends the follow-up, schedules the next one and leaves the cell as it is', async () => {
    const draft = accepted(await drafts.draftPitchMessage(owner, followUp));
    const expected = await binding(draft.messageId);
    const result = accepted(
      await send.sendMessage(owner, { messageId: draft.messageId, expected }, undefined, sandbox),
    );
    expect(result).toMatchObject({
      ...{ messageId: draft.messageId, status: 'sent', provider: 'sandbox' },
      ...{ providerMessageId: `sandbox_${draft.messageId}`, failureReason: null },
    });
    expect(sandbox.sent.get(draft.messageId)).toMatchObject({
      ...{ to: ['rebecca@cartersync.example'], from: 'jordan@silverline.example' },
    });
    const pitch = accepted(await pitches.getPitch(owner, k.pit_PAPER_REBECCA));
    expect(pitch.lastContactedAt).toBe(result.sentAt);
    expect(Date.parse(pitch.nextFollowUpAt ?? '') - Date.parse(result.sentAt ?? '')).toBe(
      7 * DAY_MS,
    );
    expect(pitch.items[0].currentStatus).toBe('awaiting_reply');
    expect(pitch.events.at(-1)).toMatchObject({
      ...{ eventType: 'message_sent', metadata: { messageId: draft.messageId } },
    });
    const due = accepted(
      await pitches.searchPitches(owner, { followUpDueOn: NORTHSTAR.demo.date }),
    );
    expect(due.map((cell) => cell.pitchItemId)).not.toContain(k.pti_PAPER_REBECCA);

    // A second call returns the stored result and sends nothing.
    const sends = sandbox.sent.size;
    expect(
      accepted(await send.sendMessage(owner, { messageId: draft.messageId }, undefined, sandbox)),
    ).toEqual(result);
    expect(sandbox.sent.size).toBe(sends);
  });

  it('OUT-INT-004: an edit after the approval request returns STATE_CHANGED and sends nothing', async () => {
    const draft = accepted(await drafts.draftPitchMessage(owner, followUp));
    const expected = await binding(draft.messageId);
    accepted(
      await update.updateMessageDraft(owner, { messageId: draft.messageId, bodyText: 'Edited' }),
    );
    expect(
      await send.sendMessage(owner, { messageId: draft.messageId, expected }, undefined, sandbox),
    ).toEqual({ ok: false, error: { code: 'STATE_CHANGED' } });
    expect(sandbox.sent.has(draft.messageId)).toBe(false);
    expect(accepted(await drafts.getMessageDraft(owner, draft.messageId)).status).toBe('draft');
  });

  it('moves draft cells to sent and records a failed send', async () => {
    const pitch = accepted(
      await writes.createPitch(owner, {
        ...{ contactId: k.con_MALIK, items: [{ itemType: 'recording', itemId: k.rec_HOME }] },
      }),
    );
    const initial = {
      pitchId: pitch.pitchId,
      purpose: 'initial',
      subject: 'Home Again',
      bodyText: 'Hi',
    } as const;
    const first = accepted(await drafts.draftPitchMessage(owner, initial));
    accepted(await send.sendMessage(owner, { messageId: first.messageId }, undefined, sandbox));
    const sent = accepted(await pitches.getPitch(owner, pitch.pitchId));
    expect(sent.items[0].currentStatus).toBe('sent');
    expect(sent.events.map((event) => [event.eventType, event.actorType]).slice(-2)).toEqual([
      ['message_sent', 'system'],
      ['status_changed', 'system'],
    ]);

    const conflict: EmailTransport = {
      provider: 'resend',
      send: () => Promise.reject(Object.assign(new Error('409'), { code: 'IDEMPOTENCY_CONFLICT' })),
    };
    const second = accepted(
      await drafts.draftPitchMessage(owner, { ...initial, purpose: 'follow_up' }),
    );
    expect(
      accepted(await send.sendMessage(owner, { messageId: second.messageId }, undefined, conflict)),
    ).toMatchObject({ status: 'failed', failureReason: 'IDEMPOTENCY_CONFLICT', sentAt: null });
    const events = await (await open())
      .select()
      .from(pitchEvents)
      .where(eq(pitchEvents.pitchId, pitch.pitchId));
    expect(events.filter((event) => event.eventType === 'message_failed')).toHaveLength(1);
    expect(await (await open()).all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('refuses no recipient, an inbound or unknown message, and roles without outreach:send', async () => {
    const draft = accepted(await drafts.draftPitchMessage(owner, followUp));
    accepted(await update.updateMessageDraft(owner, { messageId: draft.messageId, to: [] }));
    expect(
      await send.sendMessage(owner, { messageId: draft.messageId }, undefined, sandbox),
    ).toEqual({
      ok: false,
      error: { code: 'VALIDATION', field: 'to', reason: 'required' },
    });
    expect(await send.sendMessage(owner, { messageId: 'msg_x' }, undefined, sandbox)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(
      await send.sendMessage(
        withRole(owner, 'viewer'),
        { messageId: draft.messageId },
        undefined,
        sandbox,
      ),
    ).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
