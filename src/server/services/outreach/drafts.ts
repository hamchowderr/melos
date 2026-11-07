import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type {
  DraftMessageInput,
  MessageDraftDTO,
  MessagePurpose,
  RecipientType,
} from '../../../lib/dto/outreach';
import {
  compositions,
  contactMethods,
  contacts,
  messageRecipients,
  messages,
  parties,
  pitches,
  pitchItems,
  recordingLinks,
  recordings,
} from '../../db/schema/workspace.generated';
import { canonicalJson } from '../audit-writer';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction, type WriteOrigin } from '../workspace-write';

export const DRAFT: WorkspacePermissions = { outreach: ['draft'] };
const SUBJECT_MAX = 300;
const BODY_MAX = 50_000;
const _TYPES: RecipientType[] = ['to', 'cc', 'bcc'];

export const refuse = (field: string, reason: string) =>
  failure({ code: 'VALIDATION', field, reason });
type Reader = Pick<WorkspaceDatabase, 'select'> | Pick<WorkspaceTransaction, 'select'>;

/**
 * `contentHash` (§7.4): SHA-256 of the canonical JSON of the subject, body text, body HTML and the
 * recipients sorted by type, then address. sendMessage's approval binds it (OUT-004).
 */
export function contentHashOf(message: {
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  recipients: { recipientType: string; addressSnapshot: string }[];
}): string {
  const recipients = message.recipients
    .map(({ recipientType, addressSnapshot }) => ({
      type: recipientType,
      address: addressSnapshot,
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.address.localeCompare(b.address));
  const { subject, bodyText, bodyHtml } = message;
  return createHash('sha256')
    .update(canonicalJson({ subject, bodyText, bodyHtml, recipients }))
    .digest('hex');
}

/** A message row with its recipients, or undefined. */
export async function loadMessage(db: Reader, messageId: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!row) return undefined;
  const recipients = await db
    .select()
    .from(messageRecipients)
    .where(eq(messageRecipients.messageId, messageId))
    .orderBy(asc(messageRecipients.recipientType), asc(messageRecipients.addressSnapshot));
  return { ...row, recipients };
}

/** The draft as MessageDraftDTO, with the facts it was drafted from. */
async function draftDTO(db: Reader, messageId: string): Promise<MessageDraftDTO | null> {
  const message = await loadMessage(db, messageId);
  if (message?.status !== 'draft' || !message.pitchId) return null;
  const [contact] = await db
    .select({ name: parties.displayName })
    .from(pitches)
    .innerJoin(contacts, eq(contacts.id, pitches.contactId))
    .innerJoin(parties, eq(parties.id, contacts.partyId))
    .where(eq(pitches.id, message.pitchId));
  const cells = await db
    .select({
      compositionId: pitchItems.compositionId,
      recordingId: pitchItems.recordingId,
      compositionTitle: compositions.title,
      recordingTitle: recordings.title,
      link: recordingLinks.url,
    })
    .from(pitchItems)
    .leftJoin(compositions, eq(compositions.id, pitchItems.compositionId))
    .leftJoin(recordings, eq(recordings.id, pitchItems.recordingId))
    .leftJoin(
      recordingLinks,
      and(eq(recordingLinks.recordingId, pitchItems.recordingId), eq(recordingLinks.isPrimary, 1)),
    )
    .where(and(eq(pitchItems.pitchId, message.pitchId)))
    .orderBy(asc(pitchItems.sortOrder), asc(pitchItems.id));
  const of = (type: RecipientType) =>
    message.recipients
      .filter((recipient) => recipient.recipientType === type)
      .map(({ contactMethodId, addressSnapshot }) => ({
        contactMethodId,
        address: addressSnapshot,
      }));
  return {
    ...{ messageId, pitchId: message.pitchId, purpose: message.purpose as MessagePurpose },
    ...{ status: 'draft', subject: message.subject ?? '', bodyText: message.bodyText ?? '' },
    ...{ to: of('to'), cc: of('cc'), bcc: of('bcc'), updatedAt: message.updatedAt },
    contentHash: contentHashOf(message),
    sourceFacts: {
      contactName: contact?.name ?? '',
      items: cells.map((cell) => ({
        itemType: cell.recordingId ? 'recording' : 'composition',
        itemId: cell.recordingId ?? cell.compositionId ?? '',
        title: (cell.recordingId ? cell.recordingTitle : cell.compositionTitle) ?? '',
        primaryLink: cell.link,
      })),
      generatedReportId: message.generatedReportId,
      replyToMessageId: message.inReplyToMessageId,
    },
  };
}

/** A draft for outreach:draft; another message status or an unknown id is NOT_FOUND. */
export async function getMessageDraft(
  tenant: TenantContext,
  messageId: string,
): Promise<ServiceResult<MessageDraftDTO>> {
  if (!requirePermission(tenant, DRAFT).ok) return failure('FORBIDDEN');
  const draft = await sanitized(tenant.workspaceId, async () =>
    draftDTO(await getWorkspaceDatabase(tenant.workspaceId), messageId),
  );
  return draft ? success(draft) : failure('NOT_FOUND');
}

/** VALIDATION for a subject or body that is blank or too long. */
export function invalidText(field: 'subject' | 'bodyText', value: string | undefined) {
  if (value === undefined) return null;
  if (!value.trim()) return refuse(field, 'required');
  return value.length > (field === 'subject' ? SUBJECT_MAX : BODY_MAX)
    ? refuse(field, 'too_long')
    : null;
}

/**
 * draftPitchMessage (§3.3, OUT-001): an outbound draft on a pitch, to the contact's primary email
 * when it has one. A reply-to message must be on the same pitch. Audits message.draft_created.
 */
export async function draftPitchMessage(
  tenant: TenantContext,
  input: DraftMessageInput,
  origin: WriteOrigin = { type: 'user' },
): Promise<ServiceResult<MessageDraftDTO>> {
  if (input.purpose !== 'initial' && input.purpose !== 'follow_up')
    return refuse('purpose', 'unknown');
  const refused = invalidText('subject', input.subject) ?? invalidText('bodyText', input.bodyText);
  if (refused) return refused;
  const written = await runWorkspaceWrite(
    tenant,
    DRAFT,
    async (tx, audit) => {
      const [pitch] = await tx
        .select({ partyId: contacts.partyId })
        .from(pitches)
        .innerJoin(contacts, eq(contacts.id, pitches.contactId))
        .where(eq(pitches.id, input.pitchId));
      if (!pitch) return failure('NOT_FOUND');
      const replyTo = input.replyToMessageId ?? null;
      if (replyTo) {
        const own = and(eq(messages.id, replyTo), eq(messages.pitchId, input.pitchId));
        if (!(await tx.select({ id: messages.id }).from(messages).where(own)).length)
          return failure('NOT_FOUND');
      }
      const [email] = await tx
        .select()
        .from(contactMethods)
        .where(
          and(
            eq(contactMethods.partyId, pitch.partyId),
            eq(contactMethods.methodType, 'email'),
            eq(contactMethods.isPrimary, 1),
          ),
        );
      const [id, at, by] = [`msg_${ulid()}`, new Date().toISOString(), tenant.userId];
      await guard.insert(tx, messages, [
        {
          ...{ id, pitchId: input.pitchId, generatedReportId: input.generatedReportId ?? null },
          ...{ inReplyToMessageId: replyTo, direction: 'outbound', purpose: input.purpose },
          ...{ status: 'draft', subject: input.subject.trim(), bodyText: input.bodyText },
          ...{ createdAt: at, updatedAt: at, createdBy: by, updatedBy: by },
        },
      ]);
      if (email)
        await guard.insert(tx, messageRecipients, [
          {
            messageId: id,
            recipientType: 'to',
            contactMethodId: email.id,
            addressSnapshot: email.value,
          },
        ]);
      await audit.write({
        ...{ action: 'message.draft_created', entityType: 'message', entityId: id },
        ...{ before: null, after: (await loadMessage(tx, id)) ?? null },
      });
      return success(id);
    },
    origin,
  );
  return written.ok ? getMessageDraft(tenant, written.value) : written;
}
