import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

/** libSQL cannot create a file DB inside a missing directory. */
export function ensureFileDir(url: string): void {
  if (url.startsWith("file:")) {
    mkdirSync(dirname(url.slice("file:".length)), { recursive: true });
  }
}

export const authDatabaseUrl =
  process.env.AUTH_DATABASE_URL ?? "file:./data/auth.db";
ensureFileDir(authDatabaseUrl);

export const authClient = createClient({ url: authDatabaseUrl });
export const db = drizzle(authClient);
