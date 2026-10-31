/** SQLSTATE codes the app reacts to. */
export const PG_ERRORS = {
	unique_violation: '23505',
	foreign_key_violation: '23503',
	check_violation: '23514',
	serialization_failure: '40001',
	deadlock_detected: '40P01'
} as const;

/**
 * The Postgres SQLSTATE of a failed query. drizzle 1.0 wraps driver errors in `DrizzleQueryError`
 * with the pg error as `cause`, so the code may sit one level down.
 */
export function pg_error_code(err: unknown): string | undefined {
	const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
	if (typeof e?.code === 'string') return e.code;
	return typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
}

/** The pg error's `detail` (e.g. which key collided), wrapped or not. */
export function pg_error_detail(err: unknown): string | undefined {
	const e = err as { detail?: unknown; cause?: { detail?: unknown } } | null;
	if (typeof e?.detail === 'string') return e.detail;
	return typeof e?.cause?.detail === 'string' ? e.cause.detail : undefined;
}

/** The violated constraint's name, wrapped or not. */
export function pg_error_constraint(err: unknown): string | undefined {
	const e = err as { constraint?: unknown; cause?: { constraint?: unknown } } | null;
	if (typeof e?.constraint === 'string') return e.constraint;
	return typeof e?.cause?.constraint === 'string' ? e.cause.constraint : undefined;
}
