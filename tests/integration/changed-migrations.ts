import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs `generate` on a temp copy of the migrations folder `source` that `change` edits first. */
export async function generateFromChangedCopy(
  source: string,
  change: (folder: string) => void,
  generate: (folder: string) => Promise<string>,
): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), 'melos-migrations-'));
  try {
    cpSync(source, folder, { recursive: true });
    change(folder);
    return await generate(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Replaces the first match of `from` in one migration file of the copy, failing if none. */
export const replaceIn = (file: string, from: string | RegExp, to: string) => (folder: string) => {
  const path = join(folder, file);
  const text = readFileSync(path, 'utf8');
  if (!text.match(from)) throw new Error(`${file} does not contain ${from}`);
  writeFileSync(path, text.replace(from, to));
};

/** Workspace migration 0006 for the drift tests: a new pitches column with a foreign key. */
export const addPitchOwner = (folder: string) =>
  writeFileSync(
    join(folder, '0006_pitch_owner.sql'),
    'ALTER TABLE pitches ADD COLUMN owner_party_id TEXT REFERENCES parties(id) ON DELETE SET NULL',
  );
