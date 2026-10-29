/** Rows per table behind an IntegrityGuard refusal (docs/CONTRACT.md §4.4). */
export type RowCounts = Readonly<Record<string, number>>;

/**
 * A refusal: a code with typed details, never a message, which may hold a URL or a token (§7.2).
 * FORBIDDEN: the role resolved for the request lacks the permission (§6.2, ADR-028). NOT_FOUND: an
 * id names no live row in the active workspace database (§3.1); from IntegrityGuard, `counts` holds
 * the missing parents per table. REFERENCED: the rows per child table still referencing what a write
 * changes or deletes (§4.4 rules 1 and 2). SONG_LEVEL_CONFLICT: the written rows that would hold a
 * song at both levels in a pitch (rule 3). VALIDATION: an input rule with no code of its own
 * (identifiers keep INVALID_*), refused before writing (§3.1, P-45); `field` names the input and
 * `reason` is a stable snake_case code. INVALID_ISRC, INVALID_ISWC, INVALID_UPC_EAN: an identifier
 * the normalizer refuses, with its `reason`; CONFLICT: a unique value a live row already holds
 * (§3.1, P-46); both name the input `field`. STATE_CHANGED: the rows an approval's `beforeHash`
 * covers changed since it was taken (§7.4, AUD-003); nothing was written. requirePermission's FORBIDDEN adds a fixed sentence for
 * pages; services return the code alone, so every service refuses with the same value.
 */
export type ServiceError =
  | { code: 'FORBIDDEN' | 'STATE_CHANGED' }
  | { code: 'NOT_FOUND'; counts?: RowCounts }
  | { code: 'REFERENCED' | 'SONG_LEVEL_CONFLICT'; counts: RowCounts }
  | { code: 'VALIDATION'; field: string; reason: string }
  | {
      code: 'INVALID_ISRC' | 'INVALID_ISWC' | 'INVALID_UPC_EAN';
      field: string;
      reason: 'shape' | 'check_digit';
    }
  | { code: 'CONFLICT'; field: string };

export type ServiceErrorCode = ServiceError['code'];

/** A service call's outcome. A database failure throws WorkspaceConnectionError instead (§7.2). */
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export const success = <T>(value: T): ServiceResult<T> => ({ ok: true, value });

/** A refusal from a code that needs no details, or from a complete error. */
export const failure = (
  error: 'FORBIDDEN' | 'NOT_FOUND' | 'STATE_CHANGED' | ServiceError,
): ServiceResult<never> => ({
  ok: false,
  error: typeof error === 'string' ? { code: error } : error,
});
