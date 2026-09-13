import { z } from 'zod';
import { LOCAL_AGENT_DATABASE_URL, LOCAL_CONTROL_DATABASE_URL } from './db/local-database';

const LOCAL_BASE_URL = 'http://localhost:3100';

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
  MELOS_CHAT_MODEL: optionalText,
  MASTRA_GATEWAY_API_KEY: optionalText,
  MELOS_LLM_BASE_URL: optionalUrl,
  MELOS_EMAIL_TRANSPORT: z.preprocess(
    blankToUndefined,
    z.enum(['sandbox'], { error: 'must be one of: sandbox' }).default('sandbox'),
  ),
  MELOS_AUTH_MAILER: z.preprocess(
    blankToUndefined,
    z.enum(['outbox', 'memory'], { error: 'must be one of: outbox, memory' }).default('outbox'),
  ),
});

type RawEnv = z.infer<typeof rawEnvSchema>;

const DATABASES = [
  ['MELOS_CONTROL_DATABASE_URL', 'MELOS_CONTROL_DATABASE_AUTH_TOKEN'],
  ['MELOS_AGENT_DATABASE_URL', 'MELOS_AGENT_DATABASE_AUTH_TOKEN'],
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
    if (env.MELOS_LLM_BASE_URL) {
      flag('MELOS_LLM_BASE_URL', 'is test-only and must not be set on Vercel');
    }
  }

  // Both mailers are development mailers; production gets one when phase 8 wires Resend.
  if (env.VERCEL_ENV === 'production') {
    flag('MELOS_AUTH_MAILER', 'selects a development mailer, which production refuses');
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

export type ChatModelSetting =
  | { provider: 'router'; id: string }
  | { provider: 'openai-compatible'; id: string; url: string };

export type ServerEnv = {
  onVercel: boolean;
  auth: { secret: string; baseURL: string; trustedOrigins: string[] };
  controlDatabase: DatabaseSetting;
  agentDatabase: DatabaseSetting;
  chatModel: ChatModelSetting;
  emailTransport: 'sandbox';
  authMailer: 'outbox' | 'memory';
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
  const baseURL = env.BETTER_AUTH_URL ?? branchUrl ?? deploymentUrl ?? LOCAL_BASE_URL;
  // Exact origins only: a preview is reachable at its branch URL and its deployment URL.
  const candidates = [
    baseURL,
    branchUrl,
    deploymentUrl,
    httpsOrigin(env.VERCEL_PROJECT_PRODUCTION_URL),
  ];
  const trustedOrigins = [
    ...new Set(
      candidates.filter((url): url is string => Boolean(url)).map((url) => new URL(url).origin),
    ),
  ];
  return { baseURL, trustedOrigins };
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
    chatModel: env.MELOS_LLM_BASE_URL
      ? {
          provider: 'openai-compatible',
          id: TEST_CHAT_MODEL_ID,
          url: env.MELOS_LLM_BASE_URL,
        }
      : { provider: 'router', id: env.MELOS_CHAT_MODEL ?? '' },
    emailTransport: env.MELOS_EMAIL_TRANSPORT,
    authMailer: env.MELOS_AUTH_MAILER,
  };
}

let cached: ServerEnv | undefined;

/** The validated server environment, parsed once per process. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
