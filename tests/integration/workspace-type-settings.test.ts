import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organization } from '../../src/server/db/schema/auth';
import { controlAuditLog } from '../../src/server/db/schema/control';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let types: typeof import('../../src/server/services/onboarding/workspace-type');
let controlDb: typeof import('../../src/server/db/client').controlDb;
let owner: TenantContext;

const auditRows = () =>
  controlDb
    .select()
    .from(controlAuditLog)
    .where(
      and(
        eq(controlAuditLog.organizationId, owner.organizationId),
        eq(controlAuditLog.action, 'workspace.type_changed'),
      ),
    );

beforeAll(async () => {
  services = await prepareWorkspaceServices('workspace-type-settings');
  types = await import('../../src/server/services/onboarding/workspace-type');
  ({ controlDb } = await import('../../src/server/db/client'));
  owner = await services.provision('owner');
});

afterAll(async () => {
  await services?.close();
});

describe('ONB-INT-002: setWorkspaceType', () => {
  it('reads a workspace with no type as songwriter', async () => {
    expect(await types.getWorkspaceType(owner)).toBe('songwriter');
  });

  it('lets an owner set the type and audits the change', async () => {
    expect(await types.setWorkspaceType(owner, 'manager')).toEqual({
      ok: true,
      value: { workspaceType: 'manager' },
    });
    expect(await types.getWorkspaceType(owner)).toBe('manager');
    const [row] = await auditRows();
    expect(row).toMatchObject({
      actorUserId: owner.userId,
      targetType: 'organization',
      targetId: owner.organizationId,
      beforeJson: JSON.stringify({ workspaceType: null }),
      afterJson: JSON.stringify({ workspaceType: 'manager' }),
    });
  });

  it('lets an admin change it, and writes nothing when the type is unchanged', async () => {
    const admin = withRole(owner, 'admin');
    expect((await types.setWorkspaceType(admin, 'label')).ok).toBe(true);
    expect((await types.setWorkspaceType(admin, 'label')).ok).toBe(true);
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.afterJson)).toContain(JSON.stringify({ workspaceType: 'label' }));
  });

  it.each(['member', 'viewer'] as const)('refuses a %s and keeps the type', async (role) => {
    const result = await types.setWorkspaceType(withRole(owner, role), 'producer');
    expect(result).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await types.getWorkspaceType(owner)).toBe('label');
  });

  it('refuses an unknown type', async () => {
    const result = await types.setWorkspaceType(owner, 'dj');
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'workspaceType' },
    });
    const [stored] = await controlDb
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, owner.organizationId));
    expect(stored.metadata).toBe(JSON.stringify({ workspaceType: 'label' }));
  });
});
