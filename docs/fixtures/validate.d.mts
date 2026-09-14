// Types for the validate.mjs exports that TypeScript imports (npm run db:validate-demo, tests).
import type { Client } from '@libsql/client';

/** A failed check: its group and name, with the expected and actual values as text. */
export type Failure = { group: string; label: string; expected: string; actual: string };

/** docs/fixtures/northstar-demo.json, as far as TypeScript callers read it. */
export declare const fixture: {
  demo: { date: string; timezone: string; user: string; organization: string; workspace: string };
  keys: Record<string, string>;
};

/** Runs every validate.mjs check against the clients of a seeded Northstar workspace. */
export declare function validateSeeded(
  control: Client,
  workspace: Client,
): Promise<{ assertions: number; failures: Failure[] }>;
