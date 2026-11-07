import { asc, eq, inArray, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import type { MessageThreadDTO, ThreadMessageDTO } from '../../../lib/dto/outreach';
import {
  messageRecipients,
  messages,
  pitchEvents,
  pitches,
  pitchItems,
} from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite } from '../workspace-write';
import { loadMessage } from './drafts';
import { type EmailTransport, getEmailTransport } from './email-transport';

const nextUlid = monotonicFactory();

/**
 * getMessageThread (§3.3, OUT-003): every message on the pitch of `messageId`, or on `pitchId`, in
 * time order, with bodies and addresses. pitch:read; an unknown id is NOT_FOUND.
 */
export async function getMessageThread(
  tenant: TenantContext,
  input: { messageId?: string; pitchId?: string },
): Promise<ServiceResult<MessageThreadDTO>> {
  if (!requirePermission(tenant, { pitch: ['read'] }).ok) return failure('FORBIDDEN');
  if (!input.messageId === !input.pitchId)
    return failure({
      code: 'VALIDATION',
      field: 'messageId',
      reason: 'exactly_one_of_message_or_pitch',
    });
  const thread = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    let pitchId = input.pitchId ?? null;
    if (input.messageId) {
      const [row] = await database
        .select({ pitchId: messages.pitchId })
        .from(messages)
        .where(eq(messages.id, input.messageId));
      pitchId = row?.pitchId ?? null;
    }
    if (!pitchId) return null;
    const rows = await database
      .select()
      .from(messages)
      .where(eq(messages.pitchId, pitchId))
      .orderBy(
        asc(sql`coalesce(${messages.sentAt}, ${messages.receivedAt}, ${messages.createdAt})`),
        asc(messages.id),
      );
    if (!rows.length && input.pitchId) {
      const known = await database
        .select({ id: pitches.id })
        .from(pitches)
        .where(eq(pitches.id, pitchId));
      if (!known.length) return null;
    }
    const recipients = rows.length
      ? await database
          .select()
          .from(messageRecipients)
          .where(
            inArray(
              messageRecipients.messageId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(asc(messageRecipients.addressSnapshot))
      : [];
    return { pitchId, rows, recipients };
  });
  if (!thread) return failure('NOT_FOUND');
  const addresses = (messageId: string, type: string) =>
    thread.recipients
      .filter((row) => row.messageId === messageId && row.recipientType === type)
      .map((row) => row.addressSnapshot);
  return success({
    pitchId: thread.pitchId,
    messages: thread.rows.map(
      (row): ThreadMessageDTO => ({
        ...{ messageId: row.id, subject: row.subject, bodyText: row.bodyText },
        direction: row.direction as ThreadMessageDTO['direction'],
        purpose: row.purpose as ThreadMessageDTO['purpose'],
        status: row.status as ThreadMessageDTO['status'],
        ...{
          from: addresses(row.id, 'from')[0] ?? null,
          to: addresses(row.id, 'to'),
          cc: addresses(row.id, 'cc'),
        },
        ...{
          inReplyToMessageId: row.inReplyToMessageId,
          sentAt: row.sentAt,
          receivedAt: row.receivedAt,
        },
        ...{ failureReason: row.failureReason, createdAt: row.createdAt },
      }),
    ),
  });
}

/**
 * OutreachService.simulateInboundReply (§7.5, OUT-003), only while the sandbox transport is
 * active: a reply to a sent outbound message appends an inbound message and a reply_received
 * event, and moves the pitch's sent and awaiting_reply cells to responded. The outbound row is
 * never changed. pitch:update; any other transport is VALIDATION `sandbox_only`.
 */
export async function simulateInboundReply(
  tenant: TenantContext,
  input: { messageId: string; bodyText: string },
  transport: EmailTransport = getEmailTransport(),
): Promise<ServiceResult<MessageThreadDTO>> {
  if (transport.provider !== 'sandbox')
    return failure({ code: 'VALIDATION', field: 'messageId', reason: 'sandbox_only' });
  if (!input.bodyText.trim())
    return failure({ code: 'VALIDATION', field: 'bodyText', reason: 'required' });
  const written = await runWorkspaceWrite(tenant, { pitch: ['update'] }, async (tx) => {
    const outbound = await loadMessage(tx, input.messageId);
    if (!outbound?.pitchId || outbound.direction !== 'outbound' || outbound.status !== 'sent')
      return failure('NOT_FOUND');
    const pitchId = outbound.pitchId;
    const [id, at] = [`msg_${nextUlid()}`, new Date().toISOString()];
    const subject = outbound.subject?.startsWith('Re: ')
      ? outbound.subject
      : `Re: ${outbound.subject ?? ''}`;
    await guard.insert(tx, messages, [
      {
        ...{ id, pitchId, inReplyToMessageId: outbound.id, direction: 'inbound', purpose: 'reply' },
        ...{ status: 'received', subject, bodyText: input.bodyText, provider: 'sandbox' },
        ...{
          providerThreadId: outbound.providerThreadId,
          receivedAt: at,
          createdAt: at,
          updatedAt: at,
        },
      },
    ]);
    const sender = outbound.recipients.find((row) => row.recipientType === 'to');
    const self = outbound.recipients.find((row) => row.recipientType === 'from');
    const recipients = [
      ...(sender ? [{ ...sender, messageId: id, recipientType: 'from' }] : []),
      ...(self ? [{ ...self, messageId: id, recipientType: 'to' }] : []),
    ];
    if (recipients.length) await guard.insert(tx, messageRecipients, recipients);
    const cells = await tx.select().from(pitchItems).where(eq(pitchItems.pitchId, pitchId));
    const moving = cells.filter(
      (cell) => cell.currentStatus === 'sent' || cell.currentStatus === 'awaiting_reply',
    );
    const event = (
      row: Pick<typeof pitchEvents.$inferInsert, 'eventType'> &
        Partial<typeof pitchEvents.$inferInsert>,
    ) => ({
      ...{ id: `pev_${nextUlid()}`, pitchId, actorType: 'system', occurredAt: at, ...row },
    });
    await guard.insert(tx, pitchEvents, [
      event({
        eventType: 'reply_received',
        metadataJson: JSON.stringify({ messageId: id, inReplyTo: outbound.id }),
      }),
      ...moving.map((cell) =>
        event({
          pitchItemId: cell.id,
          eventType: 'status_changed',
          fromStatus: cell.currentStatus,
          toStatus: 'responded',
        }),
      ),
    ]);
    if (moving.length)
      await guard.update(
        tx,
        pitchItems,
        { currentStatus: 'responded', updatedAt: at, updatedBy: tenant.userId },
        inArray(
          pitchItems.id,
          moving.map((cell) => cell.id),
        ),
      );
    return success(id);
  });
  return written.ok ? getMessageThread(tenant, { messageId: written.value }) : written;
}
