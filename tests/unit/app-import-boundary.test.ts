import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');
const DB = join(SRC, 'server', 'db');
const CONNECTIONS = join(SRC, 'server', 'services', 'workspace-connections');

const SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** drizzle-orm and @libsql/* packages, with or without a subpath. */
const DATABASE_PACKAGE = /^(?:drizzle-orm|@libsql\/[^/]+)(?:\/|$)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** Resolves project-local specifiers ('@/...' or relative) to a path without its extension. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const strip = (path: string) => path.replace(/\.(ts|tsx|js|mjs)$/, '');
  if (specifier.startsWith('@/')) return strip(join(SRC, specifier.slice(2)));
  if (specifier.startsWith('.')) return strip(resolve(dirname(fromFile), specifier));
  return null;
}

const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** Import specifiers in `source` that reach a database client, schema or driver directly (§1.5). */
function databaseImports(fromFile: string, source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match.slice(1).find(Boolean);
    if (!specifier) continue;
    const target = resolveLocal(fromFile, specifier);
    const local = target !== null && (isInside(target, DB) || target === CONNECTIONS);
    if (local || DATABASE_PACKAGE.test(specifier)) hits.push(specifier);
  }
  return hits;
}

describe('src/app and src/components import boundary', () => {
  it('detects database imports in every syntax it guards', () => {
    const file = join(SRC, 'app', 'catalog', 'page.tsx');
    const probe = [
      "import { controlDb } from '@/server/db/client';",
      "export type { Row } from '../../server/db/schema/workspace.generated';",
      "const connections = await import('@/server/services/workspace-connections');",
      "import '../../server/services/workspace-connections.ts';",
      "import { eq } from 'drizzle-orm';",
      "import { sqliteTable } from 'drizzle-orm/sqlite-core';",
      "const { createClient } = require('@libsql/client');",
      "import { listSongs } from '@/server/services/catalog/read';",
      "import { database } from '@/server/database';",
    ].join('\n');
    expect(databaseImports(file, probe)).toEqual([
      '@/server/db/client',
      '../../server/db/schema/workspace.generated',
      '@/server/services/workspace-connections',
      '../../server/services/workspace-connections.ts',
      'drizzle-orm',
      'drizzle-orm/sqlite-core',
      '@libsql/client',
    ]);
  });

  it('src/app and src/components call services, never the database', () => {
    const files = ['app', 'components'].flatMap((dir) => sourceFiles(join(SRC, dir)));
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      databaseImports(file, readFileSync(file, 'utf8')).map(
        (specifier) => `${relative(ROOT, file)} -> ${specifier}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
