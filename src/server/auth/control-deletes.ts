import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { eq } from 'drizzle-orm';
import { controlDb } from '../db/client';
import { organization, session, user } from '../db/schema/auth';
import {
  type GuardTransaction,
  controlIntegrityGuard as guard,
  IntegrityError,
} from '../services/integrity-guard';
import {
  deleteWorkspaceDatabase,
  removeWorkspace,
  WorkspaceDeleteError,
} from '../services/workspace-provisioner';

/** One melos-control transaction; an IntegrityGuard refusal rolls it back and answers 409. */
async function inControlTransaction(work: (tx: GuardTransaction) => Promise<void>): Promise<void> {
  try {
    await controlDb.transaction((tx) => work(tx));
  } catch (error) {
    if (!(error instanceof IntegrityError)) throw error;
    throw APIError.from('CONFLICT', { code: error.code, message: error.message });
  }
}

/**
 * Better Auth 1.7.4 deletes an organization's members, invitations and row outside any transaction,
 * after this hook, and never deletes Melos rows. The hook deletes the workspace database first, then
 * all of those rows through IntegrityGuard in one transaction, so the adapter's deletes match
 * nothing and no crash leaves an orphan (ADR-030, §7.2).
 */
export const controlDeleteHooks = {
  beforeDeleteOrganization: async ({ organization: { id }, user: actor }) => {
    // Committed before the transaction: after a failure or crash the organization keeps a deleting
    // registry row, and deleting the organization again resumes.
    const workspace = await deleteWorkspaceDatabase(id).catch((error: unknown) => {
      // Ids, the step and the error code only: a message or status_detail may hold a token.
      const { step, code } =
        error instanceof WorkspaceDeleteError ? error : { step: 'unknown', code: 'unknown' };
      console.error(`Workspace delete failed for organization ${id} at ${step}: ${code}`);
      throw APIError.from('SERVICE_UNAVAILABLE', {
        code: 'WORKSPACE_DELETE_FAILED',
        message: 'The workspace database could not be deleted. Try again.',
      });
    });
    await inControlTransaction(async (tx) => {
      if (workspace) await removeWorkspace(tx, workspace, actor.id);
      await guard.delete(tx, organization, eq(organization.id, id));
      // Better Auth clears only the caller's active organization.
      const active = eq(session.activeOrganizationId, id);
      await guard.update(tx, session, { activeOrganizationId: null }, active);
    });
  },
} satisfies NonNullable<OrganizationOptions['organizationHooks']>;

/**
 * Every path through `internalAdapter.deleteUser` deletes the user's sessions and accounts, then runs
 * `databaseHooks.user.delete.before`, then deletes the user. The hook deletes the user through
 * IntegrityGuard, so the rows the adapter never deletes (memberships, sent invitations, settings)
 * go in the same transaction and the adapter's user delete matches nothing (ADR-030).
 */
export const controlDeletesPlugin = {
  id: 'melos-control-deletes',
  init: () => ({
    options: {
      databaseHooks: {
        user: {
          delete: {
            before: ({ id }) =>
              inControlTransaction((tx) => guard.delete(tx, user, eq(user.id, id))),
          },
        },
      },
    },
  }),
} satisfies BetterAuthPlugin;
