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
  | 'composition_registrations.replace'
  | 'recording_registrations.replace'
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
 * Canonical JSON (§7.4), the text phase 7 hashes: object keys sorted by UTF-16 code unit at every
 * depth, array order kept, no whitespace. Value serialization is PROPOSED default P-43 (§7.4): a
 * `toJSON` method is applied first (a Date becomes its ISO string); strings, finite numbers, booleans
 * and null are written as JSON.stringify writes them; an undefined, function or symbol is left out
 * of an object and written as null in an array; any other object is written from its own enumerable
 * string keys, each time it appears. Throws a TypeError for NaN, Infinity or -Infinity, a bigint, a
 * boxed primitive (never unwrapped), a cycle, and a value with no JSON text such as undefined.
 */
export function canonicalJson(value: unknown): string {
  const text = canonical(value, new Set());
  if (text === undefined) throw new TypeError('canonicalJson needs a value with a JSON form');
  return text;
}

const BOXED = [Number, String, Boolean, BigInt, Symbol];

/** A value's canonical text, or undefined where an object leaves the value out. */
function canonical(value: unknown, path: Set<object>): string | undefined {
  const toJSON = (value as { toJSON?: unknown } | null | undefined)?.toJSON;
  const plain: unknown = typeof toJSON === 'function' ? toJSON.call(value) : value;
  if (typeof plain === 'number' && !Number.isFinite(plain)) {
    throw new TypeError(`canonicalJson cannot represent ${plain}`);
  }
  if (plain === null || typeof plain !== 'object') return JSON.stringify(plain);
  if (BOXED.some((type) => plain instanceof type)) {
    throw new TypeError('canonicalJson refuses a boxed primitive');
  }
  if (path.has(plain)) throw new TypeError('canonicalJson cannot serialize a cycle');
  path.add(plain);
  const record = plain as Record<string, unknown>;
  const members = Array.isArray(plain)
    ? Array.from(plain, (item) => canonical(item, path) ?? 'null')
    : Object.keys(record)
        .sort()
        .flatMap((key) => {
          const member = canonical(record[key], path);
          return member === undefined ? [] : [`${JSON.stringify(key)}:${member}`];
        });
  path.delete(plain);
  return Array.isArray(plain) ? `[${members.join(',')}]` : `{${members.join(',')}}`;
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
