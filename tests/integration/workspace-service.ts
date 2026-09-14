import { rmSync } from 'node:fs';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { ulid } from 'ulid';
import { vi } from 'vitest';
import type { WorkspaceRole } from '../../src/lib/auth/permissions';
import { organization } from '../../src/server/db/schema/auth';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { openWithoutForeignKeys } from './support';

type Connections = typeof import('../../src/server/services/workspace-connections');

/**
 * Setup for workspace service tests, called in beforeAll before any service is imported: an
 * in-memory melos-control with foreign keys off, workspace files under `data/test-<name>`, and a
 * recorded getWorkspaceDatabase, so a test can show a refused call never opens the database.
 */
export async function prepareWorkspaceServices(name: string) {
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
    /** Closes each provisioned workspace's client, then melos-control. */
    async close() {
      for (const workspaceId of workspaceIds) await connections.closeWorkspaceDatabase(workspaceId);
      control.$client.close();
    },
  };
}

/** The tenant with another role, including one TenantContextResolver refuses (P-30). */
export const withRole = (tenant: TenantContext, role: string): TenantContext => ({
  ...tenant,
  workspaceRole: role as WorkspaceRole,
});
