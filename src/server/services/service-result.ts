/**
 * Refusal codes (docs/CONTRACT.md): FORBIDDEN when the role resolved for the request lacks the
 * permission (§6.2, ADR-028); NOT_FOUND when an id names no live row in the active workspace
 * database (§3.1).
 */
export type ServiceErrorCode = 'FORBIDDEN' | 'NOT_FOUND';

/** A code only: a raw error message may hold a URL or a token (§7.2). */
export type ServiceError = { code: ServiceErrorCode };

/** A service call's outcome. A database failure throws WorkspaceConnectionError instead (§7.2). */
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export const success = <T>(value: T): ServiceResult<T> => ({ ok: true, value });

export const failure = (code: ServiceErrorCode): ServiceResult<never> => ({
  ok: false,
  error: { code },
});
