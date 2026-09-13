import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { posix } from 'node:path';
import type { WorkspaceHostSetting } from '../env';
import { createTokenCipher } from './token-cipher';

const TURSO_API_URL = 'https://api.turso.tech';
const TOKEN_QUERY = '?expiration=never&authorization=full-access';
/** `melos-ws-<ulid>`: the workspace id without `ws_` (§4.1). */
const DATABASE_NAME = /^melos-ws-[0-9A-HJKMNP-TV-Z]{26}$/i;

/** A created workspace database. `tokenCiphertext` is NULL for local files (§4.1, P-08). */
export type WorkspaceDatabase = { url: string; tokenCiphertext: string | null };

/** Creates and deletes workspace databases (TEN-001, ADR-031). Both calls are idempotent. */
export interface WorkspaceHost {
  readonly kind: WorkspaceHostSetting['kind'];
  create(databaseName: string): Promise<WorkspaceDatabase>;
  delete(databaseName: string): Promise<void>;
}

/**
 * Thrown by `create` and `delete` on Vercel while Turso variables are unset, so a deploy without
 * them still starts (ADR-031). Names the missing variables, never values.
 */
export class WorkspaceHostConfigError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Workspace host is not configured: set ${missing.join(', ')}`);
    this.name = 'WorkspaceHostConfigError';
  }
}

/** A failed Platform API call (status 0: no response). Holds no Turso error text, token or header. */
export class TursoApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: 'conflict' | 'not_found' | 'http_error' | 'unreachable' | 'bad_response',
  ) {
    super(`Turso API ${operation} failed: ${code} (HTTP ${status})`);
    this.name = 'TursoApiError';
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type TursoSetting = Extract<WorkspaceHostSetting, { kind: 'turso' }>;
type Payload = { database?: { Hostname?: unknown }; jwt?: unknown } | null;

function checkName(databaseName: string): string {
  if (!DATABASE_NAME.test(databaseName)) throw new Error('Invalid workspace database name');
  return databaseName;
}

/** Development and tests: a libSQL file `<dataDir>/melos-ws-<ulid>.db` with no token (§7.2). */
function localWorkspaceHost(dataDir: string): WorkspaceHost {
  const path = (databaseName: string) => posix.join(dataDir, `${checkName(databaseName)}.db`);
  return {
    kind: 'local',
    async create(databaseName) {
      const file = path(databaseName);
      mkdirSync(dataDir, { recursive: true });
      // An empty file is an empty database. On Windows a libSQL client would lock it until GC.
      closeSync(openSync(file, 'a'));
      return { url: `file:${file}`, tokenCiphertext: null };
    },
    async delete(databaseName) {
      const file = path(databaseName);
      for (const suffix of ['', '-shm', '-wal']) rmSync(`${file}${suffix}`, { force: true });
    },
  };
}

/** Deployed environments: one Turso Cloud database and one full-access token per workspace. */
function tursoWorkspaceHost(setting: TursoSetting, fetchApi: Fetch): WorkspaceHost {
  const cipher = createTokenCipher(setting.tokenKey);
  const organization = encodeURIComponent(setting.organization);
  const databases = `${TURSO_API_URL}/v1/organizations/${organization}/databases`;
  const bearer = `Bearer ${setting.apiToken}`;
  const headers = { authorization: bearer, 'content-type': 'application/json' };
  // Turso names allow only lowercase letters, numbers and dashes; ULIDs are case-insensitive.
  const tursoName = (databaseName: string) => checkName(databaseName).toLowerCase();

  async function call(operation: string, method: string, path: string, body?: object) {
    const init = { method, headers, body: body && JSON.stringify(body) };
    const response = await fetchApi(`${databases}${path}`, init).catch(() => {
      throw new TursoApiError(operation, 0, 'unreachable');
    });
    const { ok, status } = response;
    const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'http_error';
    if (!ok) throw new TursoApiError(operation, status, code);
    return (await response.json().catch(() => null)) as Payload;
  }

  function read(operation: string, value: unknown): string {
    if (typeof value === 'string') return value;
    throw new TursoApiError(operation, 200, 'bad_response');
  }

  return {
    kind: 'turso',
    async create(databaseName) {
      const name = tursoName(databaseName);
      // A retried provisioning finds the database its earlier attempt created (§7.2, P-23).
      const created = await call('create database', 'POST', '', {
        name,
        group: setting.group,
      }).catch((error: unknown) => {
        if (!(error instanceof TursoApiError && error.code === 'conflict')) throw error;
        return call('retrieve database', 'GET', `/${name}`);
      });
      const hostname = read('create database', created?.database?.Hostname);
      const token = await call('create token', 'POST', `/${name}/auth/tokens${TOKEN_QUERY}`);
      const jwt = read('create token', token?.jwt);
      return { url: `libsql://${hostname}`, tokenCiphertext: cipher.encrypt(jwt, databaseName) };
    },
    async delete(databaseName) {
      const deleted = call('delete database', 'DELETE', `/${tursoName(databaseName)}`);
      await deleted.catch((error: unknown) => {
        if (!(error instanceof TursoApiError && error.code === 'not_found')) throw error;
      });
    },
  };
}

/** The host for `getServerEnv().workspaceHost`. Tests inject `fetchApi` to stub the Platform API. */
export function createWorkspaceHost(setting: WorkspaceHostSetting, fetchApi: Fetch = fetch) {
  if (setting.kind === 'local') return localWorkspaceHost(setting.dataDir);
  if (setting.kind === 'turso') return tursoWorkspaceHost(setting, fetchApi);
  const refuse = () => Promise.reject(new WorkspaceHostConfigError(setting.missing));
  return { kind: setting.kind, create: refuse, delete: refuse } satisfies WorkspaceHost;
}
