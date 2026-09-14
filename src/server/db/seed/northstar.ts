import { readFileSync } from 'node:fs';
import { isAPIError } from 'better-auth/api';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulid';
import { auth } from '../../auth/auth';
import { controlIntegrityGuard, workspaceIntegrityGuard } from '../../services/integrity-guard';
import { closeWorkspaceDatabase, getWorkspaceDatabase } from '../../services/workspace-connections';
import { provisionWorkspace } from '../../services/workspace-provisioner';
import { controlDb } from '../client';
import { account, member, organization, user } from '../schema/auth';
import { controlAuditLog, workspaceMemberSettings } from '../schema/control';
import { reportTemplates, WORKSPACE_TABLES } from '../schema/workspace.generated';

type Row = Record<string, unknown>;
type Fixture = {
  demo: { date: string; timezone: string; user: string; organization: string; workspace: string };
  keys: Record<string, string>;
  provisionerOwned: { tables: string[] };
  control: Record<string, Row[]>;
  workspace: Record<string, Row[]>;
};

/** The Northstar Demo Catalog (melos-73v), anchored on its demo date. */
const NORTHSTAR: Fixture = JSON.parse(
  readFileSync(new URL('../../../../docs/fixtures/northstar-demo.json', import.meta.url), 'utf8'),
);

const DAY_MS = 86_400_000;
const CONTROL_TABLES: Record<string, SQLiteTable> = {
  user,
  organization,
  member,
  workspace_member_settings: workspaceMemberSettings,
};
const owned = (scope: string, table: string) =>
  NORTHSTAR.provisionerOwned.tables.includes(`${scope}.${table}`);

/** CatalogService maintains catalog_search from phase 4; until then, validate.mjs's derivation. */
const CATALOG_SEARCH = [
  `INSERT INTO catalog_search (entity_type, entity_id, title, alt_titles, artist_names, contributor_names, terms, lyrics)
    SELECT 'composition', c.id, c.title,
      COALESCE((SELECT group_concat(a.title, ' ') FROM composition_alt_titles a WHERE a.composition_id = c.id), ''),
      COALESCE((SELECT group_concat(DISTINCT p.display_name) FROM recordings r JOIN recording_artists ra ON ra.recording_id = r.id
                JOIN parties p ON p.id = ra.party_id WHERE r.composition_id = c.id AND r.deleted_at IS NULL), ''),
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM composition_contributors cc JOIN parties p ON p.id = cc.party_id WHERE cc.composition_id = c.id), ''),
      COALESCE((SELECT group_concat(t.label, ' ') FROM composition_terms ct JOIN metadata_terms t ON t.id = ct.term_id WHERE ct.composition_id = c.id), ''),
      COALESCE(c.lyrics, '')
    FROM compositions c WHERE c.deleted_at IS NULL`,
  `INSERT INTO catalog_search (entity_type, entity_id, title, alt_titles, artist_names, contributor_names, terms, lyrics)
    SELECT 'recording', r.id, trim(r.title || ' ' || COALESCE(r.version_title, '')), '',
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM recording_artists ra JOIN parties p ON p.id = ra.party_id WHERE ra.recording_id = r.id), ''),
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM recording_contributors rc JOIN parties p ON p.id = rc.party_id WHERE rc.recording_id = r.id), ''),
      COALESCE((SELECT group_concat(t.label, ' ') FROM recording_terms rt JOIN metadata_terms t ON t.id = rt.term_id WHERE rt.recording_id = r.id), ''),
      ''
    FROM recordings r WHERE r.deleted_at IS NULL`,
];

/** The calendar date, YYYY-MM-DD, that `at` falls on in `timeZone`. */
export function dateIn(timeZone: string, at = new Date()): string {
  const digits = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  const format = new Intl.DateTimeFormat('en-US', { timeZone, ...digits });
  const parts = Object.fromEntries(
    format.formatToParts(at).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** `value` `days` later when it is an ISO timestamp, a calendar date or a Better Auth epoch value. */
function shift(column: string, value: unknown, days: number): unknown {
  if (typeof value === 'number' && column.endsWith('_at')) return value + days * DAY_MS;
  const time = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/;
  if (typeof value !== 'string' || !time.test(value)) return value;
  const moved = new Date(Date.parse(value) + days * DAY_MS).toISOString();
  return value.length === 10 ? moved.slice(0, 10) : moved;
}

/** A fixture row, keyed by SQL name, as drizzle values: shifted, with provisioner ids mapped. */
function valuesOf(table: SQLiteTable, row: Row, days: number, ids: Map<string, string>): Row {
  const values: Row = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    const value = shift(column.name, row[column.name], days);
    const mapped = typeof value === 'string' ? (ids.get(value) ?? value) : value;
    // Better Auth's timestamp_ms and boolean columns take a Date and a boolean.
    values[key] = mapped == null ? mapped : column.mapFromDriverValue(mapped);
  }
  return values;
}

export type NorthstarSeed =
  | { status: 'exists'; organizationId: string }
  | { status: 'refused'; organizationId: string; refusal: string }
  | { status: 'seeded'; organizationId: string; workspaceId: string; dateShift: number };

/** Awaits a Better Auth call; a refusal comes back as `<step> <status> <code>`, never its message. */
const refusalOf = (step: string, call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (error: unknown) => {
      if (!isAPIError(error)) throw error;
      return `${step} ${error.statusCode} ${error.body?.code}`;
    },
  );

/**
 * Deletes what an earlier seed left, complete or partial, through Better Auth, whose hooks delete the
 * workspace database, its registry row and the control rows (ADR-030, §7.2): the organization while
 * it exists, then the user. Deleting an organization takes an owner's session, which the seeded
 * credential opens, since it commits with the organization. Returns the first refusal, after which
 * nothing more is deleted.
 */
async function deleteNorthstar(organizationId: string, userId: string, password: string) {
  const byId = eq(organization.id, organizationId);
  if ((await controlDb.select().from(organization).where(byId)).length > 0) {
    const body = { email: String(NORTHSTAR.control.user[0].email), password };
    const signIn = auth.api.signInEmail({ body, returnHeaders: true });
    const notSignedIn = await refusalOf('sign_in', signIn);
    if (notSignedIn) return notSignedIn;
    const cookies = (await signIn).headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
    const headers = new Headers({ cookie: cookies.join('; ') });
    const deleted = auth.api.deleteOrganization({ headers, body: { organizationId } });
    const kept = await refusalOf('delete_organization', deleted).finally(() =>
      auth.api.signOut({ headers }),
    );
    if (kept) return kept;
  }
  const { internalAdapter } = await auth.$context;
  if (await internalAdapter.findUserById(userId)) {
    return refusalOf('delete_user', internalAdapter.deleteUser(userId));
  }
}

/**
 * Seeds the fixture for `seedDate` (default: today in the demo timezone), with every timestamp,
 * calendar date and epoch value moved by dateShift, the whole days from the demo date (§8 phase 3).
 * Control rows commit in one transaction, the workspace is provisioned (§7.2), then its rows and
 * catalog_search commit in one workspace transaction, all through IntegrityGuard. When the
 * organization id exists, returns `exists` and writes nothing. With `replace`, an earlier seed is
 * deleted first, a partial one too; a refused delete returns `refused` and seeds nothing.
 */
export async function seedNorthstar(options: {
  password: string;
  seedDate?: string;
  replace?: boolean;
}): Promise<NorthstarSeed> {
  const { demo, keys, control, workspace } = NORTHSTAR;
  const seedDate = options.seedDate ?? dateIn(demo.timezone);
  const days = (Date.parse(seedDate) - Date.parse(demo.date)) / DAY_MS;
  if (!Number.isInteger(days)) throw new Error('The seed date must be YYYY-MM-DD');
  const [organizationId, userId] = [keys[demo.organization], keys[demo.user]];
  if (options.replace) {
    const refusal = await deleteNorthstar(organizationId, userId, options.password);
    if (refusal) return { status: 'refused', organizationId, refusal };
  }
  const ids = new Map<string, string>();
  const at = (row: Row) => new Date(shift('created_at', row.created_at, days) as number);
  const hash = await (await auth.$context).password.hash(options.password);

  const created = await controlDb.transaction(async (tx) => {
    const found = await tx.select().from(organization).where(eq(organization.id, organizationId));
    if (found.length > 0) return false;
    for (const [name, rows] of Object.entries(control)) {
      if (owned('control', name)) continue;
      const table = CONTROL_TABLES[name];
      await controlIntegrityGuard.insert(
        tx,
        table,
        rows.map((row) => valuesOf(table, row, days, ids)),
      );
    }
    // The fixture has no account: a credential Better Auth's sign-in accepts (§1.4 lets a seed set ids).
    const [jordan] = control.user;
    const credential = { id: ulid(), accountId: userId, providerId: 'credential', userId };
    const times = { createdAt: at(jordan), updatedAt: at(jordan) };
    await controlIntegrityGuard.insert(tx, account, [{ ...credential, password: hash, ...times }]);
    // Organization creation appends member.added for its creator (§4.1).
    const [owner] = control.member;
    const audit = {
      id: `cad_${ulid()}`,
      // An operator command has no session, so no acting user (§4.1).
      actorUserId: null,
      organizationId,
      action: 'member.added',
    };
    const target = { targetType: 'member', targetId: String(owner.id), beforeJson: null };
    const after = {
      afterJson: JSON.stringify({ role: owner.role }),
      occurredAt: at(owner).toISOString(),
    };
    await controlIntegrityGuard.insert(tx, controlAuditLog, [{ ...audit, ...target, ...after }]);
    return true;
  });
  if (!created) return { status: 'exists', organizationId };

  // Inserted rows fire no Better Auth hook, so the seed provisions as organization creation does.
  const registry = await provisionWorkspace(organizationId, null);
  if (registry.status !== 'active') {
    const error = new Error(`Workspace ${registry.id} is ${registry.status}`);
    throw Object.assign(error, { code: 'WorkspaceNotActive' });
  }
  ids.set(keys[demo.workspace], registry.id);
  const database = await getWorkspaceDatabase(registry.id);
  try {
    await database.transaction(async (tx) => {
      const presets = await tx.select().from(reportTemplates);
      for (const template of workspace.report_templates) {
        const preset = presets.find(({ presetKey }) => presetKey === template.preset_key);
        if (!preset)
          throw new Error(`Workspace ${registry.id} has no ${template.preset_key} preset`);
        ids.set(String(template.id), preset.id);
      }
      // The fixture lists parents first; IntegrityGuard refuses a row whose parent is not written.
      for (const [name, rows] of Object.entries(workspace)) {
        if (owned('workspace', name)) continue;
        const table: SQLiteTable = WORKSPACE_TABLES[name as keyof typeof WORKSPACE_TABLES];
        const values = rows.map((row) => valuesOf(table, row, days, ids));
        await workspaceIntegrityGuard.insert(tx, table, values);
      }
      for (const statement of CATALOG_SEARCH) await tx.run(sql.raw(statement));
    });
  } finally {
    await closeWorkspaceDatabase(registry.id);
  }
  return { status: 'seeded', organizationId, workspaceId: registry.id, dateShift: days };
}
