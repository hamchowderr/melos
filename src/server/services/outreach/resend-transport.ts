import type { EmailPayload, EmailReceipt, EmailTransport } from './email-transport';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** A refused Resend call. `code` is IDEMPOTENCY_CONFLICT for a reused key (§7.5). */
export class ResendError extends Error {
  constructor(
    readonly code: 'IDEMPOTENCY_CONFLICT' | 'TRANSPORT_ERROR',
    readonly status: number,
  ) {
    super(`Resend refused the email (${status}, ${code})`);
  }
}

/**
 * ResendEmailTransport (§7.5, OUT-005): one POST to Resend's emails API, from the verified
 * MELOS_EMAIL_FROM sender, with `messageId` as the Idempotency-Key. A repeated key with the same
 * payload returns the original email id; a 409 invalid_idempotent_request is IDEMPOTENCY_CONFLICT.
 * The API key never appears in an error.
 */
export class ResendEmailTransport implements EmailTransport {
  readonly provider = 'resend' as const;
  readonly from: string;

  constructor(
    private readonly config: { apiKey: string; from: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.from = config.from;
  }

  /** Sends one email; `send` and the auth mailer both come through here. */
  async deliver(payload: EmailPayload): Promise<EmailReceipt> {
    const response = await this.fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': payload.messageId,
      },
      body: JSON.stringify({
        from: this.config.from,
        to: payload.to,
        ...(payload.cc.length ? { cc: payload.cc } : {}),
        ...(payload.bcc.length ? { bcc: payload.bcc } : {}),
        subject: payload.subject,
        text: payload.bodyText,
        ...(payload.bodyHtml ? { html: payload.bodyHtml } : {}),
      }),
    });
    const body = (await response.json().catch(() => null)) as { id?: string; name?: string } | null;
    if (response.ok && body?.id) {
      return { providerMessageId: body.id, acceptedAt: new Date().toISOString() };
    }
    const conflict = response.status === 409 && body?.name === 'invalid_idempotent_request';
    throw new ResendError(conflict ? 'IDEMPOTENCY_CONFLICT' : 'TRANSPORT_ERROR', response.status);
  }

  send({
    pitchId: _pitchId,
    workspaceId: _workspaceId,
    ...payload
  }: Parameters<EmailTransport['send']>[0]) {
    return this.deliver(payload);
  }
}
