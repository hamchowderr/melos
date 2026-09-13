import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { ac, roles } from '../../lib/auth/permissions';
import { controlDb } from '../db/client';
import * as schema from '../db/schema/auth';
import { getServerEnv } from '../env';
import { sendAuthEmail } from './mailer';
import { membershipAuditAfterHook, membershipAuditHooks } from './membership-audit';

const env = getServerEnv();

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
    sendOnSignUp: true,
    sendVerificationEmail: ({ user, url }) =>
      sendAuthEmail({
        kind: 'verify-email',
        to: user.email,
        subject: 'Verify your Melos email address',
        text: `Open this link to verify your email address:\n\n${url}\n`,
        link: url,
      }),
  },
  // Invitations, role changes and removals are audited (AUTH-005, ADR-029).
  hooks: { after: membershipAuditAfterHook },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: 'owner',
      organizationHooks: membershipAuditHooks,
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
  ],
});

export type Session = typeof auth.$Infer.Session;
