// Applies the Drizzle migrations (Better Auth tables) to AUTH_DATABASE_URL.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

const url = process.env.AUTH_DATABASE_URL ?? "file:./data/auth.db";
if (url.startsWith("file:")) {
  mkdirSync(dirname(url.slice("file:".length)), { recursive: true });
}
const client = createClient({ url });
await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
client.close();
console.log(`migrated ${url}`);
