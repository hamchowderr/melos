import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import * as schema from "./auth-schema";
import { db } from "./db";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3100",
  // Local spike placeholder, not a credential. Real deployments inject BETTER_AUTH_SECRET.
  secret:
    process.env.BETTER_AUTH_SECRET ??
    "gate-a-spike-local-placeholder-not-a-real-secret",
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: { enabled: true },
  plugins: [
    // Explicit, per GHSA-fmh4-wcc4-5jm3 (the default flips with ID generation).
    organization({ requireEmailVerificationOnInvitation: true }),
  ],
});

export type Session = typeof auth.$Infer.Session;
