import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOCAL_CONTROL_DATABASE_URL = 'file:./data/control.db';
export const LOCAL_AGENT_DATABASE_URL = 'file:./data/agent.db';

/**
 * libSQL cannot create a file database inside a missing directory. Only `file:` URLs are
 * touched, and the env schema rejects those on Vercel, so nothing here writes there.
 */
export function ensureLocalDatabaseDir(url: string): void {
  if (url.startsWith('file:')) {
    mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  }
}
