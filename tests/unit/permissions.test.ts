import { describe, expect, it } from 'vitest';
import { admin, member, owner, roles, viewer } from '../../src/lib/auth/permissions';

describe('workspace roles', () => {
  it('defines owner, admin, member and the custom viewer role', () => {
    expect(Object.keys(roles).sort()).toEqual(['admin', 'member', 'owner', 'viewer']);
  });

  it('lets only the owner delete the workspace', () => {
    expect(owner.authorize({ organization: ['delete'] }).success).toBe(true);
    expect(admin.authorize({ organization: ['delete'] }).success).toBe(false);
    expect(admin.authorize({ member: ['create', 'delete'] }).success).toBe(true);
    expect(member.authorize({ member: ['create'] }).success).toBe(false);
  });

  it('grades workspace data access by role', () => {
    expect(admin.authorize({ workspaceData: ['delete'] }).success).toBe(true);
    expect(member.authorize({ workspaceData: ['read', 'create', 'update'] }).success).toBe(true);
    expect(member.authorize({ workspaceData: ['delete'] }).success).toBe(false);
  });

  it('keeps the viewer read-only', () => {
    expect(viewer.authorize({ workspaceData: ['read'] }).success).toBe(true);
    expect(viewer.authorize({ workspaceData: ['create'] }).success).toBe(false);
    expect(viewer.authorize({ invitation: ['create'] }).success).toBe(false);
  });
});
