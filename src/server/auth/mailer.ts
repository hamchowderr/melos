import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { getServerEnv } from '../env';

/** An email Better Auth asks Melos to deliver. `link` is the action the recipient takes. */
export type AuthEmail = {
  kind: 'verify-email' | 'invitation';
  to: string;
  subject: string;
  text: string;
  link: string;
};

const memoryOutbox: AuthEmail[] = [];

/** Emails kept by the memory mailer, oldest first. */
export function readMemoryOutbox(): readonly AuthEmail[] {
  return memoryOutbox;
}

/**
 * The one auth mailer, mirroring SandboxEmailTransport (docs/CONTRACT.md §7.5): no network call,
 * JSON files under .data/auth-outbox/ in development, memory in tests. Production startup refuses
 * both (env.ts) until phase 8 points this at Resend. It never logs a body or a link.
 */
export async function sendAuthEmail(email: AuthEmail): Promise<void> {
  if (getServerEnv().authMailer === 'memory') {
    memoryOutbox.push(email);
    return;
  }
  const dir = '.data/auth-outbox';
  await mkdir(dir, { recursive: true });
  const file = `${dir}/${Date.now()}-${email.kind}-${randomUUID()}.json`;
  await writeFile(file, JSON.stringify({ ...email, createdAt: new Date().toISOString() }, null, 2));
}
