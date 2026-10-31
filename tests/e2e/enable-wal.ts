import { createClient } from '@libsql/client';

/**
 * Puts the e2e control database in WAL mode before the server opens it (melos-af5). In the default
 * rollback journal, a spec's write waits for the server's readers while new server reads fail with
 * SQLITE_BUSY, and @libsql/client can keep a lock after a refused write (melos-lb3). In WAL, readers
 * never block the writer. The mode is stored in the file, so every later connection uses it.
 */
const client = createClient({ url: 'file:./data/e2e-control.db' });
try {
  await client.execute('PRAGMA journal_mode = WAL');
} finally {
  client.close();
}
