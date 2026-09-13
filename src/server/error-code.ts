/** The first name and code in the cause chain. Messages are never kept: they may hold a token. */
export function errorCode(error: unknown): string {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const { code } = cause as { code?: unknown };
    if (typeof code === 'string') return `${cause.name} ${code}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}
