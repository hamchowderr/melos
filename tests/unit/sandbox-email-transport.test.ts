import { describe, expect, it } from 'vitest';

describe('melos-ajt.6: SandboxEmailTransport (§7.5)', () => {
  it('sends nothing out and returns the stored receipt for a repeated messageId', async () => {
    const { SandboxEmailTransport } = await import(
      '../../src/server/services/outreach/email-transport'
    );
    const transport = new SandboxEmailTransport();
    const payload = {
      ...{ messageId: 'msg_1', from: 'a@x.example', to: ['b@x.example'], cc: [], bcc: [] },
      ...{ subject: 'Hi', bodyText: 'Body', pitchId: 'pit_1', workspaceId: 'ws_1' },
    };
    const first = await transport.send(payload);
    expect(first).toMatchObject({
      providerMessageId: 'sandbox_msg_1',
      providerThreadId: 'sandbox_thread_pit_1',
    });
    expect(await transport.send({ ...payload, subject: 'Changed' })).toEqual(first);
    expect(transport.sent.get('msg_1')?.subject).toBe('Hi');
  });
});
