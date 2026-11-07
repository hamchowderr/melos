import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messages } from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let replies: typeof import('../../src/server/services/outreach/replies');
let pitches: typeof import('../../src/server/services/pitches/read');
let owner: TenantContext;
const k = NORTHSTAR.keys;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeAll(async () => {
  services = await prepareWorkspaceServices('outreach-replies');
  replies = await import('../../src/server/services/outreach/replies');
  pitches = await import('../../src/server/services/pitches/read');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.8: inbound replies and getMessageThread (OUT-003)', () => {
  it('getMessageThread returns the DEMO-006 message with its body and addresses', async () => {
    const thread = accepted(
      await replies.getMessageThread(owner, { pitchId: k.pit_PAPER_REBECCA }),
    );
    expect(thread.messages).toMatchObject([
      {
        ...{ messageId: k.msg_PAPER_1, direction: 'outbound', status: 'sent' },
        ...{ from: 'jordan@silverline.example', to: ['rebecca@cartersync.example'] },
        sentAt: '2026-09-04T18:00:00.000Z',
      },
    ]);
    expect(thread.messages[0].bodyText).toBeTruthy();
    expect(accepted(await replies.getMessageThread(owner, { messageId: k.msg_PAPER_1 }))).toEqual(
      thread,
    );
    expect(await replies.getMessageThread(owner, { pitchId: 'pit_x' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('OUT-INT-003: a reply appends a message and an event and leaves the outbound row as it was', async () => {
    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    const [before] = await database.select().from(messages).where(eq(messages.id, k.msg_PAPER_1));
    const thread = accepted(
      await replies.simulateInboundReply(owner, {
        messageId: k.msg_PAPER_1,
        bodyText: 'Love it. Is it one-stop?',
      }),
    );
    expect(thread.messages.map((message) => [message.direction, message.status])).toEqual([
      ['outbound', 'sent'],
      ['inbound', 'received'],
    ]);
    expect(thread.messages[1]).toMatchObject({
      ...{
        inReplyToMessageId: k.msg_PAPER_1,
        purpose: 'reply',
        from: 'rebecca@cartersync.example',
      },
      subject: 'Re: Paper Planes at 2AM: one-stop track for sync',
    });
    const [after] = await database.select().from(messages).where(eq(messages.id, k.msg_PAPER_1));
    expect(after).toEqual(before);
    const pitch = accepted(await pitches.getPitch(owner, k.pit_PAPER_REBECCA));
    expect(pitch.items[0].currentStatus).toBe('responded');
    expect(pitch.events.slice(-2).map((event) => [event.eventType, event.toStatus])).toEqual([
      ['reply_received', null],
      ['status_changed', 'responded'],
    ]);
  });

  it('works only with the sandbox transport and only on a sent outbound message', async () => {
    const resend = { provider: 'resend' as const, send: () => Promise.reject(new Error('no')) };
    const reply = { messageId: k.msg_NEON_MAYA_1, bodyText: 'Thanks' };
    expect(await replies.simulateInboundReply(owner, reply, resend)).toEqual({
      ok: false,
      error: { code: 'VALIDATION', field: 'messageId', reason: 'sandbox_only' },
    });
    expect(await replies.simulateInboundReply(owner, { ...reply, messageId: 'msg_x' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});
