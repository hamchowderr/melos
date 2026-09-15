import { rmSync } from 'node:fs';
import { migrate } from 'drizzle-orm/libsql/migrator';
import Database from 'libsql';
import { ulid } from 'ulid';
import { vi } from 'vitest';
import type { WorkspaceRole } from '../../src/lib/auth/permissions';
import { organization } from '../../src/server/db/schema/auth';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { openWithoutForeignKeys } from './support';

type Connections = typeof import('../../src/server/services/workspace-connections');

/**
 * DAT-INT-001 (§4.4): turns foreign keys off before every statement a libSQL connection prepares
 * outside a transaction, so IntegrityGuard, not SQLite, keeps each workspace consistent. It patches
 * `prepare` because one PRAGMA reaches only one connection: @libsql/client hands its connection to
 * a transaction and opens a new one for other calls, `migrate()` turns enforcement back on, and
 * `PRAGMA foreign_keys` is a no-op inside a transaction. It relies on `libsql` 0.5.29, the
 * transitive package @libsql/client 0.18.0 opens connections with. Returns the undo.
 */
function withoutForeignKeys(): () => void {
  const { prototype } = Database;
  const { prepare } = prototype;
  prototype.prepare = function (this: Database.Database, source: string) {
    if (this.open && !this.inTransaction) this.exec('PRAGMA foreign_keys = OFF');
    return prepare.call(this, source);
  } as typeof prepare;
  return () => {
    prototype.prepare = prepare;
  };
}

/**
 * Setup for workspace service tests, called in beforeAll before any service is imported: every
 * libSQL connection with foreign keys off, an in-memory melos-control, workspace files under
 * `data/test-<name>`, and a recorded getWorkspaceDatabase, so a test can show a refused call never
 * opens the database.
 */
export async function prepareWorkspaceServices(name: string) {
  const restore = withoutForeignKeys();
  rmSync(`data/test-${name}`, { recursive: true, force: true });
  process.env.MELOS_WORKSPACE_DATA_DIR = `data/test-${name}/workspaces`;
  const migrationsFolder = './src/server/db/migrations/control';
  const control = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder }));
  const client = { controlDb: control, controlDatabaseClient: control.$client };
  vi.doMock('../../src/server/db/client', () => client);
  const getWorkspaceDatabase = vi.fn<Connections['getWorkspaceDatabase']>();
  vi.doMock('../../src/server/services/workspace-connections', async (importOriginal) => {
    const original = await importOriginal<Connections>();
    getWorkspaceDatabase.mockImplementation(original.getWorkspaceDatabase);
    return { ...original, getWorkspaceDatabase };
  });
  const connections = await import('../../src/server/services/workspace-connections');
  const { provisionWorkspace } = await import('../../src/server/services/workspace-provisioner');
  const workspaceIds: string[] = [];
  return {
    connections,
    getWorkspaceDatabase,
    /** A new organization with a provisioned, empty workspace, and a tenant in it with `role`. */
    async provision(workspaceRole: WorkspaceRole): Promise<TenantContext> {
      const organizationId = `organization_${ulid()}`;
      const slug = organizationId.toLowerCase();
      await control
        .insert(organization)
        .values({ id: organizationId, name, slug, createdAt: new Date() });
      const { id: workspaceId, status } = await provisionWorkspace(organizationId);
      if (status !== 'active') throw new Error(`Workspace ${workspaceId} is ${status}`);
      workspaceIds.push(workspaceId);
      const ids = { userId: `usr_${ulid()}`, requestId: crypto.randomUUID() };
      return { ...ids, organizationId, workspaceId, workspaceRole };
    },
    /** Closes each provisioned workspace's client, then melos-control, and restores libSQL. */
    async close() {
      for (const workspaceId of workspaceIds) await connections.closeWorkspaceDatabase(workspaceId);
      control.$client.close();
      restore();
    },
  };
}

/** The tenant with another role, including one TenantContextResolver refuses (P-30). */
export const withRole = (tenant: TenantContext, role: string): TenantContext => ({
  ...tenant,
  workspaceRole: role as WorkspaceRole,
});
