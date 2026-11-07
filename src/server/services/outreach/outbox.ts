import { and, desc, eq, inArray } from 'drizzle-orm';
import type { OutboxMessageDTO } from '../../../lib/dto/outreach';
import {
  contactMethods,
  contacts,
  messages,
  parties,
  pitches,
} from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { DRAFT } from './drafts';

/** Every outbound pitch message, newest first, for the /outreach list (OUT-001). outreach:draft. */
export async function listOutboxMessages(
  tenant: TenantContext,
): Promise<ServiceResult<OutboxMessageDTO[]>> {
  if (!requirePermission(tenant, DRAFT).ok) return failure('FORBIDDEN');
  return sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const rows = await database
      .select({
        ...{ messageId: messages.id, pitchId: pitches.id, partyId: contacts.partyId },
        ...{ contactName: parties.displayName, purpose: messages.purpose, status: messages.status },
        ...{ subject: messages.subject, sentAt: messages.sentAt, updatedAt: messages.updatedAt },
      })
      .from(messages)
      .innerJoin(pitches, eq(pitches.id, messages.pitchId))
      .innerJoin(contacts, eq(contacts.id, pitches.contactId))
      .innerJoin(parties, eq(parties.id, contacts.partyId))
      .where(eq(messages.direction, 'outbound'))
      .orderBy(desc(messages.updatedAt), desc(messages.id));
    const partyIds = [...new Set(rows.map((row) => row.partyId))];
    const methods = partyIds.length
      ? await database
          .select()
          .from(contactMethods)
          .where(
            and(inArray(contactMethods.partyId, partyIds), eq(contactMethods.methodType, 'email')),
          )
      : [];
    return success(
      rows.map(({ partyId, sentAt, updatedAt, ...row }) => ({
        ...row,
        purpose: row.purpose as OutboxMessageDTO['purpose'],
        status: row.status as OutboxMessageDTO['status'],
        emails: methods
          .filter((method) => method.partyId === partyId)
          .map((method) => ({ contactMethodId: method.id, address: method.value })),
        at: sentAt ?? updatedAt,
      })),
    );
  });
}
