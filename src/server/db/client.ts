import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getServerEnv } from '../env';
import { ensureLocalDatabaseDir } from './local-database';
import * as schema from './schema/auth';

const { controlDatabase } = getServerEnv();
ensureLocalDatabaseDir(controlDatabase.url);

/** The control-plane database: Better Auth users, sessions and workspaces. */
export const controlDatabaseClient = createClient({
  url: controlDatabase.url,
  authToken: controlDatabase.authToken,
});

export const controlDb = drizzle(controlDatabaseClient, { schema });
