import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { isWorkspaceRole } from '../../lib/auth/permissions';

const ROLE_PATHS = new Set(['/organization/invite-member', '/organization/update-member-role']);

/**
 * Melos assigns exactly one role per member (P-30), but Better Auth 1.7.4 accepts an array or a
 * comma-separated role on these paths and stores it joined with commas. This hook refuses such a
 * role before the handler runs, for HTTP and `auth.api` calls alike. The organization hooks cannot:
 * `beforeUpdateMemberRole` sees the role already split, trimmed and joined, and an invitation
 * resend extends the pending invitation and returns before `beforeCreateInvitation` runs.
 */
export const singleRolePlugin = {
  id: 'melos-single-role',
  hooks: {
    before: [
      {
        matcher: (ctx) => ROLE_PATHS.has(ctx.path ?? ''),
        handler: createAuthMiddleware(async (ctx) => {
          if (isWorkspaceRole(ctx.body?.role)) return;
          throw APIError.from('BAD_REQUEST', {
            code: 'INVALID_ROLE',
            message: 'Choose exactly one role: owner, admin, member or viewer.',
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
