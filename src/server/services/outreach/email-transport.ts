import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getServerEnv } from '../../env';
import { ResendEmailTransport } from './resend-transport';

/** One outbound email (§7.5). `messageId` is the idempotency key. */
export type EmailPayload = {
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
};

export type EmailReceipt = {
  providerMessageId: string;
  providerThreadId?: string;
  acceptedAt: string;
};

/** The adapter every send goes through (§7.5, OUT-002). */
export interface EmailTransport {
  readonly provider: 'sandbox' | 'resend';
  /** The verified sender this transport always uses; unset sends from the member's address. */
  readonly from?: string;
  send(
    input: EmailPayload & { pitchId?: string | null; workspaceId: string },
  ): Promise<EmailReceipt>;
}

/**
 * SandboxEmailTransport (§7.5): no network. `sandbox_<messageId>` and `sandbox_thread_<pitchId>`,
 * the payload kept in memory, or under `<dir>/<workspaceId>/<messageId>.json` when `dir` is set, and
 * the stored receipt returned for a repeated messageId.
 */
export class SandboxEmailTransport implements EmailTransport {
  readonly provider = 'sandbox' as const;
  readonly sent = new Map<string, EmailPayload & { receipt: EmailReceipt }>();

  constructor(private readonly dir?: string) {}

  private file(workspaceId: string, messageId: string) {
    return this.dir ? path.join(this.dir, workspaceId, `${messageId}.json`) : null;
  }

  async send({
    pitchId,
    workspaceId,
    ...payload
  }: EmailPayload & { pitchId?: string | null; workspaceId: string }) {
    const kept = this.sent.get(payload.messageId);
    if (kept) return kept.receipt;
    const file = this.file(workspaceId, payload.messageId);
    if (file) {
      const stored = await readFile(file, 'utf8').catch(() => null);
      if (stored) return (JSON.parse(stored) as { receipt: EmailReceipt }).receipt;
    }
    const receipt: EmailReceipt = {
      providerMessageId: `sandbox_${payload.messageId}`,
      ...(pitchId ? { providerThreadId: `sandbox_thread_${pitchId}` } : {}),
      acceptedAt: new Date().toISOString(),
    };
    this.sent.set(payload.messageId, { ...payload, receipt });
    if (file) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ ...payload, receipt }, null, 2));
    }
    return receipt;
  }
}

/** Sandbox selected in production (P-14): every send fails, and nothing pretends to deliver. */
class UnavailableEmailTransport implements EmailTransport {
  readonly provider = 'sandbox' as const;
  async send(): Promise<EmailReceipt> {
    throw new Error('No production email transport (MELOS_EMAIL_TRANSPORT=resend is unset, U-28)');
  }
}

let transport: EmailTransport | undefined;

/**
 * The transport for this process (§7.5): Resend when MELOS_EMAIL_TRANSPORT=resend, otherwise the
 * sandbox, in memory under tests and on Vercel and in `.data/sandbox-outbox` in development.
 * Production with the sandbox selected refuses every send.
 */
export function getEmailTransport(): EmailTransport {
  if (!transport) {
    const env = getServerEnv();
    if (env.emailTransport === 'resend' && env.resend) {
      transport = new ResendEmailTransport(env.resend);
    } else if (env.emailTransport === 'unavailable') {
      transport = new UnavailableEmailTransport();
    } else {
      // Vercel has no writable project directory, so preview keeps the outbox in memory (P-34).
      const memory = process.env.VITEST || env.onVercel;
      transport = new SandboxEmailTransport(memory ? undefined : '.data/sandbox-outbox');
    }
  }
  return transport;
}

/** Replaces the process transport, for tests. */
export function setEmailTransport(next: EmailTransport | undefined): void {
  transport = next;
}
