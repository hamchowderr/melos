import { posix, resolve } from 'node:path';
import { expandConfig, isInMemoryConfig } from '@libsql/core/config';
import { encodeBaseUrl } from '@libsql/core/uri';
import { z } from 'zod';
import { LOCAL_AGENT_DATABASE_URL, LOCAL_CONTROL_DATABASE_URL } from './db/local-database';
import { isTokenKey } from './db/token-cipher';

const LOCAL_BASE_URL = 'http://localhost:3100';
const LOCAL_WORKSPACE_DATA_DIR = '.data';

/** Model id sent to the OpenAI-compatible endpoint named by MELOS_LLM_BASE_URL (AIMock). */
export const TEST_CHAT_MODEL_ID = 'openai/gpt-4o-mini';

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalText = z.preprocess(blankToUndefined, z.string().optional());
const optionalUrl = z.preprocess(
  blankToUndefined,
  z.url({ error: 'must be an absolute URL' }).optional(),
);

const rawEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.preprocess(
    blankToUndefined,
    z.string({ error: 'is required' }).min(32, { error: 'must be at least 32 characters' }),
  ),
  BETTER_AUTH_URL: optionalUrl,
  VERCEL: optionalText,
  VERCEL_ENV: optionalText,
  VERCEL_URL: optionalText,
  VERCEL_BRANCH_URL: optionalText,
  VERCEL_PROJECT_PRODUCTION_URL: optionalText,
  MELOS_CONTROL_DATABASE_URL: optionalText,
  MELOS_CONTROL_DATABASE_AUTH_TOKEN: optionalText,
  MELOS_AGENT_DATABASE_URL: optionalText,
  MELOS_AGENT_DATABASE_AUTH_TOKEN: optionalText,
  MELOS_WORKSPACE_DATA_DIR: optionalText,
  TURSO_API_TOKEN: optionalText,
  TURSO_ORG: optionalText,
  MELOS_TURSO_GROUP: z.preprocess(blankToUndefined, z.string().default('default')),
  MELOS_WORKSPACE_TOKEN_KEY: z.preprocess(
    blankToUndefined,
    z.string().refine(isTokenKey, { error: 'must be 32 bytes encoded as base64' }).optional(),
  ),
  MELOS_CHAT_MODEL: optionalText,
  // Kept as given, not blanked: @ai-sdk/gateway reads any present value, whitespace included.
  AI_GATEWAY_API_KEY: z.string().optional(),
  MELOS_LLM_BASE_URL: optionalUrl,
  MELOS_EMAIL_TRANSPORT: z.preprocess(
    blankToUndefined,
    z.enum(['sandbox'], { error: 'must be one of: sandbox' }).default('sandbox'),
  ),
  MELOS_AUTH_MAILER: z.preprocess(
    blankToUndefined,
    z
      .enum(['outbox', 'memory', 'disabled'], { error: 'must be one of: outbox, memory, disabled' })
      .default('outbox'),
  ),
  MELOS_SIGNUP_ALLOWED_EMAILS: optionalText,
  MELOS_ASSET_STORAGE: z.preprocess(
    blankToUndefined,
    z.enum(['local', 'r2'], { error: 'must be one of: local, r2' }).optional(),
  ),
});

type RawEnv = z.infer<typeof rawEnvSchema>;

const DATABASES = [
  ['MELOS_CONTROL_DATABASE_URL', 'MELOS_CONTROL_DATABASE_AUTH_TOKEN'],
  ['MELOS_AGENT_DATABASE_URL', 'MELOS_AGENT_DATABASE_AUTH_TOKEN'],
] as const;

/**
 * Where @libsql/client sends a URL's queries, from its own expansion and base URL: HTTP resolves
 * `v2/pipeline` against the base URL, so its directory is the endpoint, and a WebSocket opens the base
 * URL itself. One server answers both, so both compare on the HTTP scheme. A file URL is its resolved
 * path. An in-memory database is private to its client and an unparsable URL opens nothing, so
 * neither has a key.
 */
function databaseKey(url: string): string | null {
  try {
    const config = expandConfig({ url }, true);
    if (isInMemoryConfig(config)) return null;
    if (config.scheme === 'file') return `file:${resolve(config.path)}`;
    const base = encodeBaseUrl(config.scheme, config.authority, config.path);
    const http = config.scheme === 'https' || config.scheme === 'http';
    const { host, pathname } = http ? new URL('./', base) : base;
    const secure = config.scheme === 'https' || config.scheme === 'wss';
    return `${secure ? 'https' : 'http'}://${host}${pathname}`;
  } catch {
    return null;
  }
}

const envSchema = rawEnvSchema.superRefine((env, ctx) => {
  const flag = (name: keyof RawEnv, message: string) =>
    ctx.addIssue({ code: 'custom', path: [name], message });

  // Mastra storage never shares the control database (TEN-006). Workspace URLs are generated per
  // workspace (§7.2), so neither can name one.
  const agentKey = databaseKey(env.MELOS_AGENT_DATABASE_URL ?? LOCAL_AGENT_DATABASE_URL);
  const controlKey = databaseKey(env.MELOS_CONTROL_DATABASE_URL ?? LOCAL_CONTROL_DATABASE_URL);
  if (agentKey !== null && agentKey === controlKey) {
    flag('MELOS_AGENT_DATABASE_URL', 'must not name the control database');
  }

  if (env.VERCEL) {
    for (const [urlName, tokenName] of DATABASES) {
      const url = env[urlName];
      if (!url) {
        flag(urlName, 'is required on Vercel');
      } else if (url.startsWith('file:')) {
        flag(urlName, 'must be a remote libSQL URL on Vercel (local files are not allowed)');
      }
      if (!env[tokenName]) flag(tokenName, 'is required on Vercel');
    }
    if (env.MELOS_WORKSPACE_DATA_DIR) {
      flag('MELOS_WORKSPACE_DATA_DIR', 'must not be set on Vercel (local files are not allowed)');
    }
    if (env.MELOS_LLM_BASE_URL) {
      flag('MELOS_LLM_BASE_URL', 'is test-only and must not be set on Vercel');
    }
    // Unset selects r2 on Vercel, checked on the first asset call, so no deploy needs it (D-7).
    if (env.MELOS_ASSET_STORAGE === 'local') {
      flag('MELOS_ASSET_STORAGE', 'must not be local on Vercel (local files are not allowed)');
    }
    // The gateway provider prefers a present key, even a blank one, over the OIDC token used here.
    if (env.AI_GATEWAY_API_KEY !== undefined) {
      flag(
        'AI_GATEWAY_API_KEY',
        'must not be set on Vercel (the OIDC token authenticates the gateway)',
      );
    }
  }

  // outbox and memory are development mailers; production gets one when phase 8 wires Resend.
  if (env.VERCEL_ENV === 'production' && env.MELOS_AUTH_MAILER !== 'disabled') {
    flag(
      'MELOS_AUTH_MAILER',
      'must be disabled in production (outbox and memory are for development)',
    );
  }
});

export type DatabaseSetting = { url: string; authToken?: string };

/** Local files off Vercel; Turso Cloud on Vercel, `unconfigured` until its variables are set. */
export type WorkspaceHostSetting =
  | { kind: 'local'; dataDir: string }
  | { kind: 'turso'; apiToken: string; organization: string; group: string; tokenKey: string }
  | { kind: 'unconfigured'; missing: string[] };

/** A real model goes through the AI Gateway: no key on Vercel (its OIDC token), a key elsewhere. */
export type ChatModelSetting =
  | { provider: 'gateway'; id: string; apiKey?: string }
  | { provider: 'openai-compatible'; id: string; url: string };

/** A chat model whose variables are missing or invalid; `requireChatModel` throws its problems. */
export type UnconfiguredChatModel = { provider: 'unconfigured'; problems: EnvProblem[] };

/** Files under the workspace data folder off Vercel; R2 on Vercel, resolved on first use (D-7). */
export type AssetStorageSetting = { kind: 'local'; rootDir: string } | { kind: 'r2' };

export type ServerEnv = {
  onVercel: boolean;
  assetStorage: AssetStorageSetting;
  auth: { secret: string; baseURL: string; trustedOrigins: string[] };
  controlDatabase: DatabaseSetting;
  agentDatabase: DatabaseSetting;
  workspaceHost: WorkspaceHostSetting;
  chatModel: ChatModelSetting | UnconfiguredChatModel;
  emailTransport: 'sandbox';
  authMailer: 'outbox' | 'memory' | 'disabled';
  /** Lower-cased addresses that may sign up; null lets anyone sign up (never in production). */
  signUpAllowedEmails: string[] | null;
};

export type EnvProblem = { name: string; reason: string };

export class ServerEnvError extends Error {
  readonly problems: EnvProblem[];

  constructor(problems: EnvProblem[]) {
    super(
      [
        'Invalid Melos server environment (values are never printed):',
        ...problems.map((problem) => `  - ${problem.name} ${problem.reason}`),
      ].join('\n'),
    );
    this.name = 'ServerEnvError';
    this.problems = problems;
  }
}

const httpsOrigin = (host: string | undefined) => (host ? `https://${host}` : undefined);

function resolveAuthUrls(env: RawEnv): {
  baseURL: string;
  trustedOrigins: string[];
} {
  const branchUrl = httpsOrigin(env.VERCEL_BRANCH_URL);
  const deploymentUrl = httpsOrigin(env.VERCEL_URL);
  const productionUrl = httpsOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);
  // Production is served at its project domain; a preview at its branch URL.
  const vercelUrl =
    env.VERCEL_ENV === 'production'
      ? (productionUrl ?? branchUrl ?? deploymentUrl)
      : (branchUrl ?? deploymentUrl);
  const baseURL = env.BETTER_AUTH_URL ?? vercelUrl ?? LOCAL_BASE_URL;
  // Exact origins only: a preview is reachable at its branch URL and its deployment URL.
  const candidates = [baseURL, branchUrl, deploymentUrl, productionUrl];
  const trustedOrigins = [
    ...new Set(
      candidates.filter((url): url is string => Boolean(url)).map((url) => new URL(url).origin),
    ),
  ];
  return { baseURL, trustedOrigins };
}

/** Unset admits anyone outside production and nobody in production (fail closed). */
function parseSignUpAllowlist(env: RawEnv): string[] | null {
  if (env.MELOS_SIGNUP_ALLOWED_EMAILS === undefined) {
    return env.VERCEL_ENV === 'production' ? [] : null;
  }
  return env.MELOS_SIGNUP_ALLOWED_EMAILS.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/** Missing Turso variables fail provisioning, not startup, so a deploy without them still runs. */
function resolveWorkspaceHost(env: RawEnv): WorkspaceHostSetting {
  if (!env.VERCEL) {
    return { kind: 'local', dataDir: env.MELOS_WORKSPACE_DATA_DIR ?? LOCAL_WORKSPACE_DATA_DIR };
  }
  const { TURSO_API_TOKEN: apiToken, TURSO_ORG: organization } = env;
  const tokenKey = env.MELOS_WORKSPACE_TOKEN_KEY;
  if (apiToken && organization && tokenKey) {
    return { kind: 'turso', apiToken, organization, group: env.MELOS_TURSO_GROUP, tokenKey };
  }
  const names = ['TURSO_API_TOKEN', 'TURSO_ORG', 'MELOS_WORKSPACE_TOKEN_KEY'] as const;
  return { kind: 'unconfigured', missing: names.filter((name) => !env[name]) };
}

/** `creator/model` with a lower-case creator, as AI Gateway model ids are written. */
const GATEWAY_MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/\S+$/;
/** Router spellings the gateway does not serve: `mastra/…`, `vercel/<creator>/…`, `claude-haiku-4-5`. */
const ROUTER_MODEL_ID =
  /^(?:mastra\/|vercel\/[^/]+\/|anthropic\/claude-(?:[a-z]+-)?\d+-\d+(?:-|$))/;

/**
 * A real model goes through the Vercel AI Gateway (ADR-034); on Vercel its credential is the OIDC
 * token each request carries. Problems wait for `requireChatModel`, so operator scripts, which
 * call no model, do not need these variables.
 */
function resolveChatModel(env: RawEnv): ChatModelSetting | UnconfiguredChatModel {
  if (env.MELOS_LLM_BASE_URL) {
    return { provider: 'openai-compatible', id: TEST_CHAT_MODEL_ID, url: env.MELOS_LLM_BASE_URL };
  }
  const id = env.MELOS_CHAT_MODEL;
  const problems: EnvProblem[] = [];
  if (!id) {
    const reason = 'is required (tests set MELOS_LLM_BASE_URL instead)';
    problems.push({ name: 'MELOS_CHAT_MODEL', reason });
  } else if (!GATEWAY_MODEL_ID.test(id) || ROUTER_MODEL_ID.test(id)) {
    const reason =
      'must be an AI Gateway model id such as anthropic/claude-haiku-4.5, not a router id';
    problems.push({ name: 'MELOS_CHAT_MODEL', reason });
  }
  // On Vercel parseServerEnv refuses any key. Elsewhere the provider would send a blank one.
  const apiKey = env.AI_GATEWAY_API_KEY;
  if (!env.VERCEL && !apiKey?.trim()) {
    const reason =
      apiKey === undefined ? 'is required off Vercel for a real model' : 'must not be blank';
    problems.push({ name: 'AI_GATEWAY_API_KEY', reason });
  }
  if (!id || problems.length > 0) return { provider: 'unconfigured', problems };
  return { provider: 'gateway', id, apiKey };
}

/** The chat model, or a ServerEnvError naming what it lacks. App startup and Mastra call it. */
export function requireChatModel(setting: ServerEnv['chatModel']): ChatModelSetting {
  if (setting.provider === 'unconfigured') throw new ServerEnvError(setting.problems);
  return setting;
}

/** Parses an environment record. Throws ServerEnvError listing variable names, never values. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ServerEnvError(
      result.error.issues.map((issue) => ({
        name: String(issue.path[0] ?? 'environment'),
        reason: issue.message,
      })),
    );
  }
  const env = result.data;
  const workspaceHost = resolveWorkspaceHost(env);

  return {
    onVercel: Boolean(env.VERCEL),
    // Only an off-Vercel host is local, and local assets on Vercel were refused above.
    assetStorage:
      env.MELOS_ASSET_STORAGE === 'r2' || workspaceHost.kind !== 'local'
        ? { kind: 'r2' }
        : { kind: 'local', rootDir: posix.join(workspaceHost.dataDir, 'assets') },
    auth: { secret: env.BETTER_AUTH_SECRET, ...resolveAuthUrls(env) },
    controlDatabase: {
      url: env.MELOS_CONTROL_DATABASE_URL ?? LOCAL_CONTROL_DATABASE_URL,
      authToken: env.MELOS_CONTROL_DATABASE_AUTH_TOKEN,
    },
    agentDatabase: {
      url: env.MELOS_AGENT_DATABASE_URL ?? LOCAL_AGENT_DATABASE_URL,
      authToken: env.MELOS_AGENT_DATABASE_AUTH_TOKEN,
    },
    workspaceHost,
    chatModel: resolveChatModel(env),
    emailTransport: env.MELOS_EMAIL_TRANSPORT,
    authMailer: env.MELOS_AUTH_MAILER,
    signUpAllowedEmails: parseSignUpAllowlist(env),
  };
}

let cached: ServerEnv | undefined;

/** The validated server environment, parsed once per process. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
