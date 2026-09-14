import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';

/**
 * Workspace roles and permissions, copied from docs/CONTRACT.md §6.2. Client-safe: imports only
 * Better Auth's access-control modules, so the auth client and server services share it.
 */
export const statement = {
  ...defaultStatements,
  catalog: ['read', 'create', 'update', 'delete'],
  rights: ['read', 'update'],
  contact: ['read', 'create', 'update', 'delete'],
  pitch: ['read', 'create', 'update'],
  outreach: ['draft', 'send'],
  report: ['read', 'generate'],
  import: ['run'],
} as const;

export const ac = createAccessControl(statement);

export const owner = ac.newRole({
  ...ownerAc.statements,
  catalog: ['read', 'create', 'update', 'delete'],
  rights: ['read', 'update'],
  contact: ['read', 'create', 'update', 'delete'],
  pitch: ['read', 'create', 'update'],
  outreach: ['draft', 'send'],
  report: ['read', 'generate'],
  import: ['run'],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  catalog: ['read', 'create', 'update', 'delete'],
  rights: ['read', 'update'],
  contact: ['read', 'create', 'update', 'delete'],
  pitch: ['read', 'create', 'update'],
  outreach: ['draft', 'send'],
  report: ['read', 'generate'],
  import: ['run'],
});

export const member = ac.newRole({
  ...memberAc.statements,
  catalog: ['read', 'create', 'update'],
  rights: ['read', 'update'],
  contact: ['read', 'create', 'update'],
  pitch: ['read', 'create', 'update'],
  outreach: ['draft', 'send'],
  report: ['read', 'generate'],
});

/** Read-only, with no Better Auth default statements (§6.2). */
export const viewer = ac.newRole({
  catalog: ['read'],
  rights: ['read'],
  contact: ['read'],
  pitch: ['read'],
  report: ['read'],
});

export const roles = { owner, admin, member, viewer };

export type WorkspaceRole = keyof typeof roles;

/** True only for one of the four role names; a comma-separated or inherited name is not a role. */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && Object.hasOwn(roles, value);
}

/**
 * One Melos role, never several: Better Auth joins several roles with commas, and Melos assigns
 * one role per member (P-30). isWorkspaceRole refuses a joined name too; the comma test says why.
 */
export function isSingleWorkspaceRole(role: string): role is WorkspaceRole {
  return !role.includes(',') && isWorkspaceRole(role);
}

/** A permission request: resource to the actions it needs, e.g. `{ catalog: ['update'] }`. */
export type WorkspacePermissions = {
  [Resource in keyof typeof statement]?: (typeof statement)[Resource][number][];
};
