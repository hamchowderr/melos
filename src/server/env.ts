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
  MASTRA_GATEWAY_API_KEY: optionalText,
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
});

type RawEnv = z.infer<typeof rawEnvSchema>;

const DATABASES = [
  ['MELOS_CONTROL_DATABASE_URL', 'MELOS_CONTROL_DATABASE_AUTH_TOKEN'],
  ['MELOS_AGENT_DATABASE_URL', 'MELOS_AGENT_DATABASE_AUTH_TOKEN'],
] as const;

/** Workspace databases on Vercel live on Turso Cloud with encrypted tokens (ADR-031). */
const TURSO_WORKSPACE_SETTINGS = [
  'TURSO_API_TOKEN',
  'TURSO_ORG',
  'MELOS_WORKSPACE_TOKEN_KEY',
] as const;

const envSchema = rawEnvSchema.superRefine((env, ctx) => {
  const flag = (name: keyof RawEnv, message: string) =>
    ctx.addIssue({ code: 'custom', path: [name], message });

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
    for (const name of TURSO_WORKSPACE_SETTINGS) {
      if (!env[name]) flag(name, 'is required on Vercel');
    }
    if (env.MELOS_WORKSPACE_DATA_DIR) {
      flag('MELOS_WORKSPACE_DATA_DIR', 'must not be set on Vercel (local files are not allowed)');
    }
    if (env.MELOS_LLM_BASE_URL) {
      flag('MELOS_LLM_BASE_URL', 'is test-only and must not be set on Vercel');
    }
  }

  // outbox and memory are development mailers; production gets one when phase 8 wires Resend.
  if (env.VERCEL_ENV === 'production' && env.MELOS_AUTH_MAILER !== 'disabled') {
    flag(
      'MELOS_AUTH_MAILER',
      'must be disabled in production (outbox and memory are for development)',
    );
  }

  if (!env.MELOS_LLM_BASE_URL) {
    if (!env.MELOS_CHAT_MODEL) {
      flag('MELOS_CHAT_MODEL', 'is required (tests set MELOS_LLM_BASE_URL instead)');
    } else if (env.MELOS_CHAT_MODEL.startsWith('mastra/') && !env.MASTRA_GATEWAY_API_KEY) {
      flag('MASTRA_GATEWAY_API_KEY', 'is required when MELOS_CHAT_MODEL uses the Mastra Gateway');
    }
  }
});

export type DatabaseSetting = { url: string; authToken?: string };

/** Local libSQL files off Vercel; Turso Cloud databases with encrypted tokens on Vercel (ADR-031). */
export type WorkspaceHostSetting =
  | { kind: 'local'; dataDir: string }
  | { kind: 'turso'; apiToken: string; organization: string; group: string; tokenKey: string };

export type ChatModelSetting =
  | { provider: 'router'; id: string }
  | { provider: 'openai-compatible'; id: string; url: string };

export type ServerEnv = {
  onVercel: boolean;
  auth: { secret: string; baseURL: string; trustedOrigins: string[] };
  controlDatabase: DatabaseSetting;
  agentDatabase: DatabaseSetting;
  workspaceHost: WorkspaceHostSetting;
  chatModel: ChatModelSetting;
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

  return {
    onVercel: Boolean(env.VERCEL),
    auth: { secret: env.BETTER_AUTH_SECRET, ...resolveAuthUrls(env) },
    controlDatabase: {
      url: env.MELOS_CONTROL_DATABASE_URL ?? LOCAL_CONTROL_DATABASE_URL,
      authToken: env.MELOS_CONTROL_DATABASE_AUTH_TOKEN,
    },
    agentDatabase: {
      url: env.MELOS_AGENT_DATABASE_URL ?? LOCAL_AGENT_DATABASE_URL,
      authToken: env.MELOS_AGENT_DATABASE_AUTH_TOKEN,
    },
    workspaceHost: env.VERCEL
      ? {
          kind: 'turso',
          apiToken: env.TURSO_API_TOKEN ?? '',
          organization: env.TURSO_ORG ?? '',
          group: env.MELOS_TURSO_GROUP,
          tokenKey: env.MELOS_WORKSPACE_TOKEN_KEY ?? '',
        }
      : { kind: 'local', dataDir: env.MELOS_WORKSPACE_DATA_DIR ?? LOCAL_WORKSPACE_DATA_DIR },
    chatModel: env.MELOS_LLM_BASE_URL
      ? {
          provider: 'openai-compatible',
          id: TEST_CHAT_MODEL_ID,
          url: env.MELOS_LLM_BASE_URL,
        }
      : { provider: 'router', id: env.MELOS_CHAT_MODEL ?? '' },
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
