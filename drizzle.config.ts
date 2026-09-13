import { defineConfig } from 'drizzle-kit';
import { ensureLocalDatabaseDir, LOCAL_CONTROL_DATABASE_URL } from './src/server/db/local-database';

// Control-plane database only. Mastra creates its own tables in MELOS_AGENT_DATABASE_URL.
const url = process.env.MELOS_CONTROL_DATABASE_URL || LOCAL_CONTROL_DATABASE_URL;
ensureLocalDatabaseDir(url);

export default defineConfig({
  dialect: 'turso',
  schema: './src/server/db/schema/auth.ts',
  out: './src/server/db/migrations/control',
  dbCredentials: {
    url,
    authToken: process.env.MELOS_CONTROL_DATABASE_AUTH_TOKEN || undefined,
  },
});
