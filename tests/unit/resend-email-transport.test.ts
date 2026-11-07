import { describe, expect, it } from 'vitest';
import {
  ResendEmailTransport,
  ResendError,
} from '../../src/server/services/outreach/resend-transport';

const CONFIG = { apiKey: 're_test_key_never_logged', from: 'Northstar <pitch@northstar.example>' };
const PAYLOAD = {
  ...{ messageId: 'msg_01', from: 'jordan@northstar.example', to: ['rebecca@cartersync.example'] },
  ...{ cc: [], bcc: ['jordan@northstar.example'], subject: 'Paper Planes at 2AM' },
  ...{ bodyText: 'Hi Rebecca', pitchId: 'pit_01', workspaceId: 'ws_01' },
};

/** A stub of Resend's emails API that records each request and answers with `reply`. */
function stubResend(reply: (key: string, body: string) => Response) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = String(init.body);
    requests.push({ url, headers, body: JSON.parse(body) });
    return reply(headers.get('idempotency-key') ?? '', body);
  }) as typeof fetch;
  return { requests, transport: new ResendEmailTransport(CONFIG, fetchImpl) };
}

describe('melos-ajt.9: ResendEmailTransport (OUT-INT-005)', () => {
  it('posts from the verified sender with the message id as idempotency key', async () => {
    const { requests, transport } = stubResend(() => Response.json({ id: 'resend_email_1' }));
    const receipt = await transport.send(PAYLOAD);
    expect(receipt).toMatchObject({ providerMessageId: 'resend_email_1' });
    expect(transport).toMatchObject({ provider: 'resend', from: CONFIG.from });
    const [request] = requests;
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(request.headers.get('authorization')).toBe(`Bearer ${CONFIG.apiKey}`);
    expect(request.headers.get('idempotency-key')).toBe('msg_01');
    expect(request.body).toEqual({
      ...{ from: CONFIG.from, to: ['rebecca@cartersync.example'] },
      ...{ bcc: ['jordan@northstar.example'], subject: 'Paper Planes at 2AM', text: 'Hi Rebecca' },
    });
  });

  it('returns the original id for a repeat and refuses a changed payload with a 409', async () => {
    const seen = new Map<string, string>();
    const { transport } = stubResend((key, body) => {
      const first = seen.get(key);
      if (first === undefined) seen.set(key, body);
      else if (first !== body)
        return Response.json({ name: 'invalid_idempotent_request' }, { status: 409 });
      return Response.json({ id: `resend_${key}` });
    });
    expect((await transport.send(PAYLOAD)).providerMessageId).toBe('resend_msg_01');
    expect((await transport.send(PAYLOAD)).providerMessageId).toBe('resend_msg_01');
    const changed = await transport.send({ ...PAYLOAD, subject: 'Other' }).catch((e) => e);
    expect(changed).toBeInstanceOf(ResendError);
    expect(changed).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('reports any other refusal as TRANSPORT_ERROR without the API key', async () => {
    const { transport } = stubResend(() =>
      Response.json({ name: 'validation_error', message: 'bad from' }, { status: 422 }),
    );
    const error = await transport.send(PAYLOAD).catch((e) => e);
    expect(error).toMatchObject({ code: 'TRANSPORT_ERROR', status: 422 });
    expect(String(error.message)).not.toContain(CONFIG.apiKey);
  });
});
