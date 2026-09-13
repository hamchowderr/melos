import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { eq } from 'drizzle-orm';
import { controlDb } from '../db/client';
import { organization, session, user } from '../db/schema/auth';
import { workspaceRegistry } from '../db/schema/control';
import {
  type GuardTransaction,
  controlIntegrityGuard as guard,
  IntegrityError,
} from '../services/integrity-guard';

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
 * after this hook, and never deletes Melos rows. The hook deletes all of them through IntegrityGuard
 * in one transaction, so the adapter's deletes match nothing and no crash leaves an orphan (ADR-030).
 */
export const controlDeleteHooks = {
  beforeDeleteOrganization: ({ organization: { id } }) =>
    inControlTransaction(async (tx) => {
      // Phase 1 provisions no workspace database; phase 2 deletes it before this row.
      await guard.delete(tx, workspaceRegistry, eq(workspaceRegistry.organizationId, id));
      await guard.delete(tx, organization, eq(organization.id, id));
      // Better Auth clears only the caller's active organization.
      const active = eq(session.activeOrganizationId, id);
      await guard.update(tx, session, { activeOrganizationId: null }, active);
    }),
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
