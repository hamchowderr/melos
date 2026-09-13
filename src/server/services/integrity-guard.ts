import type { ResultSet } from '@libsql/client';
import { getTableColumns, getTableName, is, SQL, sql } from 'drizzle-orm';
import type {
  SQLiteColumn,
  SQLiteInsertValue,
  SQLiteTable,
  SQLiteTransaction,
  SQLiteUpdateSetSource,
} from 'drizzle-orm/sqlite-core';
import type { ForeignKeyRule } from '../db/fk-rules';
import { FOREIGN_KEY_RULES } from '../db/fk-rules.generated';

/**
 * The caller's drizzle libSQL transaction, never the database: on a remote connection every call
 * outside a transaction is its own Hrana stream, so checks and writes must share one (§1.4).
 */
export type GuardTransaction = Pick<
  SQLiteTransaction<'async', ResultSet, Record<string, never>, Record<string, never>>,
  'all' | 'run' | 'insert' | 'update' | 'rollback'
>;

/**
 * A write IntegrityGuard refused. `counts` holds, for `NOT_FOUND`, the rows per parent table whose
 * key has no live parent and, for `REFERENCED`, the rows per child table still referencing them.
 */
export class IntegrityError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'REFERENCED',
    readonly table: string,
    readonly counts: Readonly<Record<string, number>>,
  ) {
    super(`${code}: ${table} ${JSON.stringify(counts)}`);
    this.name = 'IntegrityError';
  }
}

/** Applies one database's declared foreign-key rules inside service transactions (DAT-001). */
export interface IntegrityGuard {
  /** Inserts rows once every key without a NULL column has a live parent row (§4.4 rule 1). */
  insert<T extends SQLiteTable>(
    tx: GuardTransaction,
    table: T,
    rows: SQLiteInsertValue<T>[],
  ): Promise<void>;
  /** Updates rows unless a new key has no live parent or a referenced parent key changes (rule 1). */
  update<T extends SQLiteTable>(
    tx: GuardTransaction,
    table: T,
    set: SQLiteUpdateSetSource<T>,
    where: SQL,
  ): Promise<void>;
  /** Deletes rows after applying the ON DELETE action of every rule referencing them (rule 2). */
  delete(tx: GuardTransaction, table: SQLiteTable, where: SQL): Promise<void>;
}

type Counts = Record<string, number>;

// Identifiers come only from the rules and drizzle tables and are quoted; values are always bound.
const id = (name: string) => sql.identifier(name);
const list = (names: readonly string[]) => sql.join(names.map(id), sql`, `);
const joined = (parts: SQL[], separator: string) => sql.join(parts, sql.raw(separator));

async function count(tx: GuardTransaction, query: SQL): Promise<number> {
  return (await tx.all<{ n: number }>(sql`SELECT count(*) AS n ${query}`))[0].n;
}

function tally(counts: Counts, table: string, n: number) {
  if (n > 0) counts[table] = (counts[table] ?? 0) + n;
}

/** Finds a drizzle column by SQL name, failing closed when the schema and the rules disagree. */
function columnsOf(table: SQLiteTable) {
  const byName = new Map<string, { key: string; column: SQLiteColumn }>();
  for (const [key, column] of Object.entries(getTableColumns(table)))
    byName.set(column.name, { key, column });
  return (name: string) => {
    const found = byName.get(name);
    if (!found) throw new Error(`${getTableName(table)} has no column ${name}`);
    return found;
  };
}

const bind = (value: unknown, column: SQLiteColumn): SQL =>
  is(value, SQL) ? value : sql`${sql.param(value, column)}`;

/** True when `key` matches a parent row that is not soft-deleted (`deleted_at` set; rule 1). */
async function parentExists(tx: GuardTransaction, rule: ForeignKeyRule, key: SQL[]): Promise<SQL> {
  const where = rule.parentColumns.map((column, i) => sql`parent.${id(column)} = ${key[i]}`);
  const softDelete = sql`FROM pragma_table_info(${rule.parentTable}) WHERE name = 'deleted_at'`;
  if (await count(tx, softDelete)) where.push(sql`parent.deleted_at IS NULL`);
  return sql`EXISTS (SELECT 1 FROM ${id(rule.parentTable)} AS parent WHERE ${joined(where, ' AND ')})`;
}

/** Runs a multi-statement delete so a refusal part-way undoes it, even if the caller carries on. */
async function savepoint(tx: GuardTransaction, work: () => Promise<void>) {
  await tx.run(sql`SAVEPOINT integrity_guard`);
  try {
    await work();
  } catch (error) {
    await tx.run(sql`ROLLBACK TO integrity_guard`);
    throw error;
  } finally {
    await tx.run(sql`RELEASE integrity_guard`);
  }
}

/**
 * §4.4 rules 1 and 2 read from generated rules. Checks run before each write in the caller's
 * transaction and never depend on PRAGMA foreign_keys, so refusals match with or without it.
 */
export function createIntegrityGuard(rules: readonly ForeignKeyRule[]): IntegrityGuard {
  async function remove(tx: GuardTransaction, table: string, rowids: unknown[], seen: Set<string>) {
    // A row already being deleted, through a cycle or a second path, is handled once.
    const fresh = rowids.filter((rowid) => !seen.has(`${table} ${rowid}`));
    if (fresh.length === 0) return;
    for (const rowid of fresh) seen.add(`${table} ${rowid}`);
    const bound = fresh.map((rowid) => sql`${rowid}`);
    const rows = sql`${id(table)} WHERE rowid IN (${sql.join(bound, sql`, `)})`;
    // Like SQLite, IN matches no parent when any child key column is NULL.
    const references = (rule: ForeignKeyRule) =>
      sql`(${list(rule.columns)}) IN (SELECT ${list(rule.parentColumns)} FROM ${rows})`;
    const children = rules.filter((rule) => rule.parentTable === table);

    // RESTRICT, NO ACTION and SET DEFAULT (not in §4.4: fail closed) refuse before any change.
    const referenced: Counts = {};
    for (const rule of children) {
      if (rule.onDelete === 'CASCADE' || rule.onDelete === 'SET NULL') continue;
      const n = await count(tx, sql`FROM ${id(rule.table)} WHERE ${references(rule)}`);
      tally(referenced, rule.table, n);
    }
    if (Object.keys(referenced).length) throw new IntegrityError('REFERENCED', table, referenced);

    for (const rule of children) {
      const where = references(rule);
      if (rule.onDelete === 'CASCADE') {
        const query = sql`SELECT rowid AS row_id FROM ${id(rule.table)} WHERE ${where}`;
        const cascaded = (await tx.all<{ row_id: unknown }>(query)).map((row) => row.row_id);
        await remove(tx, rule.table, cascaded, seen);
      } else if (rule.onDelete === 'SET NULL') {
        const cleared = rule.columns.map((column) => sql`${id(column)} = NULL`);
        await tx.run(sql`UPDATE ${id(rule.table)} SET ${joined(cleared, ', ')} WHERE ${where}`);
      }
    }
    await tx.run(sql`DELETE FROM ${rows}`);
  }

  return {
    async insert(tx, table, rows) {
      const name = getTableName(table);
      const column = columnsOf(table);
      const missing: Counts = {};
      for (const rule of rules.filter((candidate) => candidate.table === name)) {
        for (const row of rows as Record<string, unknown>[]) {
          const values = rule.columns.map((key) => row[column(key).key]);
          if (values.some((value) => value === null || value === undefined)) continue;
          const key = values.map((value, i) => bind(value, column(rule.columns[i]).column));
          const found = await count(tx, sql`WHERE ${await parentExists(tx, rule, key)}`);
          tally(missing, rule.parentTable, 1 - found);
        }
      }
      if (Object.keys(missing).length) throw new IntegrityError('NOT_FOUND', name, missing);
      await tx.insert(table).values(rows);
    },

    async update(tx, table, set, where) {
      const name = getTableName(table);
      const column = columnsOf(table);
      const assigned = (columnName: string) => {
        const { key, column: target } = column(columnName);
        const value = (set as Record<string, unknown>)[key];
        return value === undefined ? undefined : bind(value, target);
      };

      // Every declared ON UPDATE action is NO ACTION, so a referenced parent key never changes.
      const referenced: Counts = {};
      for (const rule of rules.filter((candidate) => candidate.parentTable === name)) {
        const changed = rule.parentColumns.flatMap((parentColumn) => {
          const value = assigned(parentColumn);
          return value ? [sql`${id(parentColumn)} IS NOT ${value}`] : [];
        });
        if (changed.length === 0) continue;
        const old = sql`SELECT ${list(rule.parentColumns)} FROM ${id(name)} WHERE (${where}) AND (${joined(changed, ' OR ')})`;
        const children = sql`FROM ${id(rule.table)} WHERE (${list(rule.columns)}) IN (${old})`;
        tally(referenced, rule.table, await count(tx, children));
      }
      if (Object.keys(referenced).length) throw new IntegrityError('REFERENCED', name, referenced);

      // A partly assigned composite key is checked with the row's current values for the rest.
      const missing: Counts = {};
      for (const rule of rules.filter((candidate) => candidate.table === name)) {
        if (!rule.columns.some((child) => assigned(child))) continue;
        const key = rule.columns.map((child) => assigned(child) ?? sql`${id(name)}.${id(child)}`);
        const present = key.map((part) => sql`${part} IS NOT NULL`);
        const exists = await parentExists(tx, rule, key);
        const orphans = sql`FROM ${id(name)} WHERE (${where}) AND ${joined(present, ' AND ')} AND NOT ${exists}`;
        tally(missing, rule.parentTable, await count(tx, orphans));
      }
      if (Object.keys(missing).length) throw new IntegrityError('NOT_FOUND', name, missing);
      await tx.update(table).set(set).where(where);
    },

    async delete(tx, table, where) {
      const name = getTableName(table);
      const query = sql`SELECT rowid AS row_id FROM ${id(name)} WHERE ${where}`;
      const rowids = (await tx.all<{ row_id: unknown }>(query)).map((row) => row.row_id);
      await savepoint(tx, () => remove(tx, name, rowids, new Set()));
    },
  };
}

/** IntegrityGuard for melos-control writes (DAT-001). */
export const controlIntegrityGuard = createIntegrityGuard(FOREIGN_KEY_RULES.control);
