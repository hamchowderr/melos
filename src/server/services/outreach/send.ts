import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type { SendResultDTO } from '../../../lib/dto/outreach';
import { controlDb } from '../../db/client';
import { user } from '../../db/schema/auth';
import {
  messageRecipients,
  messages,
  pitchEvents,
  pitches,
  pitchItems,
  workspaceSettings,
} from '../../db/schema/workspace.generated';
import { canonicalJson } from '../audit-writer';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction, type WriteOrigin } from '../workspace-write';
import { contentHashOf, loadMessage } from './drafts';
import { type EmailTransport, getEmailTransport } from './email-transport';

const SEND: WorkspacePermissions = { outreach: ['send'] };
const DAY_MS = 86_400_000;

type Message = NonNullable<Awaited<ReturnType<typeof loadMessage>>>;

/** `beforeHash` for sendMessage (§7.4): the message row, its recipients and its status. */
export const sendBeforeHashOf = (message: Message) =>
  createHash('sha256').update(canonicalJson(message)).digest('hex');

/** The hashes an approval of sending `messageId` binds (§7.4 step 1, OUT-004). */
export type SendBinding = { beforeHash: string; contentHash: string };

const resultOf = (message: Message): SendResultDTO => ({
  messageId: message.id,
  status: message.status === 'sent' ? 'sent' : 'failed',
  provider: (message.provider as SendResultDTO['provider']) ?? null,
  ...{ providerMessageId: message.providerMessageId, sentAt: message.sentAt },
  failureReason: message.failureReason,
});

/** The address the workspace sends from: the member's own (Resend overrides it, melos-ajt.9). */
async function senderOf(tenant: TenantContext) {
  const [row] = await controlDb
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, tenant.userId));
  return row?.email ?? 'noreply@melos.invalid';
}

/** Records the send's outcome and, on success, its pitch effects, in one transaction (§6.4). */
async function settle(
  tx: WorkspaceTransaction,
  tenant: TenantContext,
  message: Message,
  outcome: {
    provider: string;
    providerMessageId?: string;
    providerThreadId?: string;
    at: string;
    failureReason?: string;
  },
) {
  const { at } = outcome;
  const sent = !outcome.failureReason;
  await guard.update(
    tx,
    messages,
    {
      status: sent ? 'sent' : 'failed',
      ...{ provider: outcome.provider, providerMessageId: outcome.providerMessageId ?? null },
      ...{
        providerThreadId: outcome.providerThreadId ?? null,
        failureReason: outcome.failureReason ?? null,
      },
      ...{ sentAt: sent ? at : null, updatedAt: at, updatedBy: tenant.userId },
    },
    eq(messages.id, message.id),
  );
  const pitchId = message.pitchId;
  if (!pitchId) return;
  const cells = await tx.select().from(pitchItems).where(eq(pitchItems.pitchId, pitchId));
  const event = (
    row: Pick<typeof pitchEvents.$inferInsert, 'eventType'> &
      Partial<typeof pitchEvents.$inferInsert>,
  ) => ({
    ...{ id: `pev_${ulid()}`, pitchId, actorType: 'system', occurredAt: at, ...row },
  });
  const metadataJson = JSON.stringify({ messageId: message.id });
  if (!sent) {
    const reason = JSON.stringify({ messageId: message.id, failureReason: outcome.failureReason });
    await guard.insert(tx, pitchEvents, [
      event({ eventType: 'message_failed', metadataJson: reason }),
    ]);
    return;
  }
  const events = cells.map((cell) =>
    event({ pitchItemId: cell.id, eventType: 'message_sent', metadataJson }),
  );
  // A successful send moves draft and not_contacted cells to sent (§6.4).
  const moving = cells.filter(
    (cell) => cell.currentStatus === 'draft' || cell.currentStatus === 'not_contacted',
  );
  for (const cell of moving)
    events.push(
      event({
        pitchItemId: cell.id,
        eventType: 'status_changed',
        fromStatus: cell.currentStatus,
        toStatus: 'sent',
      }),
    );
  if (moving.length)
    await guard.update(
      tx,
      pitchItems,
      { currentStatus: 'sent', updatedAt: at, updatedBy: tenant.userId },
      inArray(
        pitchItems.id,
        moving.map((cell) => cell.id),
      ),
    );
  await guard.insert(tx, pitchEvents, events);
  // P-39: the next follow-up is one workspace interval after the send.
  const [settings] = await tx.select().from(workspaceSettings).where(eq(workspaceSettings.id, 1));
  const nextFollowUpAt = new Date(
    Date.parse(at) + (settings?.followUpIntervalDays ?? 7) * DAY_MS,
  ).toISOString();
  await guard.update(
    tx,
    pitches,
    { lastContactedAt: at, nextFollowUpAt, updatedAt: at, updatedBy: tenant.userId },
    eq(pitches.id, pitchId),
  );
}

/**
 * sendMessage (§3.3, §7.5, OUT-002, OUT-004). The approval transaction re-checks `expected` and
 * queues the draft (a mismatch is STATE_CHANGED); only a queued message reaches the transport,
 * keyed by its id, and the outcome is stored with its pitch effects. A sent or failed message
 * returns its stored result. outreach:send; no `to` recipient is VALIDATION.
 */
export async function sendMessage(
  tenant: TenantContext,
  input: { messageId: string; expected?: SendBinding },
  origin: WriteOrigin = { type: 'user' },
  transport: EmailTransport = getEmailTransport(),
): Promise<ServiceResult<SendResultDTO>> {
  const from = await senderOf(tenant);
  type Queued = { stored: SendResultDTO; message?: never } | { stored: null; message: Message };
  const queued = await runWorkspaceWrite<Queued>(
    tenant,
    SEND,
    async (tx) => {
      const message = await loadMessage(tx, input.messageId);
      if (message?.direction !== 'outbound') return failure('NOT_FOUND');
      if (message.status === 'sent' || message.status === 'failed')
        return success({ stored: resultOf(message) });
      if (message.status !== 'draft')
        return failure({ code: 'VALIDATION', field: 'messageId', reason: 'in_flight' });
      const { expected } = input;
      if (
        expected &&
        (expected.beforeHash !== sendBeforeHashOf(message) ||
          expected.contentHash !== contentHashOf(message))
      )
        return failure('STATE_CHANGED');
      if (!message.recipients.some((recipient) => recipient.recipientType === 'to'))
        return failure({ code: 'VALIDATION', field: 'to', reason: 'required' });
      const at = new Date().toISOString();
      // A draft has no sender yet; the transport's address is snapshotted as it is queued.
      await guard.insert(tx, messageRecipients, [
        {
          messageId: message.id,
          recipientType: 'from',
          contactMethodId: null,
          addressSnapshot: from,
        },
      ]);
      await guard.update(
        tx,
        messages,
        { status: 'queued', updatedAt: at, updatedBy: tenant.userId },
        eq(messages.id, message.id),
      );
      return success({ stored: null, message });
    },
    origin,
  );
  if (!queued.ok) return queued;
  if (queued.value.stored) return success(queued.value.stored);
  const { message } = queued.value;
  const [to, cc, bcc] = ['to', 'cc', 'bcc'].map((type) =>
    message.recipients
      .filter((row) => row.recipientType === type)
      .map((row) => row.addressSnapshot),
  );
  const { id: messageId, subject, bodyText, bodyHtml, pitchId } = message;
  let outcome: Parameters<typeof settle>[3];
  try {
    const receipt = await transport.send({
      ...{ messageId, from, to, cc, bcc, subject: subject ?? '', bodyText: bodyText ?? '' },
      ...{ bodyHtml: bodyHtml ?? undefined, pitchId, workspaceId: tenant.workspaceId },
    });
    outcome = { provider: transport.provider, ...receipt, at: receipt.acceptedAt };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const failureReason = code === 'IDEMPOTENCY_CONFLICT' ? code : 'TRANSPORT_ERROR';
    outcome = { provider: transport.provider, at: new Date().toISOString(), failureReason };
  }
  const settled = await runWorkspaceWrite(tenant, SEND, async (tx) => {
    const current = await loadMessage(tx, message.id);
    if (current?.status !== 'queued') return success(current ? resultOf(current) : null);
    await settle(tx, tenant, current, outcome);
    const after = await loadMessage(tx, message.id);
    return success(after ? resultOf(after) : null);
  });
  if (!settled.ok) return settled;
  return settled.value ? success(settled.value) : failure('NOT_FOUND');
}
