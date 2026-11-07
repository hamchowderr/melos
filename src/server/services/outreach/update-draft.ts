import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { MessageDraftDTO, RecipientType, UpdateDraftInput } from '../../../lib/dto/outreach';
import {
  contactMethods,
  messageRecipients,
  messages,
  parties,
} from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction, type WriteOrigin } from '../workspace-write';
import { contentHashOf, DRAFT, getMessageDraft, invalidText, loadMessage, refuse } from './drafts';

const TYPES: RecipientType[] = ['to', 'cc', 'bcc'];

/** The email methods with these ids, in the given order; null when any is not a live email. */
async function emailMethods(tx: WorkspaceTransaction, ids: string[]) {
  if (!ids.length) return [];
  if (new Set(ids).size !== ids.length) return null;
  const rows = await tx
    .select({ id: contactMethods.id, value: contactMethods.value })
    .from(contactMethods)
    .innerJoin(parties, eq(parties.id, contactMethods.partyId))
    .where(
      and(
        inArray(contactMethods.id, ids),
        eq(contactMethods.methodType, 'email'),
        isNull(parties.deletedAt),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const found = ids.flatMap((id) => byId.get(id) ?? []);
  return found.length === ids.length ? found : null;
}

/**
 * updateMessageDraft (§3.3, OUT-004): saves subject, body or whole recipient lists (contact method
 * ids of email methods) on a draft. A message that is not a draft is VALIDATION `not_draft`; an edit
 * that changes nothing writes nothing. Audits message.draft_updated before and after.
 */
export async function updateMessageDraft(
  tenant: TenantContext,
  input: UpdateDraftInput,
  origin: WriteOrigin = { type: 'user' },
): Promise<ServiceResult<MessageDraftDTO>> {
  const refused = invalidText('subject', input.subject) ?? invalidText('bodyText', input.bodyText);
  if (refused) return refused;
  const written = await runWorkspaceWrite(
    tenant,
    DRAFT,
    async (tx, audit) => {
      const before = await loadMessage(tx, input.messageId);
      if (!before) return failure('NOT_FOUND');
      if (before.status !== 'draft') return refuse('messageId', 'not_draft');
      const lists: { type: RecipientType; rows: { id: string; value: string }[] }[] = [];
      for (const type of TYPES) {
        const ids = input[type];
        if (ids === undefined) continue;
        const rows = await emailMethods(tx, ids);
        if (!rows) return refuse(type, 'email_method_required');
        lists.push({ type, rows });
      }
      const subject = input.subject?.trim() ?? before.subject;
      const bodyText = input.bodyText ?? before.bodyText;
      const recipients = before.recipients
        .filter((recipient) => !lists.some((list) => list.type === recipient.recipientType))
        .concat(
          lists.flatMap(({ type, rows }) =>
            rows.map((row) => ({
              ...{ messageId: before.id, recipientType: type },
              ...{ contactMethodId: row.id, addressSnapshot: row.value },
            })),
          ),
        );
      const next = { ...before, subject, bodyText, recipients };
      if (contentHashOf(next) === contentHashOf(before)) return success(before.id);
      const stamp = { updatedAt: new Date().toISOString(), updatedBy: tenant.userId };
      await guard.update(tx, messages, { subject, bodyText, ...stamp }, eq(messages.id, before.id));
      for (const { type, rows } of lists) {
        const scope = and(
          eq(messageRecipients.messageId, before.id),
          eq(messageRecipients.recipientType, type),
        );
        await guard.delete(
          tx,
          messageRecipients,
          scope ?? eq(messageRecipients.messageId, before.id),
        );
        if (rows.length)
          await guard.insert(
            tx,
            messageRecipients,
            recipients.filter((recipient) => recipient.recipientType === type),
          );
      }
      await audit.write({
        ...{ action: 'message.draft_updated', entityType: 'message', entityId: before.id },
        ...{ before, after: (await loadMessage(tx, before.id)) ?? null },
      });
      return success(before.id);
    },
    origin,
  );
  return written.ok ? getMessageDraft(tenant, written.value) : written;
}
