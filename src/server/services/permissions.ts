import type { Role } from 'better-auth/plugins/access';
import { roles, type WorkspacePermissions } from '../../lib/auth/permissions';

export type ForbiddenError = { code: 'FORBIDDEN'; message: string };

export type PermissionCheck = { ok: true } | { ok: false; error: ForbiddenError };

/** The role resolved server-side for this request from the member row (§7.1), never the client. */
export type PermissionSubject = { workspaceRole: string };

const FORBIDDEN: PermissionCheck = {
  ok: false,
  error: { code: 'FORBIDDEN', message: 'Your workspace role does not allow this action.' },
};

/**
 * The service-boundary authorization check (AUTH-004, docs/CONTRACT.md §6.2). It evaluates the
 * same role objects Better Auth is configured with, in Melos code, and needs no request headers,
 * so services, Mastra tools and the importer share it. Fails closed: an unknown or
 * comma-separated role is forbidden, and `authorize` refuses a request that names no action.
 */
export function requirePermission(
  subject: PermissionSubject,
  permissions: WorkspacePermissions,
): PermissionCheck {
  const role: Role | undefined = Object.hasOwn(roles, subject.workspaceRole)
    ? roles[subject.workspaceRole as keyof typeof roles]
    : undefined;
  if (!role) return FORBIDDEN;
  return role.authorize(permissions).success ? { ok: true } : FORBIDDEN;
}
