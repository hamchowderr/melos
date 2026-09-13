import type { ResultSet } from '@libsql/client';
import { getTableColumns, getTableName, is, isNull, SQL, sql } from 'drizzle-orm';
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
 * key has no live parent; for `REFERENCED`, the rows per child table still referencing them; and,
 * for `SONG_LEVEL_CONFLICT`, the written rows that would hold a song at both levels in a pitch.
 */
export class IntegrityError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'REFERENCED' | 'SONG_LEVEL_CONFLICT',
    readonly table: string,
    readonly counts: Readonly<Record<string, number>>,
  ) {
    super(`${code}: ${table} ${JSON.stringify(counts)}`);
    this.name = 'IntegrityError';
  }
}

/** Applies one database's declared foreign-key rules inside service transactions (DAT-001). */
export interface IntegrityGuard {
  /**
   * Inserts rows once every key without a NULL column has a live parent row (§4.4 rule 1) and no
   * pitch would hold a song at both levels (rule 3).
   */
  insert<T extends SQLiteTable>(
    tx: GuardTransaction,
    table: T,
    rows: SQLiteInsertValue<T>[],
  ): Promise<void>;
  /**
   * Updates rows unless a new key has no live parent, a referenced parent key changes (rule 1) or a
   * recording moves to a composition that a pitch holding the recording also holds (rule 3).
   */
  update<T extends SQLiteTable>(
    tx: GuardTransaction,
    table: T,
    set: SQLiteUpdateSetSource<T>,
    where: SQL,
  ): Promise<void>;
  /** Deletes rows after applying the ON DELETE action of every rule referencing them (rule 2). */
  delete(tx: GuardTransaction, table: SQLiteTable, where: SQL): Promise<void>;
  /**
   * Sets `deleted_at`, `updated_at` and `updated_by` (`actor`, the user the write runs for; §4.2)
   * on the live rows `where` matches unless a live row references them through a RESTRICT or NO
   * ACTION rule (rule 2). Throws for a table without `deleted_at`.
   */
  softDelete(tx: GuardTransaction, table: SQLiteTable, where: SQL, actor: string): Promise<void>;
}

type Counts = Record<string, number>;

// Identifiers come only from the rules and drizzle tables and are quoted; values are always bound.
const id = (name: string) => sql.identifier(name);
const list = (names: readonly string[]) => sql.join(names.map(id), sql`, `);
const joined = (parts: SQL[], separator: string) => sql.join(parts, sql.raw(separator));

// Like SQLite, IN matches no parent when any child key column is NULL.
const references = (rule: ForeignKeyRule, rows: SQL) =>
  sql`(${list(rule.columns)}) IN (SELECT ${list(rule.parentColumns)} FROM ${rows})`;

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

/**
 * The values drizzle stores: a column a write leaves undefined takes its default, default function
 * or update function on insert, and its update function on update. Resolved once and then written,
 * so checks see the stored key and a defaulted key column is never taken for NULL (rule 1).
 */
function stored<V extends object>(table: SQLiteTable, values: V, insert: boolean): V {
  const row = { ...values } as Record<string, unknown>;
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (row[key] !== undefined) continue;
    if (insert && column.default != null) row[key] = column.default;
    else if (insert && column.defaultFn) row[key] = column.defaultFn();
    else if (column.onUpdateFn) row[key] = column.onUpdateFn();
  }
  return row as V;
}

/** True when `key` matches a parent row that is not soft-deleted (`deleted_at` set; rule 1). */
async function parentExists(tx: GuardTransaction, rule: ForeignKeyRule, key: SQL[]): Promise<SQL> {
  const where = rule.parentColumns.map((column, i) => sql`parent.${id(column)} = ${key[i]}`);
  const softDelete = sql`FROM pragma_table_info(${rule.parentTable}) WHERE name = 'deleted_at'`;
  if (await count(tx, softDelete)) where.push(sql`parent.deleted_at IS NULL`);
  return sql`EXISTS (SELECT 1 FROM ${id(rule.parentTable)} AS parent WHERE ${joined(where, ' AND ')})`;
}

/**
 * Rule 3 on insert, checked as the §4.3 pitch_items_one_level_* triggers check it: counts the new
 * cells that an earlier cell of the same pitch, stored or in this insert, holds at the other level.
 */
async function pitchCellConflicts(
  tx: GuardTransaction,
  table: SQLiteTable,
  rows: Record<string, unknown>[],
): Promise<number> {
  const column = columnsOf(table);
  const cells = rows.map((row, ord) => {
    const values = ['pitch_id', 'composition_id', 'recording_id'].map((name) =>
      bind(row[column(name).key] ?? null, column(name).column),
    );
    return sql`(${ord}, ${sql.join(values, sql`, `)})`;
  });
  const incoming = sql`incoming (ord, pitch_id, composition_id, recording_id) AS (VALUES ${sql.join(cells, sql`, `)})`;
  const cell = sql`cell AS (SELECT -1 AS ord, pitch_id, composition_id, recording_id FROM pitch_items UNION ALL SELECT * FROM incoming)`;
  const held = sql`SELECT 1 FROM cell LEFT JOIN recordings AS cell_song ON cell_song.id = cell.recording_id WHERE cell.ord < item.ord AND cell.pitch_id = item.pitch_id AND (cell.composition_id = item_song.composition_id OR cell_song.composition_id = item.composition_id)`;
  const query = sql`WITH ${incoming}, ${cell} SELECT count(*) AS n FROM incoming AS item LEFT JOIN recordings AS item_song ON item_song.id = item.recording_id WHERE EXISTS (${held})`;
  return (await tx.all<{ n: number }>(query))[0].n;
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
 * §4.4 rules 1 and 2 read from generated rules, and rule 3 for the workspace pitch_items and
 * recordings tables. Checks run before each write in the caller's transaction and never depend on
 * PRAGMA foreign_keys, so refusals match with or without it.
 */
export function createIntegrityGuard(rules: readonly ForeignKeyRule[]): IntegrityGuard {
  /** Rows of RESTRICT, NO ACTION and SET DEFAULT (not in §4.4: fail closed) children of `rows`. */
  async function referencing(tx: GuardTransaction, table: string, rows: SQL, live = false) {
    const referenced: Counts = {};
    for (const rule of rules.filter((candidate) => candidate.parentTable === table)) {
      if (rule.onDelete === 'CASCADE' || rule.onDelete === 'SET NULL') continue;
      // A soft delete (`live`) counts only the live rows of a child table with `deleted_at`.
      const where = [references(rule, rows)];
      const hasDeletedAt = sql`FROM pragma_table_info(${rule.table}) WHERE name = 'deleted_at'`;
      if (live && (await count(tx, hasDeletedAt))) where.push(sql`child.deleted_at IS NULL`);
      const children = sql`FROM ${id(rule.table)} AS child WHERE ${joined(where, ' AND ')}`;
      tally(referenced, rule.table, await count(tx, children));
    }
    return referenced;
  }

  async function remove(tx: GuardTransaction, table: string, rowids: unknown[], seen: Set<string>) {
    // A row already being deleted, through a cycle or a second path, is handled once.
    const fresh = rowids.filter((rowid) => !seen.has(`${table} ${rowid}`));
    if (fresh.length === 0) return;
    for (const rowid of fresh) seen.add(`${table} ${rowid}`);
    const bound = fresh.map((rowid) => sql`${rowid}`);
    const rows = sql`${id(table)} WHERE rowid IN (${sql.join(bound, sql`, `)})`;

    // Refuse before any change.
    const referenced = await referencing(tx, table, rows);
    if (Object.keys(referenced).length) throw new IntegrityError('REFERENCED', table, referenced);

    for (const rule of rules.filter((candidate) => candidate.parentTable === table)) {
      const where = references(rule, rows);
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
      // drizzle's values() throws this for no rows; throw it before any check reads the database.
      if (rows.length === 0) throw new Error('values() must be called with at least one value');
      const name = getTableName(table);
      const column = columnsOf(table);
      const written = rows.map((row) => stored(table, row, true));
      const missing: Counts = {};
      for (const rule of rules.filter((candidate) => candidate.table === name)) {
        for (const row of written as Record<string, unknown>[]) {
          const values = rule.columns.map((key) => row[column(key).key]);
          if (values.some((value) => value === null || value === undefined)) continue;
          const key = values.map((value, i) => bind(value, column(rule.columns[i]).column));
          const found = await count(tx, sql`WHERE ${await parentExists(tx, rule, key)}`);
          tally(missing, rule.parentTable, 1 - found);
        }
      }
      if (Object.keys(missing).length) throw new IntegrityError('NOT_FOUND', name, missing);
      if (name === 'pitch_items') {
        const conflicts = await pitchCellConflicts(tx, table, written as Record<string, unknown>[]);
        if (conflicts) throw new IntegrityError('SONG_LEVEL_CONFLICT', name, { [name]: conflicts });
      }
      await tx.insert(table).values(written);
    },

    async update(tx, table, set, where) {
      const name = getTableName(table);
      const column = columnsOf(table);
      const written = stored(table, set, false);
      const assigned = (columnName: string) => {
        const { key, column: target } = column(columnName);
        const value = (written as Record<string, unknown>)[key];
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

      // Rule 3: the §4.3 recordings_composition_change_pitch_level trigger, which any assignment fires.
      const composition = name === 'recordings' ? assigned('composition_id') : undefined;
      if (composition) {
        const held = sql`SELECT 1 FROM pitch_items AS pr JOIN pitch_items AS pc ON pc.pitch_id = pr.pitch_id WHERE pr.recording_id = recordings.id AND pc.composition_id = ${composition}`;
        const moved = await count(tx, sql`FROM recordings WHERE (${where}) AND EXISTS (${held})`);
        if (moved) throw new IntegrityError('SONG_LEVEL_CONFLICT', name, { [name]: moved });
      }
      await tx.update(table).set(written).where(where);
    },

    async delete(tx, table, where) {
      const name = getTableName(table);
      const query = sql`SELECT rowid AS row_id FROM ${id(name)} WHERE ${where}`;
      const rowids = (await tx.all<{ row_id: unknown }>(query)).map((row) => row.row_id);
      await savepoint(tx, () => remove(tx, name, rowids, new Set()));
    },

    async softDelete(tx, table, where, actor) {
      const name = getTableName(table);
      const column = columnsOf(table);
      const deletedAt = column('deleted_at');
      const updatedAt = column('updated_at');
      const live = sql`(${where}) AND ${isNull(deletedAt.column)}`;
      const referenced = await referencing(tx, name, sql`${id(name)} WHERE ${live}`, true);
      if (Object.keys(referenced).length) throw new IntegrityError('REFERENCED', name, referenced);
      const now = new Date().toISOString();
      const stamps: Record<string, string> = { [deletedAt.key]: now, [updatedAt.key]: now };
      const updatedBy = Object.values(getTableColumns(table)).some((c) => c.name === 'updated_by');
      if (updatedBy) stamps[column('updated_by').key] = actor;
      await tx.update(table).set(stamps).where(live);
    },
  };
}

/** IntegrityGuard for melos-control writes (DAT-001). */
export const controlIntegrityGuard = createIntegrityGuard(FOREIGN_KEY_RULES.control);

/** IntegrityGuard for workspace writes through the generated workspace tables (DAT-001). */
export const workspaceIntegrityGuard = createIntegrityGuard(FOREIGN_KEY_RULES.workspace);
