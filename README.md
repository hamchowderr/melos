# Melos

Music catalog, rights and splits, and a pitching CRM, with an agent-native chat UI.

This is the application foundation: one Next.js app with Better Auth workspaces, an embedded
Mastra agent, and a CopilotKit chat. Domain tables (catalog, rights, CRM) come later, from
`docs/CONTRACT.md`.

## Stack

| Layer                  | Package (exact pin)                                                             |
| ---------------------- | ------------------------------------------------------------------------------- |
| App                    | `next` 16.3.5, `react` 19.3.0                                                   |
| Auth and workspaces    | `better-auth` 1.7.4 (Organization plugin, Drizzle adapter)                      |
| Control-plane database | libSQL via `@libsql/client` 0.18.0, `drizzle-orm` 0.45.2, `drizzle-kit` 0.31.10 |
| Agent                  | `@mastra/core` 1.66.0, `@mastra/memory` 1.29.0, `@mastra/libsql` 1.22.5         |
| Chat                   | `@copilotkit/runtime` / `react-core` 1.71.1 over `@ag-ui/mastra` 1.1.3          |
| Lint and format        | `@biomejs/biome` 2.5.13                                                         |
| Tests                  | `vitest` 4.1.11, `@playwright/test` 1.63.0, `@copilotkit/aimock` 1.41.0         |

## Layout

```
src/app                  routes; /api/auth/[...all] and /api/copilotkit/[[...slug]]
src/mastra               agent, tools, request-context helper (must not import src/app)
src/server/services      authorization and transactions (TenantContextResolver placeholder)
src/server/db            control-plane client, Better Auth schema, migrations
src/server/auth          Better Auth instance
src/server/env.ts        environment validation
src/lib                  code shared with the browser (auth client, roles, agent contract)
src/components           UI
tests/unit               fast, no I/O
tests/integration        route handlers against real libSQL files and an in-process AIMock
tests/e2e                Playwright smoke test
fixtures/aimock          AIMock fixtures
```

## Local development

Requires Node 24.

```bash
npm ci
cp .env.example .env.local        # then set BETTER_AUTH_SECRET (npx auth secret prints one)
npm run db:migrate                # creates ./data/control.db
```

Pick how the chat model is served:

- **Keyless (AIMock).** In `.env.local` set `MELOS_LLM_BASE_URL=http://127.0.0.1:4010/v1`, then
  run `npm run aimock` in a second terminal. The fixtures answer the message `ping`.
- **Real model.** Set `MELOS_CHAT_MODEL` (for example `mastra/anthropic/claude-haiku-4.5`) and
  inject `MASTRA_GATEWAY_API_KEY` at runtime from your secrets manager. Never write the key to a
  file.

```bash
npm run dev                       # http://localhost:3100
```

Sign up, sign in, create a workspace, then type `ping` in the chat.

Do not run `npm run build` or `npm run test:e2e` while `npm run dev` is running: both write
`.next` and break the dev server.

## Commands

| Command                                          | What it does                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `npm run dev`                                    | Next dev server on port 3100                                            |
| `npm run build` / `npm start`                    | Production build and server (port 3100)                                 |
| `npm run check`                                  | Biome lint and format check (CI gate)                                   |
| `npm run check:fix`                              | Biome with safe and unsafe fixes written                                |
| `npm run typecheck`                              | `next typegen` and `tsc --noEmit`                                       |
| `npm test`                                       | Vitest, unit and integration                                            |
| `npm run test:unit` / `npm run test:integration` | One Vitest layer                                                        |
| `npm run test:e2e`                               | Playwright smoke test (starts AIMock, migrates, builds, starts the app) |
| `npm run aimock`                                 | AIMock on 127.0.0.1:4010 with `aimock.json`                             |
| `npm run auth:generate`                          | Regenerate `src/server/db/schema/auth.ts` from the Better Auth config   |
| `npm run db:generate`                            | Create a Drizzle migration from schema changes                          |
| `npm run db:migrate`                             | Apply migrations to `MELOS_CONTROL_DATABASE_URL`                        |

`auth:generate` loads the app config, so the environment must validate. Placeholders are enough,
for example `BETTER_AUTH_SECRET` of 32 or more characters and
`MELOS_LLM_BASE_URL=http://127.0.0.1:4010/v1`. After it runs, run `npm run db:generate`.

`drizzle-kit` does not read `.env.local`. With no variables set, `db:migrate` uses the local file.

## Environment contract

The server validates the environment at startup (`src/instrumentation.ts`) and on first use. A
failure lists the variable names that are missing or invalid, never their values.

| Variable                            | Required                           | Notes                                                                                         |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                | always                             | 32 or more characters                                                                         |
| `BETTER_AUTH_URL`                   | no                                 | Unset: `https://$VERCEL_BRANCH_URL`, then `https://$VERCEL_URL`, then `http://localhost:3100` |
| `MELOS_CONTROL_DATABASE_URL`        | on Vercel                          | Better Auth and control plane. Local default `file:./data/control.db`                         |
| `MELOS_CONTROL_DATABASE_AUTH_TOKEN` | on Vercel                          | libSQL token for the control plane                                                            |
| `MELOS_AGENT_DATABASE_URL`          | on Vercel                          | Mastra storage, separate from the control plane. Local default `file:./data/agent.db`         |
| `MELOS_AGENT_DATABASE_AUTH_TOKEN`   | on Vercel                          | libSQL token for agent storage                                                                |
| `MELOS_CHAT_MODEL`                  | unless `MELOS_LLM_BASE_URL` is set | Mastra model router string, e.g. `mastra/anthropic/claude-haiku-4.5`                          |
| `MASTRA_GATEWAY_API_KEY`            | for `mastra/*` models              | Read by the Mastra model router                                                               |
| `MELOS_LLM_BASE_URL`                | tests only                         | OpenAI-compatible mock URL (AIMock). Dummy key. Rejected on Vercel                            |
| `MELOS_EMAIL_TRANSPORT`             | no                                 | `sandbox` (default). Contract name, not used yet                                              |
| `COPILOTKIT_TELEMETRY_DISABLED`     | no                                 | Set to `true`                                                                                 |

On Vercel, `file:` database URLs are rejected, so the app never writes local files there.

## Vercel previews

Trusted origins are the exact URLs of the deployment: `BETTER_AUTH_URL`, the branch URL, the
deployment URL and the production URL. No wildcard origins.

Vercel functions run in `pdx1`. Put preview databases in the nearest libSQL region.

**Migrating a preview database.** The build does not run migrations. Before a preview is used,
and again whenever a branch adds a migration, apply them from your machine with that preview's
control-plane credentials injected into the shell:

```bash
# MELOS_CONTROL_DATABASE_URL and MELOS_CONTROL_DATABASE_AUTH_TOKEN injected by your secrets manager
npm run db:migrate
```

The agent database needs no migration step: Mastra creates its tables on first use.

## Tests

- **Unit** (`tests/unit`): env validation, roles, request context, the `ping` tool, and the
  `src/mastra` import boundary.
- **Integration** (`tests/integration`): sign-up, sign-in, workspace creation, set active,
  server-side session, custom `viewer` role, and the agent route through AG-UI to the `ping` tool.
  Memory is checked under `<organizationId>:<userId>`.
- **E2E** (`tests/e2e`): sign up, sign in, create a workspace, ask the chat, see the tool card.

Every model call goes to AIMock. No test needs a model key.

The `src/mastra` import boundary is enforced twice: by a Vitest test that resolves every local
import, and by a Biome `noRestrictedImports` override.
