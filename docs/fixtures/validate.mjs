#!/usr/bin/env node
// Validates the Northstar demo fixture (beads melos-73v).
//
// 1. Extracts the workspace and control-plane DDL from docs/CONTRACT.md and applies it to fresh in-memory libSQL databases.
// 2. Loads docs/fixtures/northstar-demo.json.
// 3. Asserts, with SQL, every table in docs/fixtures/EXPECTED.md marked <!-- check:... -->, the fixture
//    invariants, the source fixture (docs/source/GIZMO_Demo_Fixture.json) and the CONTRACT §6.5 readiness table.
//
// Run from anywhere: node docs/fixtures/validate.mjs. Exits 1 on any mismatch.
// validateSeeded runs the same checks against a seeded Northstar workspace (npm run db:validate-demo).
// @libsql/client resolves from LIBSQL_CLIENT_BASE (a package.json path), the repository root, or the Gate A worktree.

import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const readText = (rel) => readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const contractMd = readText('docs/CONTRACT.md');
const expectedMd = readText('docs/fixtures/EXPECTED.md');
export const fixture = JSON.parse(readText('docs/fixtures/northstar-demo.json'));
const source = JSON.parse(readText('docs/source/GIZMO_Demo_Fixture.json'));

// ---------- assertions ----------

let assertions = 0;
const failures = [];
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function check(group, label, actual, expected) {
  assertions++;
  if (show(actual) !== show(expected))
    failures.push({ group, label, expected: show(expected), actual: show(actual) });
}

// ---------- keys ----------

const keyOf = new Map(Object.entries(fixture.keys).map(([key, id]) => [id, key]));
function idOf(key) {
  const id = fixture.keys[key];
  if (!id) throw new Error(`EXPECTED.md uses unknown key ${key}`);
  return id;
}
const K = (id) => (id == null ? 'none' : (keyOf.get(id) ?? id));
const KEY_TOKEN = /\b(?:[a-z]+_[A-Z][A-Z0-9_]*|[a-z_]+:[A-Z][A-Z0-9_]*)\b/g;

// ---------- markdown ----------

function sections(md, headingRe) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i])) continue;
    const level = lines[i].match(/^#+/)[0].length;
    let j = i + 1;
    while (j < lines.length && !(/^#+ /.test(lines[j]) && lines[j].match(/^#+/)[0].length <= level))
      j++;
    out.push(lines.slice(i + 1, j).join('\n'));
  }
  if (out.length === 0) throw new Error(`CONTRACT.md has no heading matching ${headingRe}`);
  return out;
}
const sqlBlocks = (text) => [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
const clean = (cell) => cell.replace(/`/g, '').trim();
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
function tableAt(lines, headerIndex) {
  const header = splitRow(lines[headerIndex]);
  const rows = [];
  for (let i = headerIndex + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const cells = splitRow(lines[i]);
    rows.push(Object.fromEntries(header.map((h, n) => [h, cells[n] ?? ''])));
  }
  return rows;
}
function tableByHeader(text, headerStart) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(headerStart));
  if (i < 0) throw new Error(`no table starting with "${headerStart}"`);
  return tableAt(lines, i);
}
function checkTables(md) {
  const lines = md.split('\n');
  const tables = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^<!-- check:([\w-]+) -->$/);
    if (!m) return;
    let h = i + 1;
    while (!lines[h].trim().startsWith('|')) h++;
    tables.set(m[1], tableAt(lines, h));
  });
  return tables;
}

// ---------- time ----------

function tzOffsetMinutes(instantMs, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]));
  return Math.round(
    (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instantMs) / 60000,
  );
}
function localMidnightUtc(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  let instant = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++)
    instant = Date.UTC(y, m - 1, d) - tzOffsetMinutes(instant, timeZone) * 60000;
  return instant;
}
const nextDay = (date) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const addDaysIso = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString();
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------- contract rules ----------

const ROLE_RANK_SQL = (
  contactExpr,
) => `(SELECT MIN(CASE cr.role WHEN 'licensing_agent' THEN 1 WHEN 'music_supervisor' THEN 2
  WHEN 'music_library' THEN 3 WHEN 'ad_agency' THEN 4 WHEN 'record_label' THEN 5 ELSE 6 END)
  FROM contact_roles cr WHERE cr.contact_id = ${contactExpr})`;
const DUE_STATUSES = ['sent', 'awaiting_reply', 'responded', 'interested', 'requested_more'];

// §6.5, in the order of its code tables.
const READINESS_CTE = `
WITH rec AS (SELECT id AS rid, composition_id AS cid, isrc FROM recordings WHERE deleted_at IS NULL),
sp AS (SELECT party_id FROM workspace_self_parties WHERE side = 'publishing'),
sm AS (SELECT party_id FROM workspace_self_parties WHERE side = 'master'),
pub AS (SELECT t.composition_id AS cid, t.territory, t.publishing_total_bp AS total,
          (SELECT COALESCE(SUM(pi.share_bp), 0) FROM publishing_interests pi
           WHERE pi.composition_id = t.composition_id AND pi.territory = t.territory
             AND (pi.publisher_party_id IN (SELECT party_id FROM sp) OR pi.representation_attested_at IS NOT NULL)) AS controlled
        FROM composition_publishing_totals t),
mst AS (SELECT t.recording_id AS rid, t.master_total_bp AS total,
          (SELECT COALESCE(SUM(mi.share_bp), 0) FROM master_interests mi
           WHERE mi.recording_id = t.recording_id
             AND (mi.owner_party_id IN (SELECT party_id FROM sm) OR mi.representation_attested_at IS NOT NULL)) AS controlled
        FROM recording_master_totals t),
flags AS (SELECT rec.rid,
            EXISTS (SELECT 1 FROM pub WHERE pub.cid = rec.cid AND pub.controlled < 10000) AS pub_not_controlled,
            (SELECT controlled FROM mst WHERE mst.rid = rec.rid) < 10000 AS master_not_controlled,
            EXISTS (SELECT 1 FROM licensing_contacts lc WHERE lc.recording_id = rec.rid OR lc.composition_id = rec.cid) AS explicit_contact
          FROM rec)`;
const READINESS_CODES = [
  ['blocking', 'NO_COMPOSITION', 'SELECT rid FROM rec WHERE cid IS NULL'],
  [
    'blocking',
    'WRITER_TOTAL_INCOMPLETE',
    'SELECT rec.rid FROM rec JOIN composition_writer_totals w ON w.composition_id = rec.cid WHERE w.writer_total_bp < 10000',
  ],
  [
    'blocking',
    'WRITER_TOTAL_OVER',
    'SELECT rec.rid FROM rec JOIN composition_writer_totals w ON w.composition_id = rec.cid WHERE w.writer_total_bp > 10000',
  ],
  [
    'blocking',
    'PUBLISHING_TOTAL_INCOMPLETE',
    'SELECT rid FROM rec WHERE cid IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM pub WHERE pub.cid = rec.cid) OR EXISTS (SELECT 1 FROM pub WHERE pub.cid = rec.cid AND pub.total < 10000))',
  ],
  [
    'blocking',
    'PUBLISHING_TOTAL_OVER',
    'SELECT rid FROM rec WHERE EXISTS (SELECT 1 FROM pub WHERE pub.cid = rec.cid AND pub.total > 10000)',
  ],
  [
    'blocking',
    'PUBLISHING_TERRITORY_MIXED',
    "SELECT rid FROM rec WHERE EXISTS (SELECT 1 FROM pub WHERE pub.cid = rec.cid AND pub.territory = 'WORLD') AND EXISTS (SELECT 1 FROM pub WHERE pub.cid = rec.cid AND pub.territory <> 'WORLD')",
  ],
  ['blocking', 'MASTER_TOTAL_INCOMPLETE', 'SELECT rid FROM mst WHERE total < 10000'],
  ['blocking', 'MASTER_TOTAL_OVER', 'SELECT rid FROM mst WHERE total > 10000'],
  [
    'blocking',
    'SELF_PARTY_NOT_CONFIGURED',
    'SELECT rid FROM rec WHERE NOT EXISTS (SELECT 1 FROM sp) OR NOT EXISTS (SELECT 1 FROM sm)',
  ],
  ['blocking', 'PUBLISHING_NOT_CONTROLLED', 'SELECT rid FROM flags WHERE pub_not_controlled'],
  ['blocking', 'MASTER_NOT_CONTROLLED', 'SELECT rid FROM flags WHERE master_not_controlled'],
  [
    'blocking',
    'NO_LICENSING_CONTACT',
    'SELECT rid FROM flags WHERE NOT explicit_contact AND (pub_not_controlled OR master_not_controlled)',
  ],
  ['sync', 'MISSING_ISRC', 'SELECT rid FROM rec WHERE isrc IS NULL'],
  [
    'sync',
    'NO_LISTEN_LINK',
    'SELECT rid FROM rec WHERE NOT EXISTS (SELECT 1 FROM recording_links l WHERE l.recording_id = rec.rid AND l.is_primary = 1)',
  ],
  [
    'warning',
    'MISSING_ISWC',
    'SELECT rec.rid FROM rec JOIN compositions c ON c.id = rec.cid WHERE c.iswc IS NULL',
  ],
];

// §3.5
const normalizeTitle = (s) => s.toLowerCase().trim().replace(/\s+/g, ' ');
function matchExpression(query) {
  const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 12);
  return tokens
    .map((t, i) => `"${t.replace(/"/g, '""')}"${i === tokens.length - 1 ? '*' : ''}`)
    .join(' ');
}

// ---------- database ----------

function loadLibsql() {
  const bases = [
    process.env.LIBSQL_CLIENT_BASE,
    path.join(REPO, 'package.json'),
    path.join(REPO, '.worktrees/gate-a/spikes/gate-a/package.json'),
  ];
  for (const base of bases.filter(Boolean)) {
    try {
      return createRequire(base)('@libsql/client');
    } catch {}
  }
  throw new Error(
    '@libsql/client not found; set LIBSQL_CLIENT_BASE to a package.json whose node_modules contains it',
  );
}

// In memory, because a closed libSQL file stays locked on Windows until its statements are garbage
// collected, so its temp directory could not be removed. One connection serves the whole database:
// nothing may use the client while one of its transactions is open.
async function freshDb(ddl) {
  const db = loadLibsql().createClient({ url: ':memory:' });
  await db.execute('PRAGMA foreign_keys = ON');
  await db.executeMultiple(ddl);
  return db;
}

async function load(db, tables) {
  const stmts = [];
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const cols = Object.keys(row);
      stmts.push({
        sql: `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        args: cols.map((c) => row[c]),
      });
    }
  }
  await db.batch(stmts, 'write');
}

// Rebuilds catalog_search from catalog rows, as CatalogService maintains it (§4.3).
async function buildSearchIndex(db) {
  await db.execute(`INSERT INTO catalog_search (entity_type, entity_id, title, alt_titles, artist_names, contributor_names, terms, lyrics)
    SELECT 'composition', c.id, c.title,
      COALESCE((SELECT group_concat(a.title, ' ') FROM composition_alt_titles a WHERE a.composition_id = c.id), ''),
      COALESCE((SELECT group_concat(DISTINCT p.display_name) FROM recordings r JOIN recording_artists ra ON ra.recording_id = r.id
                JOIN parties p ON p.id = ra.party_id WHERE r.composition_id = c.id AND r.deleted_at IS NULL), ''),
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM composition_contributors cc JOIN parties p ON p.id = cc.party_id WHERE cc.composition_id = c.id), ''),
      COALESCE((SELECT group_concat(t.label, ' ') FROM composition_terms ct JOIN metadata_terms t ON t.id = ct.term_id WHERE ct.composition_id = c.id), ''),
      COALESCE(c.lyrics, '')
    FROM compositions c WHERE c.deleted_at IS NULL`);
  await db.execute(`INSERT INTO catalog_search (entity_type, entity_id, title, alt_titles, artist_names, contributor_names, terms, lyrics)
    SELECT 'recording', r.id, trim(r.title || ' ' || COALESCE(r.version_title, '')), '',
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM recording_artists ra JOIN parties p ON p.id = ra.party_id WHERE ra.recording_id = r.id), ''),
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM recording_contributors rc JOIN parties p ON p.id = rc.party_id WHERE rc.recording_id = r.id), ''),
      COALESCE((SELECT group_concat(t.label, ' ') FROM recording_terms rt JOIN metadata_terms t ON t.id = rt.term_id WHERE rt.recording_id = r.id), ''),
      ''
    FROM recordings r WHERE r.deleted_at IS NULL`);
}

// ---------- queries ----------

const q = async (db, sql, args = []) => (await db.execute({ sql, args })).rows;

async function compositionByTitle(db, title) {
  const rows = await q(db, 'SELECT id FROM compositions WHERE title = ? AND deleted_at IS NULL', [
    title,
  ]);
  if (rows.length !== 1)
    throw new Error(`expected one composition titled ${title}, found ${rows.length}`);
  return rows[0].id;
}

async function primaryRecordingId(db, compositionId) {
  const [comp] = await q(db, 'SELECT title FROM compositions WHERE id = ?', [compositionId]);
  const live = await q(
    db,
    'SELECT id, title, version_title FROM recordings WHERE composition_id = ? AND deleted_at IS NULL',
    [compositionId],
  );
  if (live.length === 1) return live[0].id;
  const matches = live.filter(
    (r) => r.version_title == null && normalizeTitle(r.title) === normalizeTitle(comp.title),
  );
  return matches.length === 1 ? matches[0].id : null;
}

async function searchMusic(db, query) {
  const norm = normalizeTitle(query);
  const exactTitle = (
    await q(db, 'SELECT id FROM compositions WHERE deleted_at IS NULL AND lower(trim(title)) = ?', [
      norm,
    ])
  ).map((r) => r.id);
  const exactAlt = (
    await q(
      db,
      `SELECT DISTINCT a.composition_id AS id FROM composition_alt_titles a JOIN compositions c ON c.id = a.composition_id
    WHERE c.deleted_at IS NULL AND lower(trim(a.title)) = ?`,
      [norm],
    )
  ).map((r) => r.id);
  const text = (
    await q(
      db,
      `SELECT DISTINCT CASE WHEN s.entity_type = 'recording' AND r.composition_id IS NOT NULL THEN r.composition_id ELSE s.entity_id END AS id
    FROM (SELECT entity_type, entity_id FROM catalog_search WHERE catalog_search MATCH ?) s
    LEFT JOIN recordings r ON s.entity_type = 'recording' AND r.id = s.entity_id`,
      [matchExpression(query)],
    )
  ).map((r) => r.id);
  const results = [];
  for (const id of new Set([...exactTitle, ...exactAlt, ...text])) {
    const matchType = exactTitle.includes(id)
      ? 'exact_title'
      : exactAlt.includes(id)
        ? 'exact_alt_title'
        : 'text';
    results.push({
      id,
      matchType,
      primary: id.startsWith('cmp_') ? await primaryRecordingId(db, id) : null,
    });
  }
  return results;
}

async function readiness(db) {
  const byRecording = new Map();
  for (const r of await q(db, 'SELECT id FROM recordings WHERE deleted_at IS NULL'))
    byRecording.set(r.id, { blocking: [], sync: [], warning: [] });
  for (const [kind, code, sql] of READINESS_CODES) {
    for (const row of await q(db, `${READINESS_CTE} ${sql}`))
      byRecording.get(row.rid)[kind].push(code);
  }
  const flags = await q(
    db,
    `${READINESS_CTE} SELECT flags.*, (SELECT party_id FROM sm) AS sm FROM flags`,
  );
  for (const f of flags) {
    const r = byRecording.get(f.rid);
    r.oneStopReady = r.blocking.length === 0;
    r.syncReady = r.oneStopReady && r.sync.length === 0;
    const explicit = await q(
      db,
      `SELECT DISTINCT lc.party_id FROM licensing_contacts lc JOIN recordings r ON r.id = ?
      WHERE lc.recording_id = r.id OR lc.composition_id = r.composition_id ORDER BY lc.party_id`,
      [f.rid],
    );
    r.licensingContact = explicit.length
      ? explicit.map((e) => K(e.party_id)).join(', ')
      : !f.pub_not_controlled && !f.master_not_controlled && f.sm
        ? `${K(f.sm)} (implicit)`
        : 'none';
  }
  return byRecording;
}

const CELLS_CTE = `
WITH cells AS (
  SELECT pi.id AS item_id, pi.pitch_id, p.contact_id, pi.recording_id AS item_recording_id, pi.composition_id AS item_composition_id,
         COALESCE(pi.composition_id, r.composition_id) AS composition_id, pi.current_status,
         (SELECT e.from_status FROM pitch_events e WHERE e.pitch_item_id = pi.id AND e.event_type = 'status_changed' AND e.to_status = 'archived'
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS archived_from
  FROM pitch_items pi JOIN pitches p ON p.id = pi.pitch_id LEFT JOIN recordings r ON r.id = pi.recording_id),
-- §3.7: a cell archived from draft or not_contacted counts as no cell, so its contact is neverPitched.
counted_cells AS (
  SELECT * FROM cells WHERE NOT (current_status = 'archived' AND COALESCE(archived_from, '') IN ('draft', 'not_contacted'))),
heard_cells AS (SELECT * FROM counted_cells WHERE current_status NOT IN ('draft', 'not_contacted'))`;

async function rollup(db, compositionId) {
  const rows = await q(
    db,
    `${CELLS_CTE}
    SELECT k.id AS contact_id, p.display_name,
      EXISTS (SELECT 1 FROM heard_cells h WHERE h.contact_id = k.id AND h.composition_id = ?1) AS heard,
      EXISTS (SELECT 1 FROM counted_cells c WHERE c.contact_id = k.id AND c.composition_id = ?1) AS has_cell,
      ${ROLE_RANK_SQL('k.id')} AS role_rank
    FROM contacts k JOIN parties p ON p.id = k.party_id
    WHERE k.deleted_at IS NULL AND k.active = 1
    ORDER BY role_rank, p.display_name`,
    [compositionId],
  );
  const planned = rows.filter((r) => !r.heard && r.has_cell);
  const never = rows.filter((r) => !r.heard && !r.has_cell);
  return { rows, planned, never };
}

// Recording-level rollup (§3.7): cells on R or on R's composition.
async function recordingHeard(db, recordingId, contactId) {
  const [row] = await q(
    db,
    `${CELLS_CTE}
    SELECT EXISTS (SELECT 1 FROM heard_cells h JOIN recordings r ON r.id = ?1
      WHERE h.contact_id = ?2 AND (h.item_recording_id = r.id OR h.item_composition_id = r.composition_id)) AS heard`,
    [recordingId, contactId],
  );
  return row.heard;
}

async function followUps(db, date, timeZone) {
  const end = new Date(localMidnightUtc(nextDay(date), timeZone) - 1).toISOString(); // end(D), §6.4
  const offset = tzOffsetMinutes(Date.parse(`${date}T12:00:00Z`), timeZone);
  const rows = await q(
    db,
    `
    SELECT pi.id AS item_id, p.id AS pitch_id, p.contact_id, COALESCE(pi.composition_id, r.composition_id) AS composition_id,
      CASE WHEN pi.composition_id IS NOT NULL THEN 'composition' ELSE 'recording' END AS level,
      pi.current_status, p.next_follow_up_at, p.last_contacted_at,
      CAST(julianday(?1) - julianday(date(p.next_follow_up_at, ?2)) AS INTEGER) AS days_overdue,
      CASE pi.current_status WHEN 'requested_more' THEN 1 WHEN 'interested' THEN 2 WHEN 'responded' THEN 3
        WHEN 'awaiting_reply' THEN 4 WHEN 'sent' THEN 5 ELSE 9 END AS status_rank,
      ${ROLE_RANK_SQL('p.contact_id')} AS role_rank,
      CASE WHEN pi.current_status NOT IN (${DUE_STATUSES.map((s) => `'${s}'`).join(', ')}) THEN 'status'
        WHEN p.next_follow_up_at IS NULL THEN 'no_follow_up'
        WHEN p.next_follow_up_at > ?3 THEN 'after_date'
        WHEN p.last_contacted_at IS NOT NULL AND p.next_follow_up_at <= p.last_contacted_at THEN 'contacted_since'
        ELSE NULL END AS not_due_reason
    FROM pitch_items pi JOIN pitches p ON p.id = pi.pitch_id LEFT JOIN recordings r ON r.id = pi.recording_id
    ORDER BY (not_due_reason IS NULL) DESC, days_overdue DESC, status_rank, role_rank, p.next_follow_up_at, pi.id`,
    [date, `${offset} minutes`, end],
  );
  return {
    end,
    offset,
    due: rows.filter((r) => r.not_due_reason == null),
    notDue: rows.filter((r) => r.not_due_reason != null),
  };
}

// §4.4 share replacement: upsert by natural key, delete rows missing from the new set.
async function replaceWriterShares(tx, compositionId, shares, at, userId) {
  const before = await q(
    tx,
    'SELECT id, party_id, writer_share_bp FROM composition_contributors WHERE composition_id = ?',
    [compositionId],
  );
  let changed = 0;
  for (const s of shares) {
    const old = before.find((b) => b.party_id === s.partyId);
    if (!old || old.writer_share_bp !== s.shareBp) changed++;
    await tx.execute({
      sql: `INSERT INTO composition_contributors (id, composition_id, party_id, party_kind, writer_share_bp, created_at, updated_at, created_by, updated_by)
            VALUES (?, ?, ?, 'person', ?, ?, ?, ?, ?)
            ON CONFLICT (composition_id, party_id) DO UPDATE SET writer_share_bp = excluded.writer_share_bp, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: [
        old?.id ?? `ctr_NEW_${s.partyId}`,
        compositionId,
        s.partyId,
        s.shareBp,
        at,
        at,
        userId,
        userId,
      ],
    });
  }
  for (const b of before.filter((b) => !shares.some((s) => s.partyId === b.party_id))) {
    changed++;
    await tx.execute({ sql: 'DELETE FROM composition_contributors WHERE id = ?', args: [b.id] });
  }
  return changed;
}

// ---------- checks ----------

async function checkIds(_ws, _ctl, workspaceDdl, controlDdl) {
  const conventions = sections(contractMd, /^### [\d.]+ Conventions\b/)[0];
  const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
  const prefixes = new Map();
  for (const m of `${workspaceDdl}\n${controlDdl}`.matchAll(
    /CREATE TABLE [`"]?(\w+)[`"]? \(\s*\n\s*[`"]?id[`"]?\s+TEXT PRIMARY KEY[^\n]*/gi,
  )) {
    prefixes.set(m[1], m[0].match(/--\s*([a-z]+)_<ulid>/)?.[1] ?? null);
  }
  prefixes.set('user', 'usr'); // §1.4: the demo fixture uses usr_<ulid> for Better Auth users.
  const betterAuthTables = new Set([
    'user',
    'session',
    'account',
    'verification',
    'organization',
    'member',
  ]);
  const seen = new Set();
  for (const [scope, tables] of [
    ['workspace', fixture.workspace],
    ['control', fixture.control],
  ]) {
    for (const [table, rows] of Object.entries(tables)) {
      if (!rows[0] || !prefixes.has(table)) continue;
      const prefix = prefixes.get(table);
      // §1.4: entity tables carry a prefix, child relationship rows are bare, Better Auth ids are the seed's choice.
      const listed =
        prefix === 'usr'
          ? '`usr_<ulid>`'
          : prefix
            ? `\`${prefix}_\``
            : betterAuthTables.has(table)
              ? null
              : `\`${table}\``;
      if (listed)
        check(
          'ids',
          `§1.4 names ${listed} for ${scope}.${table}`,
          conventions.includes(listed),
          true,
        );
      const re = new RegExp(`^${prefix ? `${prefix}_` : ''}${ULID}$`);
      for (const row of rows) {
        check('ids', `${scope}.${table} ${row.id} format`, re.test(row.id), true);
        check('ids', `${row.id} unique`, seen.has(row.id), false);
        seen.add(row.id);
      }
    }
  }
  for (const [key, id] of Object.entries(fixture.keys))
    check('ids', `key ${key} resolves to a row`, seen.has(id), true);
}

async function checkIntegrity(ws, ctl) {
  check(
    'integrity',
    'workspace PRAGMA foreign_key_check',
    await q(ws, 'PRAGMA foreign_key_check'),
    [],
  );
  check(
    'integrity',
    'control PRAGMA foreign_key_check',
    await q(ctl, 'PRAGMA foreign_key_check'),
    [],
  );
  check('integrity', 'catalog_search is not seeded', 'catalog_search' in fixture.workspace, false);
  for (const [db, scope, tables] of [
    [ws, 'workspace', fixture.workspace],
    [ctl, 'control', fixture.control],
  ]) {
    for (const [table, rows] of Object.entries(tables)) {
      const columns = (await q(db, `PRAGMA table_info("${table}")`)).map((c) => c.name).sort();
      for (const row of rows)
        check(
          'integrity',
          `${scope}.${table} ${row.id ?? ''} sets every DDL column`,
          Object.keys(row).sort(),
          columns,
        );
    }
  }
  const derivedName = /total|ready|follow_up_due|heard|priority|days_overdue/i;
  for (const [table, rows] of [
    ...Object.entries(fixture.workspace),
    ...Object.entries(fixture.control),
  ]) {
    const cols = new Set(rows.flatMap((r) => Object.keys(r)));
    check(
      'integrity',
      `${table} stores no derived column`,
      [...cols].filter((c) => derivedName.test(c)),
      [],
    );
  }
  for (const [table, rows] of Object.entries(fixture.workspace)) {
    for (const row of rows) {
      for (const [col, value] of Object.entries(row)) {
        if (col.endsWith('_at') && value != null)
          check('integrity', `${table}.${col} ${value} is ISO UTC`, ISO_TS.test(value), true);
      }
    }
  }
}

async function checkFictional() {
  const strings = [];
  const walk = (v) =>
    typeof v === 'string'
      ? strings.push(v)
      : v && typeof v === 'object' && Object.values(v).forEach(walk);
  walk({ control: fixture.control, workspace: fixture.workspace });
  for (const s of strings) {
    for (const [, domain] of s.matchAll(/[\w.+-]+@([\w.-]+)/g))
      check('fictional', `email domain ${domain}`, domain.endsWith('.example'), true);
    for (const [, host] of s.matchAll(/https?:\/\/([\w.-]+)/g))
      check('fictional', `url host ${host}`, host.endsWith('.example'), true);
  }
  for (const m of fixture.workspace.contact_methods.filter((m) => m.method_type === 'phone'))
    check('fictional', `phone ${m.value}`, /555-01\d\d$/.test(m.value), true);
}

async function checkProjections(ws) {
  const pitchSection = sections(contractMd, /^### [\d.]+ Pitch status vocabulary\b/)[0];
  const codes = tableByHeader(pitchSection, '| Code |').map((r) => r.Code);
  const allowed = new Map(
    tableByHeader(pitchSection, '| From | To |').map((r) => [
      r.From,
      r.To.split(',').map((s) => s.trim()),
    ]),
  );
  const items = await q(ws, 'SELECT id, current_status FROM pitch_items ORDER BY id');
  for (const item of items) {
    check(
      'projections',
      `${K(item.id)} status is a §6.4 code`,
      codes.includes(item.current_status),
      true,
    );
    const events = await q(
      ws,
      "SELECT from_status, to_status FROM pitch_events WHERE pitch_item_id = ? AND event_type = 'status_changed' ORDER BY occurred_at, id",
      [item.id],
    );
    let status = 'draft';
    const history = [];
    for (const e of events) {
      check(
        'projections',
        `${K(item.id)} event from_status follows ${status}`,
        e.from_status,
        status,
      );
      const ok =
        status === 'archived'
          ? e.to_status === history.at(-1)
          : (allowed.get(status) ?? []).includes(e.to_status);
      check('projections', `${K(item.id)} ${status} -> ${e.to_status} allowed by §6.4`, ok, true);
      history.push(status);
      status = e.to_status;
    }
    check(
      'projections',
      `${K(item.id)} current_status is the latest status event`,
      item.current_status,
      status,
    );
  }
  const [settings] = await q(
    ws,
    'SELECT COUNT(*) AS n, MAX(follow_up_interval_days) AS days FROM workspace_settings',
  );
  check('projections', 'workspace_settings has exactly one row (§4.3)', settings.n, 1);
  const pitches = await q(
    ws,
    `SELECT p.id, p.last_contacted_at, p.next_follow_up_at,
      (SELECT MAX(occurred_at) FROM pitch_events e WHERE e.pitch_id = p.id AND e.event_type IN ('message_sent', 'call', 'meeting')) AS contact_event_at,
      (SELECT MAX(sent_at) FROM messages m WHERE m.pitch_id = p.id AND m.direction = 'outbound' AND m.status = 'sent') AS last_sent_at
    FROM pitches p`,
  );
  for (const p of pitches) {
    check(
      'projections',
      `${K(p.id)} last_contacted_at is the latest contact event`,
      p.last_contacted_at,
      p.contact_event_at,
    );
    check(
      'projections',
      `${K(p.id)} next_follow_up_at is last sent + follow_up_interval_days`,
      p.next_follow_up_at,
      p.last_sent_at ? addDaysIso(p.last_sent_at, settings.days) : null,
    );
  }
  const sent = await q(
    ws,
    `SELECT m.id, m.sent_at, pc.value AS contact_email,
      (SELECT COUNT(*) FROM pitch_events e WHERE e.pitch_id = m.pitch_id AND e.event_type = 'message_sent' AND e.occurred_at = m.sent_at
        AND json_extract(e.metadata_json, '$.messageId') = m.id) AS events,
      (SELECT address_snapshot FROM message_recipients r WHERE r.message_id = m.id AND r.recipient_type = 'to') AS to_address
    FROM messages m JOIN pitches p ON p.id = m.pitch_id JOIN contacts k ON k.id = p.contact_id
    LEFT JOIN contact_methods pc ON pc.party_id = k.party_id AND pc.method_type = 'email' AND pc.is_primary = 1
    WHERE m.status = 'sent'`,
  );
  for (const m of sent) {
    check('projections', `${K(m.id)} has one message_sent event`, m.events, 1);
    check(
      'projections',
      `${K(m.id)} goes to the contact's primary email`,
      m.to_address,
      m.contact_email,
    );
  }
  const open = await q(
    ws,
    `SELECT p.contact_id, COALESCE(pi.composition_id, r.composition_id) AS cid, COUNT(*) AS n
    FROM pitch_items pi JOIN pitches p ON p.id = pi.pitch_id LEFT JOIN recordings r ON r.id = pi.recording_id
    WHERE pi.current_status NOT IN ('closed_won', 'closed_lost', 'archived') GROUP BY 1, 2 HAVING n > 1`,
  );
  check('projections', 'no second open cell for a contact and song (§4.4)', open, []);
}

async function checkMembership(ws, ctl) {
  // A shared control database holds other organizations' members.
  const members = await q(ctl, 'SELECT user_id, role FROM member WHERE organization_id = ?', [
    idOf(fixture.demo.organization),
  ]);
  check(
    'membership',
    'only Jordan Taylor is a member',
    members.map((m) => `${K(m.user_id)} ${m.role}`),
    ['usr_JORDAN owner'],
  );
  const [user] = await q(ctl, 'SELECT email FROM user WHERE id = ?', [idOf('usr_JORDAN')]);
  const [jordan] = await q(
    ws,
    "SELECT value FROM contact_methods WHERE party_id = ? AND method_type = 'email' AND is_primary = 1",
    [idOf('pty_JORDAN')],
  );
  check('membership', "user email is Jordan's party email", user.email, jordan.value);
  const emails = await q(
    ws,
    "SELECT value, COUNT(*) AS n FROM contact_methods WHERE method_type = 'email' GROUP BY value HAVING n > 1",
  );
  check('membership', 'parties are deduplicated by email', emails, []);
  for (const icp of source.icps) {
    const rows = await q(
      ws,
      `SELECT p.id, (SELECT COUNT(*) FROM contacts k WHERE k.party_id = p.id) AS contacts,
        (SELECT value FROM contact_methods m WHERE m.party_id = p.id AND m.method_type = 'phone') AS phone
      FROM parties p JOIN contact_methods m ON m.party_id = p.id AND m.method_type = 'email' WHERE m.value = ?`,
      [icp.email],
    );
    check('membership', `${icp.id} is one person party`, rows.length, 1);
    check('membership', `${icp.id} phone`, rows[0]?.phone, icp.phone);
    const isContact = source.contacts.some((c) => c.email === icp.email);
    check(
      'membership',
      `${icp.id} is a contact only when FX contacts[] lists the email`,
      rows[0]?.contacts,
      isContact ? 1 : 0,
    );
    check(
      'membership',
      `${icp.id} company party`,
      (
        await q(ws, 'SELECT COUNT(*) AS n FROM organizations WHERE legal_name = ?', [icp.company])
      )[0].n,
      1,
    );
  }
}

async function checkSource(ws, ready) {
  const pitchSection = sections(contractMd, /^### [\d.]+ Pitch status vocabulary\b/)[0];
  const legacy = new Map(
    tableByHeader(pitchSection, '| Legacy label |').map((r) => [
      r['Legacy label'].replace(/\s*\(.*\)$/, ''),
      r['Canonical code'],
    ]),
  );
  for (const song of source.catalog) {
    const cid = await compositionByTitle(ws, song.title);
    const [row] = await q(
      ws,
      `SELECT c.iswc, r.id AS rid, r.title AS rtitle, r.isrc, r.preview_start_ms, w.writer_total_bp, t.publishing_total_bp, mt.master_total_bp,
        (SELECT url FROM recording_links l WHERE l.recording_id = r.id AND l.is_primary = 1) AS url,
        (SELECT COUNT(*) FROM licensing_contacts lc WHERE lc.recording_id = r.id OR lc.composition_id = c.id) AS licensing
      FROM compositions c JOIN recordings r ON r.composition_id = c.id
      JOIN composition_writer_totals w ON w.composition_id = c.id
      LEFT JOIN composition_publishing_totals t ON t.composition_id = c.id AND t.territory = 'WORLD'
      JOIN recording_master_totals mt ON mt.recording_id = r.id WHERE c.id = ?`,
      [cid],
    );
    const label = `FX ${song.title}`;
    check('source', `${label} recording title`, row.rtitle, song.title);
    check('source', `${label} iswc normalized`, row.iswc, song.iswc.replace(/[^A-Z0-9]/g, ''));
    check(
      'source',
      `${label} isrc normalized`,
      row.isrc,
      song.isrc?.replace(/[^A-Z0-9]/g, '') ?? null,
    );
    const [mm, ss] = song.previewStart.split(':').map(Number);
    check('source', `${label} preview_start_ms`, row.preview_start_ms, (mm * 60 + ss) * 1000);
    check('source', `${label} listen link`, row.url, song.listenUrl);
    check('source', `${label} writersTotal`, row.writer_total_bp, song.writersTotal * 100);
    check(
      'source',
      `${label} publishingTotal`,
      row.publishing_total_bp,
      song.publishingTotal * 100,
    );
    check('source', `${label} masterTotal`, row.master_total_bp, song.masterTotal * 100);
    check('source', `${label} oneStopReady`, ready.get(row.rid).oneStopReady, song.oneStopReady);
    if ('licensingContact' in song && song.licensingContact === null)
      check('source', `${label} licensingContact null means no row`, row.licensing, 0);
    const alts = (
      await q(ws, 'SELECT title FROM composition_alt_titles WHERE composition_id = ?', [cid])
    ).map((r) => r.title);
    check('source', `${label} alt titles`, alts, song.altTitle ? [song.altTitle] : []);
    const artists = await q(
      ws,
      `SELECT p.display_name, ra.role FROM recording_artists ra JOIN parties p ON p.id = ra.party_id
      WHERE ra.recording_id = ? ORDER BY ra.billing_order`,
      [row.rid],
    );
    check(
      'source',
      `${label} artists`,
      artists.map((a) => `${a.role} ${a.display_name}`),
      [`primary ${song.artist}`, ...(song.featuring ?? []).map((f) => `featured ${f}`)],
    );
  }
  for (const ex of source.rightsExamples) {
    const cid = await compositionByTitle(ws, ex.song);
    const sides = [
      [
        'writers',
        'SELECT p.display_name AS party, cc.writer_share_bp AS bp FROM composition_contributors cc JOIN parties p ON p.id = cc.party_id WHERE cc.composition_id = ?',
        cid,
      ],
      [
        'publishers',
        "SELECT p.display_name AS party, pi.share_bp AS bp FROM publishing_interests pi JOIN parties p ON p.id = pi.publisher_party_id WHERE pi.composition_id = ? AND pi.territory = 'WORLD'",
        cid,
      ],
      [
        'masterOwners',
        'SELECT p.display_name AS party, mi.share_bp AS bp FROM master_interests mi JOIN parties p ON p.id = mi.owner_party_id JOIN recordings r ON r.id = mi.recording_id WHERE r.composition_id = ?',
        cid,
      ],
    ];
    for (const [side, sql, arg] of sides) {
      const actual = (await q(ws, `${sql} ORDER BY party`, [arg])).map((r) => `${r.party} ${r.bp}`);
      // §2.6 and §5.6: Ocean Blue writers are reseeded 50/50 so DEMO-008 changes data.
      const reseed = ex.song === 'Ocean Blue' && side === 'writers';
      const expected = ex[side].map((s) => `${s.party} ${reseed ? 5000 : s.percent * 100}`).sort();
      check(
        'source',
        `FX rightsExamples ${ex.song} ${side}${reseed ? ' (reseeded 50/50)' : ''}`,
        actual,
        expected,
      );
    }
  }
  for (const c of source.contacts) {
    const rows = await q(
      ws,
      `SELECT o.display_name AS company, (SELECT group_concat(role) FROM contact_roles cr WHERE cr.contact_id = k.id) AS roles
      FROM contacts k JOIN parties p ON p.id = k.party_id JOIN parties o ON o.id = k.organization_party_id
      JOIN contact_methods m ON m.party_id = p.id AND m.method_type = 'email' WHERE m.value = ? AND p.display_name = ?`,
      [c.email, c.name],
    );
    check(
      'source',
      `FX contact ${c.name}`,
      rows.map((r) => `${r.company} ${r.roles}`),
      [`${c.company} ${c.type.toLowerCase().replace(/ /g, '_')}`],
    );
  }
  check(
    'source',
    'every FX pitch maps to one cell',
    Object.keys(fixture.fxCells).length,
    source.pitches.length,
  );
  for (const p of source.pitches) {
    const key = fixture.fxCells[`${p.song}|${p.contact}`];
    const [cell] = await q(
      ws,
      `SELECT pi.current_status, pi.recording_id, r.title, pt.display_name
      FROM pitch_items pi JOIN pitches pc ON pc.id = pi.pitch_id JOIN contacts k ON k.id = pc.contact_id JOIN parties pt ON pt.id = k.party_id
      JOIN recordings r ON r.id = pi.recording_id WHERE pi.id = ?`,
      [key ? idOf(key) : ''],
    );
    check(
      'source',
      `FX pitch ${p.song} x ${p.contact} cell`,
      cell ? `${cell.title} x ${cell.display_name}` : 'missing',
      `${p.song} x ${p.contact}`,
    );
    check(
      'source',
      `FX pitch ${p.song} x ${p.contact} status ${p.status}`,
      cell?.current_status,
      legacy.get(p.status),
    );
  }
}

async function checkContractReadiness(ws, ready) {
  const text = sections(contractMd, /^### [\d.]+ One-stop and sync readiness\b/)[0];
  const rows = tableByHeader(text, '| Song | Writer / publishing / master totals');
  check('contract', '§6.5 readiness table covers every song', rows.length, source.catalog.length);
  for (const row of rows) {
    const cid = await compositionByTitle(ws, row.Song);
    const [t] = await q(
      ws,
      `SELECT w.writer_total_bp AS w, p.publishing_total_bp AS p, m.master_total_bp AS m, r.id AS rid
      FROM compositions c JOIN recordings r ON r.composition_id = c.id JOIN composition_writer_totals w ON w.composition_id = c.id
      JOIN composition_publishing_totals p ON p.composition_id = c.id JOIN recording_master_totals m ON m.recording_id = r.id WHERE c.id = ?`,
      [cid],
    );
    const r = ready.get(t.rid);
    check(
      'contract',
      `§6.5 ${row.Song} totals`,
      `${t.w / 100} / ${t.p / 100} / ${t.m / 100}`,
      row['Writer / publishing / master totals (%)'],
    );
    check(
      'contract',
      `§6.5 ${row.Song} codes`,
      [...r.blocking, ...r.sync].sort(),
      (row['Blocking codes'].match(/[A-Z][A-Z_]{3,}/g) ?? []).sort(),
    );
    check('contract', `§6.5 ${row.Song} oneStopReady`, String(r.oneStopReady), row.oneStopReady);
    check('contract', `§6.5 ${row.Song} syncReady`, String(r.syncReady), row.syncReady);
  }
}

async function checkExpected(ws, ctl, workspaceDdl, ready, tables) {
  const need = (name) => {
    const t = tables.get(name);
    if (!t) throw new Error(`EXPECTED.md has no <!-- check:${name} --> table`);
    return t;
  };
  const yesNo = (b) => (b ? 'yes' : 'no');

  // Keys used anywhere in EXPECTED.md exist in the fixture.
  for (const token of new Set(expectedMd.match(KEY_TOKEN) ?? [])) {
    if (
      /^(?:con|cmp|rec|pty|pti|pit|msg|lnk|ctr|tpl|usr|ws)_|^(?:contact_methods|composition_alt_titles|publishing_interests|master_interests|recording_artists|organization|member):/.test(
        token,
      )
    ) {
      check('expected', `key ${token} exists`, token in fixture.keys, true);
    }
  }

  // §1 totals
  const totals = need('totals');
  check(
    'expected:totals',
    'one row per recording',
    totals.length,
    (await q(ws, 'SELECT COUNT(*) AS n FROM recordings WHERE deleted_at IS NULL'))[0].n,
  );
  for (const e of totals) {
    const cid = await compositionByTitle(ws, e.Song);
    const rows = await q(
      ws,
      `SELECT c.id AS cid, r.id AS rid, w.writer_total_bp, w.writer_count, p.territory, p.publishing_total_bp, p.publisher_count, m.master_total_bp, m.owner_count
      FROM compositions c JOIN recordings r ON r.composition_id = c.id JOIN composition_writer_totals w ON w.composition_id = c.id
      LEFT JOIN composition_publishing_totals p ON p.composition_id = c.id JOIN recording_master_totals m ON m.recording_id = r.id WHERE c.id = ?`,
      [cid],
    );
    check('expected:totals', `${e.Song} has one territory set`, rows.length, 1);
    const a = rows[0];
    const complete =
      a.writer_total_bp === 10000 && a.publishing_total_bp === 10000 && a.master_total_bp === 10000;
    const actual = [
      K(a.cid),
      K(a.rid),
      a.writer_total_bp,
      a.writer_count,
      a.territory,
      a.publishing_total_bp,
      a.publisher_count,
      a.master_total_bp,
      a.owner_count,
      yesNo(complete),
    ].map(String);
    const expected = [
      e.Composition,
      e.Recording,
      e['Writer total bp'],
      e.Writers,
      e.Territory,
      e['Publishing total bp'],
      e.Publishers,
      e['Master total bp'],
      e.Owners,
      e.Complete,
    ];
    check('expected:totals', e.Song, actual, expected);
    check(
      'expected:totals',
      `${e.Song} incomplete totals name the demo that relies on them`,
      complete ? e['Relied on by'] === '—' : /DEMO-\d{3}/.test(e['Relied on by']),
      true,
    );
  }

  // §1 holders
  const holders = need('holders');
  const [self] = await q(
    ws,
    `SELECT (SELECT party_id FROM workspace_self_parties WHERE side = 'writer') AS w,
    (SELECT party_id FROM workspace_self_parties WHERE side = 'publishing') AS p, (SELECT party_id FROM workspace_self_parties WHERE side = 'master') AS m`,
  );
  const actualHolders = (
    await q(
      ws,
      `
    SELECT c.title AS song, 1 AS side_order, 'writer' AS side, cc.party_id, pt.display_name, cc.writer_share_bp AS bp,
      (SELECT group_concat(role, ', ') FROM composition_contributor_roles r WHERE r.contributor_id = cc.id) AS roles, NULL AS attested
    FROM composition_contributors cc JOIN compositions c ON c.id = cc.composition_id JOIN parties pt ON pt.id = cc.party_id
    UNION ALL
    SELECT c.title, 2, 'publishing ' || pi.territory, pi.publisher_party_id, pt.display_name, pi.share_bp, NULL, pi.representation_attested_at IS NOT NULL
    FROM publishing_interests pi JOIN compositions c ON c.id = pi.composition_id JOIN parties pt ON pt.id = pi.publisher_party_id
    UNION ALL
    SELECT r.title, 3, 'master', mi.owner_party_id, pt.display_name, mi.share_bp, NULL, mi.representation_attested_at IS NOT NULL
    FROM master_interests mi JOIN recordings r ON r.id = mi.recording_id JOIN parties pt ON pt.id = mi.owner_party_id
    ORDER BY song, side_order, display_name`,
    )
  ).map((h) => {
    const selfParty = h.side === 'writer' ? self.w : h.side === 'master' ? self.m : self.p;
    return [
      h.song,
      h.side,
      K(h.party_id),
      h.display_name,
      String(h.bp),
      h.roles ?? '—',
      yesNo(h.party_id === selfParty),
      h.attested == null ? '—' : yesNo(h.attested),
    ].join(' | ');
  });
  const expectedHolders = holders.map((e) =>
    [e.Song, e.Side, e.Party, e.Holder, e['Share bp'], e.Roles, e['Self party'], e.Attested].join(
      ' | ',
    ),
  );
  check('expected:holders', 'row count', actualHolders.length, expectedHolders.length);
  for (const row of expectedHolders)
    check('expected:holders', row, actualHolders.includes(row), true);

  // §2 readiness
  const list = (codes) => (codes.length ? codes.join(', ') : 'none');
  const readinessRows = need('readiness');
  check('expected:readiness', 'one row per recording', readinessRows.length, ready.size);
  for (const e of readinessRows) {
    const r = ready.get(idOf(e.Recording));
    const actual = [
      list(r.blocking),
      list(r.sync),
      list(r.warning),
      String(r.oneStopReady),
      String(r.syncReady),
      r.licensingContact,
    ];
    check('expected:readiness', e.Song, actual, [
      e['One-stop codes'],
      e['Sync-only codes'],
      e.Warnings,
      e.oneStopReady,
      e.syncReady,
      e['Licensing contact'],
    ]);
  }

  // §3 heard
  const heardRows = need('heard');
  const contactCount = (
    await q(ws, 'SELECT COUNT(*) AS n FROM contacts WHERE deleted_at IS NULL AND active = 1')
  )[0].n;
  check(
    'expected:heard',
    'every active contact against every song',
    heardRows.length,
    contactCount * source.catalog.length,
  );
  for (const e of heardRows) {
    const cid = await compositionByTitle(ws, e.Song);
    const { rows, planned, never } = await rollup(ws, cid);
    const contactId = idOf(e.Contact);
    const row = rows.find((r) => r.contact_id === contactId);
    const cells = await q(
      ws,
      `${CELLS_CTE} SELECT item_id, current_status, archived_from FROM cells WHERE contact_id = ? AND composition_id = ? ORDER BY item_id`,
      [contactId, cid],
    );
    const cellText = cells.length
      ? cells
          .map(
            (c) =>
              `${K(c.item_id)} ${c.current_status}${c.current_status === 'archived' ? ` (from ${c.archived_from})` : ''}`,
          )
          .join(', ')
      : 'none';
    const listName = row.heard ? 'heard' : row.has_cell ? 'plannedNotContacted' : 'neverPitched';
    const position = row.heard
      ? '—'
      : String((row.has_cell ? planned : never).findIndex((r) => r.contact_id === contactId) + 1);
    check(
      'expected:heard',
      `${e.Song} x ${e.Contact}`,
      [cellText, yesNo(row.heard), listName, position],
      [e.Cells, e.Heard, e.List, e.Position],
    );
    const [rec] = await q(ws, 'SELECT id FROM recordings WHERE composition_id = ?', [cid]);
    check(
      'expected:heard',
      `${e.Song} x ${e.Contact} recording rollup agrees`,
      Boolean(await recordingHeard(ws, rec.id, contactId)),
      Boolean(row.heard),
    );
  }

  // §4 follow-ups
  const { date, timezone } = fixture.demo;
  const fu = await followUps(ws, date, timezone);
  check(
    'expected:due',
    `end(D) ${fu.end} is the one EXPECTED.md states`,
    expectedMd.includes(`\`${fu.end}\``),
    true,
  );
  for (const r of [...fu.due, ...fu.notDue].filter((r) => r.next_follow_up_at)) {
    check(
      'expected:due',
      `${K(r.item_id)} follow-up shares the demo date's UTC offset`,
      tzOffsetMinutes(Date.parse(r.next_follow_up_at), timezone),
      fu.offset,
    );
  }
  const songTitle = async (cid) =>
    (await q(ws, 'SELECT title FROM compositions WHERE id = ?', [cid]))[0].title;
  const dueRows = need('due');
  check('expected:due', 'due count', fu.due.length, dueRows.length);
  for (const [i, e] of dueRows.entries()) {
    const a = fu.due[i];
    if (!a) continue;
    const actual = [
      String(i + 1),
      K(a.item_id),
      K(a.pitch_id),
      K(a.contact_id),
      await songTitle(a.composition_id),
      a.level,
      a.current_status,
      a.next_follow_up_at,
      a.last_contacted_at ?? 'none',
      String(a.days_overdue),
    ];
    check('expected:due', `rank ${e.Rank}`, actual, [
      e.Rank,
      e['Pitch item'],
      e.Pitch,
      e.Contact,
      e.Song,
      e.Level,
      e.Status,
      e.next_follow_up_at,
      e.last_contacted_at,
      e['Days overdue'],
    ]);
  }
  const notDueRows = need('not-due');
  check('expected:not-due', 'not-due count', fu.notDue.length, notDueRows.length);
  for (const e of notDueRows) {
    const a = fu.notDue.find((r) => r.item_id === idOf(e['Pitch item']));
    const actual = a
      ? [
          K(a.contact_id),
          await songTitle(a.composition_id),
          a.current_status,
          a.next_follow_up_at ?? 'none',
          a.last_contacted_at ?? 'none',
          a.not_due_reason,
        ]
      : ['missing'];
    check('expected:not-due', e['Pitch item'], actual, [
      e.Contact,
      e.Song,
      e.Status,
      e.next_follow_up_at,
      e.last_contacted_at,
      e.Reason,
    ]);
  }

  // §5 search
  for (const e of need('search')) {
    const label = `${e.Tool} "${e.Query}"`;
    if (e.Tool === 'searchMusic') {
      check(
        'expected:search',
        `${label} MATCH expression`,
        matchExpression(e.Query),
        e['MATCH expression'],
      );
      const results = await searchMusic(ws, e.Query);
      check(
        'expected:search',
        label,
        [
          results.map((r) => K(r.id)).join(', '),
          results.map((r) => r.matchType).join(', '),
          results.map((r) => K(r.primary)).join(', '),
        ],
        [e.Results, e.matchType, e.primaryRecordingId],
      );
    } else if (e.Tool === 'searchContacts') {
      const rows = await q(
        ws,
        `SELECT k.id FROM contacts k JOIN parties p ON p.id = k.party_id LEFT JOIN parties o ON o.id = k.organization_party_id
        WHERE k.deleted_at IS NULL AND k.active = 1 AND (instr(lower(p.display_name), lower(?1)) > 0 OR instr(lower(COALESCE(o.display_name, '')), lower(?1)) > 0
          OR EXISTS (SELECT 1 FROM contact_methods m WHERE m.party_id = k.party_id AND m.method_type = 'email' AND instr(lower(m.value), lower(?1)) > 0))
        ORDER BY p.display_name`,
        [e.Query],
      );
      check('expected:search', label, rows.map((r) => K(r.id)).join(', '), e.Results);
    } else {
      const cid = idOf(e.Tool.match(/cmp_[A-Z_]+/)[0]);
      const rows = await q(
        ws,
        `SELECT cc.party_id FROM composition_contributors cc JOIN parties p ON p.id = cc.party_id
        WHERE cc.composition_id = ? AND instr(lower(p.display_name), lower(?)) > 0 ORDER BY p.display_name`,
        [cid, e.Query],
      );
      check('expected:search', label, rows.map((r) => K(r.party_id)).join(', '), e.Results);
    }
  }

  // §6 facts
  const facts = {
    members: async (org) =>
      (await q(ctl, 'SELECT user_id, role FROM member WHERE organization_id = ?', [idOf(org)]))
        .map((m) => `${K(m.user_id)} ${m.role}`)
        .join(', '),
    workspace: async (org) =>
      (
        await q(ctl, 'SELECT id, status FROM workspace_registry WHERE organization_id = ?', [
          idOf(org),
        ])
      )
        .map((w) => `${K(w.id)} ${w.status}`)
        .join(', '),
    timezone: async (user) =>
      (
        await q(ctl, 'SELECT timezone FROM workspace_member_settings WHERE user_id = ?', [
          idOf(user),
        ])
      )[0].timezone,
    identifiers: async (cmp) => {
      const [c] = await q(ws, 'SELECT iswc FROM compositions WHERE id = ?', [idOf(cmp)]);
      const recs = await q(
        ws,
        'SELECT id, isrc FROM recordings WHERE composition_id = ? ORDER BY id',
        [idOf(cmp)],
      );
      return [c.iswc, ...recs.map((r) => `${K(r.id)} ${r.isrc}`)].join(', ');
    },
    primary_link: async (rec) =>
      (
        await q(
          ws,
          `SELECT l.id, l.url, r.preview_start_ms FROM recording_links l JOIN recordings r ON r.id = l.recording_id
      WHERE l.recording_id = ? AND l.is_primary = 1`,
          [idOf(rec)],
        )
      )
        .map((l) => `${K(l.id)} ${l.url} from ${l.preview_start_ms}`)
        .join(', '),
    pitch_counts: async (cmp) =>
      (
        await q(
          ws,
          `SELECT pi.current_status, COUNT(*) AS n FROM pitch_items pi LEFT JOIN recordings r ON r.id = pi.recording_id
      WHERE pi.composition_id = ?1 OR r.composition_id = ?1 GROUP BY 1 ORDER BY 1`,
          [idOf(cmp)],
        )
      )
        .map((r) => `${r.current_status} ${r.n}`)
        .join(', '),
    writers: async (cmp) =>
      (
        await q(
          ws,
          `SELECT cc.party_id, cc.writer_share_bp, (SELECT group_concat(role, ', ') FROM composition_contributor_roles r WHERE r.contributor_id = cc.id) AS roles
      FROM composition_contributors cc JOIN parties p ON p.id = cc.party_id WHERE cc.composition_id = ? ORDER BY p.display_name`,
          [idOf(cmp)],
        )
      )
        .map((w) => `${K(w.party_id)} ${w.roles} ${w.writer_share_bp}`)
        .join(', '),
    not_sync_ready: async () =>
      (await q(ws, 'SELECT id FROM recordings WHERE deleted_at IS NULL ORDER BY title'))
        .filter((r) => !ready.get(r.id).syncReady)
        .map((r) => K(r.id))
        .join(', '),
    publishing_total: async (cmp, territory) =>
      String(
        (
          await q(
            ws,
            'SELECT publishing_total_bp FROM composition_publishing_totals WHERE composition_id = ? AND territory = ?',
            [idOf(cmp), territory],
          )
        )[0].publishing_total_bp,
      ),
    planned_not_contacted: async (cmp) =>
      (await rollup(ws, idOf(cmp))).planned.map((r) => K(r.contact_id)).join(', '),
    never_pitched: async (cmp) =>
      (await rollup(ws, idOf(cmp))).never.map((r) => K(r.contact_id)).join(', '),
    cells: async (con, cmp) =>
      (
        await q(
          ws,
          `${CELLS_CTE} SELECT item_id, pitch_id, current_status FROM cells WHERE contact_id = ? AND composition_id = ? ORDER BY item_id`,
          [idOf(con), idOf(cmp)],
        )
      )
        .map((c) => `${K(c.item_id)} ${K(c.pitch_id)} ${c.current_status}`)
        .join(', '),
    last_outbound: async (pit) =>
      K(
        (
          await q(
            ws,
            "SELECT id FROM messages WHERE pitch_id = ? AND direction = 'outbound' AND status = 'sent' ORDER BY sent_at DESC, id DESC LIMIT 1",
            [idOf(pit)],
          )
        )[0]?.id,
      ),
    message: async (msg) =>
      (
        await q(ws, 'SELECT direction, purpose, status, sent_at FROM messages WHERE id = ?', [
          idOf(msg),
        ])
      )
        .map((m) => `${m.direction} ${m.purpose} ${m.status} ${m.sent_at}`)
        .join(', '),
    subject: async (msg) =>
      (await q(ws, 'SELECT subject FROM messages WHERE id = ?', [idOf(msg)]))[0].subject,
    has_body: async (msg) =>
      String(
        Boolean(
          (
            await q(ws, 'SELECT body_text FROM messages WHERE id = ?', [idOf(msg)])
          )[0].body_text?.trim(),
        ),
      ),
    recipients: async (msg) =>
      (
        await q(
          ws,
          "SELECT recipient_type, address_snapshot FROM message_recipients WHERE message_id = ? ORDER BY CASE recipient_type WHEN 'from' THEN 0 WHEN 'to' THEN 1 WHEN 'cc' THEN 2 ELSE 3 END, address_snapshot",
          [idOf(msg)],
        )
      )
        .map((r) => `${r.recipient_type} ${r.address_snapshot}`)
        .join(', '),
    default_recipient: async (pit) =>
      (
        await q(
          ws,
          `SELECT m.id, m.value FROM pitches p JOIN contacts k ON k.id = p.contact_id
      JOIN contact_methods m ON m.party_id = k.party_id AND m.method_type = 'email' AND m.is_primary = 1 WHERE p.id = ?`,
          [idOf(pit)],
        )
      )
        .map((m) => `${K(m.id)} ${m.value}`)
        .join(', '),
    follow_up_interval: async () =>
      String(
        (await q(ws, 'SELECT follow_up_interval_days AS days FROM workspace_settings'))[0].days,
      ),
    queue_after_send: async (pit, sentAt) => {
      const [{ days }] = await q(
        ws,
        'SELECT follow_up_interval_days AS days FROM workspace_settings',
      );
      const tx = await ws.transaction('write');
      try {
        await tx.execute({
          sql: 'UPDATE pitches SET last_contacted_at = ?, next_follow_up_at = ? WHERE id = ?',
          args: [sentAt, addDaysIso(sentAt, days), idOf(pit)],
        });
        return (await followUps(tx, date, timezone)).due.map((r) => K(r.item_id)).join(', ');
      } finally {
        await tx.rollback();
      }
    },
    rebalance: async (cmp, party, bp) => {
      const writers = await q(
        ws,
        'SELECT party_id, writer_share_bp FROM composition_contributors WHERE composition_id = ?',
        [idOf(cmp)],
      );
      const others = writers.filter((w) => w.party_id !== idOf(party));
      if (others.length !== 1) return `ask (${others.length} other writers)`;
      return [
        [idOf(party), Number(bp)],
        [others[0].party_id, 10000 - Number(bp)],
      ]
        .sort((a, b) => K(a[0]).localeCompare(K(b[0])))
        .map(([p, s]) => `${K(p)} ${s}`)
        .join(', ');
    },
    apply_writer_shares: async (cmp, ...pairs) => {
      const shares = pairs
        .map((p) => p.split('='))
        .map(([key, bp]) => ({ partyId: idOf(key), shareBp: Number(bp) }));
      const tx = await ws.transaction('write');
      try {
        const changed = await replaceWriterShares(
          tx,
          idOf(cmp),
          shares,
          '2026-09-14T17:00:00.000Z',
          idOf('usr_JORDAN'),
        );
        const [t] = await q(
          tx,
          'SELECT writer_total_bp FROM composition_writer_totals WHERE composition_id = ?',
          [idOf(cmp)],
        );
        // DAT-001: the write leaves no foreign-key violation, whether or not the connection enforces them.
        const violations = await q(tx, 'PRAGMA foreign_key_check');
        if (violations.length) return `foreign_key_check: ${JSON.stringify(violations)}`;
        return `changed ${changed}, writer_total_bp ${t.writer_total_bp}`;
      } finally {
        await tx.rollback();
      }
    },
    audit_rows: async () => String((await q(ws, 'SELECT COUNT(*) AS n FROM audit_log'))[0].n),
    other_workspace: async (cmp) => {
      const other = await freshDb(workspaceDdl);
      try {
        return (await q(other, 'SELECT id FROM compositions WHERE id = ?', [idOf(cmp)])).length
          ? 'FOUND'
          : 'NOT_FOUND';
      } finally {
        other.close();
      }
    },
    template: async (preset) =>
      (
        await q(
          ws,
          'SELECT id, config_json FROM report_templates WHERE preset_key = ? AND is_system = 1',
          [preset],
        )
      )
        .map((t) => {
          const sections = JSON.parse(t.config_json).sections;
          return `${K(t.id)} on ${sections
            .filter((s) => s.enabled)
            .map((s) => s.id)
            .join(', ')}; off ${sections
            .filter((s) => !s.enabled)
            .map((s) => s.id)
            .join(', ')}`;
        })
        .join(', '),
    report_item: async (cmp) => K(await primaryRecordingId(ws, idOf(cmp))),
    has_lyrics: async (cmp) =>
      String(
        Boolean(
          (
            await q(ws, 'SELECT lyrics FROM compositions WHERE id = ?', [idOf(cmp)])
          )[0].lyrics?.trim(),
        ),
      ),
    due_queue: async (day) =>
      (await followUps(ws, day, timezone)).due.map((r) => K(r.item_id)).join(', '),
  };
  const sectionOrder = sections(
    contractMd,
    /^### [\d.]+ Report output format and section order\b/,
  )[0]
    .match(/Section order is fixed: ([^.]+)\./)[1]
    .replace(/`/g, '')
    .split(', ');
  for (const t of await q(ws, 'SELECT id, config_json FROM report_templates')) {
    check(
      'expected:facts',
      `${K(t.id)} sections follow §6.12 order`,
      JSON.parse(t.config_json).sections.map((s) => s.id),
      sectionOrder,
    );
  }
  const used = new Set();
  for (const e of need('facts')) {
    const [name, ...args] = e.Fact.split(/\s+/);
    used.add(name);
    const fn = facts[name];
    check('expected:facts', `${e.Demo} ${e.Fact} is implemented`, typeof fn, 'function');
    if (fn) check('expected:facts', `${e.Demo} ${e.Fact}`, await fn(...args), e.Expected);
  }
  check(
    'expected:facts',
    'every fact implementation is used',
    Object.keys(facts).filter((f) => !used.has(f)),
    [],
  );

  // §7 demo map
  const demos = need('demos');
  const demoIds = [
    ...Array.from({ length: 10 }, (_, i) => `DEMO-${String(i + 1).padStart(3, '0')}`),
    'READ-VS-001',
    'WRITE-VS-001',
  ];
  check(
    'expected:demos',
    'every demo and vertical slice is mapped',
    demos.map((d) => d.Demo),
    demoIds,
  );
  for (const d of demos)
    check(
      'expected:demos',
      `${d.Demo} names records`,
      (d.Records.match(KEY_TOKEN) ?? []).length > 0,
      true,
    );
}

// ---------- main ----------

/** The workspace, Better Auth and control-plane DDL in CONTRACT.md. */
function contractDdl() {
  const workspaceDdl = sections(contractMd, /^### [\d.]+ Workspace database\b/)
    .flatMap(sqlBlocks)
    .join('\n');
  const betterAuthDdl = sections(contractMd, /^## \d+\. Better Auth control-plane DDL\b/)
    .flatMap(sqlBlocks)
    .join('\n');
  const controlDdl = sections(contractMd, /^### [\d.]+ Control plane\b/)
    .flatMap(sqlBlocks)
    .filter((b) => b.trimStart().startsWith('-- melos-control'))
    .join('\n');
  for (const [name, ddl, marker] of [
    ['workspace', workspaceDdl, 'CREATE TABLE pitch_items'],
    ['Better Auth', betterAuthDdl, 'CREATE TABLE `member`'],
    ['control', controlDdl, 'CREATE TABLE workspace_registry'],
  ]) {
    if (!ddl.includes(marker))
      throw new Error(`${name} DDL extracted from CONTRACT.md lacks "${marker}"`);
  }
  return { workspaceDdl, betterAuthDdl, controlDdl };
}

/** Runs every check against loaded workspace and control databases. */
async function runChecks(ws, ctl, { workspaceDdl, betterAuthDdl, controlDdl }) {
  assertions = 0;
  failures.length = 0;
  await checkIds(ws, ctl, workspaceDdl, `${betterAuthDdl}\n${controlDdl}`);
  await checkIntegrity(ws, ctl);
  await checkFictional();
  await checkProjections(ws);
  await checkMembership(ws, ctl);
  const ready = await readiness(ws);
  await checkSource(ws, ready);
  await checkContractReadiness(ws, ready);
  await checkExpected(ws, ctl, workspaceDdl, ready, checkTables(expectedMd));
  check(
    'integrity',
    'workspace PRAGMA foreign_key_check after every check',
    await q(ws, 'PRAGMA foreign_key_check'),
    [],
  );
  check(
    'integrity',
    'control PRAGMA foreign_key_check after every check',
    await q(ctl, 'PRAGMA foreign_key_check'),
    [],
  );
  return { assertions, failures: [...failures] };
}

/**
 * Runs every check against open control and workspace clients of a seeded Northstar workspace
 * (melos-cqn.2), without loading the fixture or building catalog_search. Provisioner-owned ids map
 * to their keys as the seed maps them, the workspace by organization and report templates by
 * preset_key; every other key must match exactly. Returns the assertion count and the failures.
 * Calls must not overlap: they share this module's key map and assertion results.
 */
export async function validateSeeded(ctl, ws) {
  const registry = 'SELECT id FROM workspace_registry WHERE organization_id = ?';
  for (const { id } of await q(ctl, registry, [idOf(fixture.demo.organization)]))
    keyOf.set(id, fixture.demo.workspace);
  for (const template of fixture.workspace.report_templates) {
    const preset = 'SELECT id FROM report_templates WHERE preset_key = ?';
    for (const { id } of await q(ws, preset, [template.preset_key])) keyOf.set(id, K(template.id));
  }
  return runChecks(ws, ctl, contractDdl());
}

async function main() {
  const { workspaceDdl, betterAuthDdl, controlDdl } = contractDdl();
  const ws = await freshDb(workspaceDdl);
  const ctl = await freshDb(`${betterAuthDdl}\n${controlDdl}`);
  try {
    await load(ctl, fixture.control);
    await load(ws, fixture.workspace);
    await buildSearchIndex(ws);
    await runChecks(ws, ctl, { workspaceDdl, betterAuthDdl, controlDdl });
  } finally {
    ws.close();
    ctl.close();
  }

  for (const f of failures)
    console.error(
      `FAIL [${f.group}] ${f.label}\n  expected: ${f.expected}\n  actual:   ${f.actual}`,
    );
  console.log(`${assertions} assertions, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

// Only when node runs this file; npm run db:validate-demo imports validateSeeded instead. Node
// resolves a junction or symlink in the started path, so both sides are real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((err) => {
    console.error(err.stack ?? err);
    process.exitCode = 1;
  });
