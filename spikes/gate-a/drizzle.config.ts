import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "turso",
  schema: "./src/lib/auth-schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.AUTH_DATABASE_URL ?? "file:./data/auth.db" },
});
