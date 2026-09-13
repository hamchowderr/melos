import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { ac, roles } from '../../lib/auth/permissions';
import { controlDb } from '../db/client';
import * as schema from '../db/schema/auth';
import { getServerEnv } from '../env';

const env = getServerEnv();

export const auth = betterAuth({
  appName: 'Melos',
  baseURL: env.auth.baseURL,
  secret: env.auth.secret,
  trustedOrigins: env.auth.trustedOrigins,
  database: drizzleAdapter(controlDb, { provider: 'sqlite', schema }),
  // Sign-up does not open a session; the user signs in explicitly.
  emailAndPassword: { enabled: true, autoSignIn: false },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: 'owner',
      // Explicit, per GHSA-fmh4-wcc4-5jm3: the implicit default flips with ID generation.
      requireEmailVerificationOnInvitation: true,
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
