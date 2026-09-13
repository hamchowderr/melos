/**
 * Maps a failed agent run to plain-language chat copy. Shared by the chat UI (browser) and
 * tests. Provider text is only pattern-matched, never shown: it can carry raw payloads.
 */
export type ChatRunErrorKind = 'credits' | 'rate_limit' | 'auth' | 'busy' | 'unknown';

export type ChatRunError = { kind: ChatRunErrorKind; message: string };

const MESSAGES: Record<ChatRunErrorKind, string> = {
  credits:
    'The AI provider is out of credits, so Melos could not answer. An admin needs to add credits or update billing.',
  rate_limit:
    'The AI provider is receiving too many requests right now. Wait a moment, then try again.',
  auth: 'The AI provider rejected the credentials Melos uses. An admin needs to check the model settings.',
  busy: 'Melos is still answering your previous message. Wait for it to finish, then try again.',
  unknown: 'Melos could not finish that answer. Try again.',
};

// Order matters: an exhausted quota often arrives as a 429, and it is a billing problem.
const PROVIDER_PATTERNS: [ChatRunErrorKind, RegExp][] = [
  [
    'credits',
    /credit|billing|payment required|insufficient[_ ](?:funds|quota|balance)|exceeded your current quota|\b402\b/i,
  ],
  ['rate_limit', /rate[_ -]?limit|too many requests|overloaded|\b429\b/i],
  ['auth', /unauthori[sz]ed|forbidden|api[_ -]?key|authentication|\b40[13]\b/i],
];

// CopilotKitCoreErrorCode values for a run that ended without an answer.
const RUN_ERROR_CODES = new Set([
  'agent_run_failed',
  'agent_run_failed_event',
  'agent_run_error_event',
  'agent_thread_locked',
]);

export function isChatRunErrorCode(code: string): boolean {
  return RUN_ERROR_CODES.has(code);
}

function messageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('message' in error)) return '';
  return typeof error.message === 'string' ? error.message : '';
}

export function toChatRunError(code: string, error: unknown): ChatRunError {
  if (code === 'agent_thread_locked') return { kind: 'busy', message: MESSAGES.busy };
  const text = messageOf(error);
  const kind = PROVIDER_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'unknown';
  return { kind, message: MESSAGES[kind] };
}
