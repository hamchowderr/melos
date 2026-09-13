import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';

/**
 * Workspace permissions. `workspaceData` is a placeholder for the workspace's domain records;
 * the real resources (catalog, rights, CRM) replace it once docs/CONTRACT.md is revised.
 */
export const statements = {
  ...defaultStatements,
  workspaceData: ['read', 'create', 'update', 'delete'],
} as const;

export const ac = createAccessControl(statements);

export const owner = ac.newRole({
  ...ownerAc.statements,
  workspaceData: ['read', 'create', 'update', 'delete'],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  workspaceData: ['read', 'create', 'update', 'delete'],
});

export const member = ac.newRole({
  ...memberAc.statements,
  workspaceData: ['read', 'create', 'update'],
});

/** Read-only: sees workspace data, changes nothing. */
export const viewer = ac.newRole({
  ...memberAc.statements,
  workspaceData: ['read'],
});

export const roles = { owner, admin, member, viewer };

export type WorkspaceRole = keyof typeof roles;
