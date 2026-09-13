import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';
import { describe, expect, it } from 'vitest';
import { admin, member, owner, roles, statement, viewer } from '../../src/lib/auth/permissions';
import { requirePermission } from '../../src/server/services/permissions';

type Statements = Record<string, readonly string[]>;

describe('workspace roles (§6.2)', () => {
  it('defines owner, admin, member and the custom viewer role', () => {
    expect(Object.keys(roles).sort()).toEqual(['admin', 'member', 'owner', 'viewer']);
  });

  it('merges Better Auth default statements and default role permissions', () => {
    expect(statement).toMatchObject(defaultStatements);
    const pairs = [
      [owner, ownerAc],
      [admin, adminAc],
      [member, memberAc],
    ] as const;
    for (const [role, defaults] of pairs) {
      expect(role.statements as Statements).toMatchObject(defaults.statements as Statements);
    }
  });

  it('gives the viewer only its five read permissions', () => {
    expect(viewer.statements).toEqual({
      catalog: ['read'],
      rights: ['read'],
      contact: ['read'],
      pitch: ['read'],
      report: ['read'],
    });
  });
});

describe('requirePermission', () => {
  it('fails closed on an unknown, multi-role or inherited role name', () => {
    for (const workspaceRole of ['', 'guest', 'member,viewer', 'constructor', '__proto__']) {
      expect(requirePermission({ workspaceRole }, { catalog: ['read'] }).ok, workspaceRole).toBe(
        false,
      );
    }
  });

  it('refuses a request that names no action', () => {
    expect(requirePermission({ workspaceRole: 'owner' }, {}).ok).toBe(false);
    expect(requirePermission({ workspaceRole: 'owner' }, { catalog: [] }).ok).toBe(false);
  });

  it('needs every requested action', () => {
    const permissions = { catalog: ['read', 'delete'] as ('read' | 'delete')[] };
    expect(requirePermission({ workspaceRole: 'admin' }, permissions)).toEqual({ ok: true });
    expect(requirePermission({ workspaceRole: 'member' }, permissions)).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: expect.any(String) },
    });
  });
});
