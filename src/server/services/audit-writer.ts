import { ulid } from 'ulid';
import { auditLog } from '../db/schema/workspace.generated';
import { type GuardTransaction, workspaceIntegrityGuard } from './integrity-guard';

/**
 * The §6.6 vocabulary (`<entity>.<verb>`) plus the Phase 4 additions (melos-rpr D-4): party.create,
 * party.update, party.delete, agreement.create, agreement.update, asset.create, release.delete and
 * metadata_term.create.
 */
export type AuditAction =
  | `${'composition' | 'recording' | 'release'}.${'create' | 'update' | 'delete'}`
  | `${'party' | 'contact'}.${'create' | 'update' | 'delete'}`
  | `agreement.${'create' | 'update'}`
  | `asset.${'create' | 'attach'}`
  | 'metadata_term.create'
  | `${'recording_artists' | 'writer_shares' | 'publishing_shares' | 'master_shares'}.replace`
  | 'licensing_contacts.replace'
  | `representation.${'attest' | 'clear'}`
  | 'self_parties.update'
  | 'report.generate'
  | 'import.apply'
  | `approval.${'requested' | 'granted' | 'declined' | 'stale'}`
  | 'message.draft_updated';

/** Who a write runs for (§4.3): a user, or an agent run or import acting for one (AUD-002). */
export type Actor = {
  type: 'user' | 'agent' | 'import';
  userId: string;
  agentRunId?: string;
  approvalToolCallId?: string;
};

/** One mutation: its entity and full state, null before a create and after a delete. */
export type AuditEntry = {
  action: AuditAction;
  entityType: string;
  entityId: string;
  before: object | null;
  after: object | null;
};

/** Appends `audit_log` rows in the transaction of the mutation they record (AUD-001, §6.6). */
export type AuditWriter = { write(entry: AuditEntry): Promise<void> };

/**
 * Canonical JSON (§7.4): keys sorted by UTF-16 code unit at every depth, array order kept, no
 * whitespace. PROPOSED, as §7.4 does not say: values serialize as JSON.stringify serializes them
 * (`toJSON` applies; an undefined, function or symbol is left out of an object and null in an
 * array), so a value and its JSON round trip give the same text. Throws for a value with no JSON
 * text, such as undefined.
 */
export function canonicalJson(value: unknown): string {
  const text = canonical(value);
  if (text === undefined) throw new TypeError('canonicalJson needs a value with a JSON form');
  return text;
}

function canonical(value: unknown): string | undefined {
  const toJSON = (value as { toJSON?: unknown } | null | undefined)?.toJSON;
  const plain: unknown = typeof toJSON === 'function' ? toJSON.call(value) : value;
  if (plain === null || typeof plain !== 'object') return JSON.stringify(plain);
  if (Array.isArray(plain)) {
    return `[${Array.from(plain, (item) => canonical(item) ?? 'null').join(',')}]`;
  }
  const record = plain as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .flatMap((key) => {
      const member = canonical(record[key]);
      return member === undefined ? [] : [`${JSON.stringify(key)}:${member}`];
    });
  return `{${members.join(',')}}`;
}

/**
 * The AuditWriter of one workspace transaction: each entry is one `aud_<ulid>` row, inserted through
 * the workspace IntegrityGuard with the actor, the request id, the time, and before and after as
 * canonical JSON, so it commits or rolls back with the mutation it records. The row is an object
 * literal in the insert call, so a column name `audit_log` lacks does not compile.
 */
export function createAuditWriter(
  tx: GuardTransaction,
  actor: Actor,
  requestId: string,
): AuditWriter {
  const json = (state: object | null) => (state === null ? null : canonicalJson(state));
  return {
    async write({ action, entityType, entityId, before, after }) {
      await workspaceIntegrityGuard.insert(tx, auditLog, [
        {
          id: `aud_${ulid()}`,
          actorType: actor.type,
          actorUserId: actor.userId,
          agentRunId: actor.agentRunId ?? null,
          approvalToolCallId: actor.approvalToolCallId ?? null,
          action,
          entityType,
          entityId,
          beforeJson: json(before),
          afterJson: json(after),
          requestId,
          occurredAt: new Date().toISOString(),
        },
      ]);
    },
  };
}
