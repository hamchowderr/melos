import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');
const APP = join(SRC, 'app');
const MASTRA = join(SRC, 'mastra');

const SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** Resolves project-local specifiers ('@/...' or relative) to a path; packages return null. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return join(SRC, specifier.slice(2));
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier);
  return null;
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/** Import specifiers in `source` that land inside src/app. */
function appImports(fromFile: string, source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match.slice(1).find(Boolean);
    const target = specifier ? resolveLocal(fromFile, specifier) : null;
    if (specifier && target && isInside(target, APP)) hits.push(specifier);
  }
  return hits;
}

describe('src/mastra import boundary', () => {
  it('detects imports into src/app in every syntax it guards', () => {
    const file = join(MASTRA, 'tools', 'example.ts');
    const probe = [
      "import { x } from '@/app/page';",
      "import type { Y } from '../../app/api/auth/[...all]/route';",
      "export * from '@/app';",
      "const z = await import('../../app/layout');",
      "import '@/components/chat/ping-card';",
      "import { Agent } from '@mastra/core/agent';",
      "import { apply } from './app-helpers';",
    ].join('\n');
    expect(appImports(file, probe)).toEqual([
      '@/app/page',
      '../../app/api/auth/[...all]/route',
      '@/app',
      '../../app/layout',
    ]);
  });

  it('src/mastra never imports from src/app', () => {
    const files = sourceFiles(MASTRA);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      appImports(file, readFileSync(file, 'utf8')).map(
        (specifier) => `${relative(ROOT, file)} -> ${specifier}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
