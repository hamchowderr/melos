import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { type OrganizationOptions, organization } from 'better-auth/plugins/organization';
import { ac, roles } from '../../lib/auth/permissions';
import { controlDb } from '../db/client';
import * as schema from '../db/schema/auth';
import { getServerEnv } from '../env';
import { provisionWorkspace } from '../services/workspace-provisioner';
import { controlDeleteHooks, controlDeletesPlugin } from './control-deletes';
import { sendAuthEmail } from './mailer';
import { membershipAuditAfterHook, membershipAuditHooks } from './membership-audit';
import { singleRolePlugin } from './single-role';

const env = getServerEnv();
const mailerDisabled = env.authMailer === 'disabled';

/**
 * With MELOS_AUTH_MAILER=disabled, invite-member is refused before its handler runs. Better Auth
 * 1.7.4 writes the invitation row (or extends a pending one on resend) before sendInvitationEmail,
 * and only logs that callback's errors, so a refusal there would not fail the request.
 */
const refuseInvitesWithoutMailer = createAuthMiddleware(async (ctx) => {
  if (!mailerDisabled || ctx.path !== '/organization/invite-member') return;
  throw APIError.from('FORBIDDEN', {
    code: 'INVITATIONS_UNAVAILABLE',
    message: 'Invitations are unavailable until email sending is set up.',
  });
});

/** Never fails organization creation: a failed registry row keeps its step for a retry (P-23). */
const provisioningHooks = {
  afterCreateOrganization: async ({ organization: { id }, user }) => {
    await provisionWorkspace(id, user.id).catch(() => {
      console.error(`Workspace provisioning failed for organization ${id}`);
    });
  },
} satisfies NonNullable<OrganizationOptions['organizationHooks']>;

export const auth = betterAuth({
  appName: 'Melos',
  baseURL: env.auth.baseURL,
  secret: env.auth.secret,
  trustedOrigins: env.auth.trustedOrigins,
  database: drizzleAdapter(controlDb, { provider: 'sqlite', schema }),
  // Sign-up does not open a session; the user signs in explicitly.
  emailAndPassword: { enabled: true, autoSignIn: false },
  // Sign-in never requires a verified address; answering an invitation does (below).
  emailVerification: {
    sendOnSignUp: !mailerDisabled,
    sendVerificationEmail: ({ user, url }) =>
      sendAuthEmail({
        kind: 'verify-email',
        to: user.email,
        subject: 'Verify your Melos email address',
        text: `Open this link to verify your email address:\n\n${url}\n`,
        link: url,
      }),
  },
  databaseHooks: {
    user: {
      create: {
        // Every user-creation path runs this; signing in never does. Not a 403: sign-up turns a
        // 403 into its generic success response while autoSignIn is off. Nothing here is logged.
        before: async (user) => {
          const allowed = env.signUpAllowedEmails;
          if (allowed && !allowed.includes(user.email.toLowerCase())) {
            throw APIError.from('UNPROCESSABLE_ENTITY', {
              code: 'SIGN_UP_NOT_ALLOWED',
              message: 'Sign-up is invite-only for now.',
            });
          }
        },
      },
    },
  },
  // Invitations, role changes and removals are audited (AUTH-005, ADR-029).
  hooks: { before: refuseInvitesWithoutMailer, after: membershipAuditAfterHook },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: 'owner',
      // No key repeats: membership audit has no afterCreateOrganization, deletes one before hook.
      organizationHooks: { ...membershipAuditHooks, ...controlDeleteHooks, ...provisioningHooks },
      // Explicit, per GHSA-fmh4-wcc4-5jm3: the implicit default flips with ID generation.
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail: ({ id, email, role, organization: workspace, inviter }) => {
        const link = new URL(`/invitations/${id}`, env.auth.baseURL).href;
        return sendAuthEmail({
          kind: 'invitation',
          to: email,
          subject: `Join ${workspace.name} on Melos`,
          text: `${inviter.user.name} invited you to join ${workspace.name} as ${role}.\n\nOpen this link to accept or decline:\n\n${link}\n`,
          link,
        });
      },
    }),
    // Organization and user deletes go through IntegrityGuard first (DAT-001, ADR-030).
    controlDeletesPlugin,
    // A member role or invitation names exactly one role (P-30).
    singleRolePlugin,
  ],
});

export type Session = typeof auth.$Infer.Session;
