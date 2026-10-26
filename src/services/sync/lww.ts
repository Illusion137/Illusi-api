/** Last-write-wins for user-owned rows: row level, by the client's `edited_at` clamped to server time. */

/** A device with its clock in the future can't win every conflict: `edited_at` never exceeds the server's now. */
export function clamp_edited_at(edited_at: Date, server_now: Date): Date {
	return edited_at.getTime() > server_now.getTime() ? server_now : edited_at;
}

/** Applies only if strictly newer than the stored edit (ties keep the server row); a stored row without `edited_at` always yields. */
export function lww_wins(stored_edited_at: Date | null | undefined, incoming_edited_at: Date): boolean {
	return stored_edited_at == null || incoming_edited_at.getTime() > stored_edited_at.getTime();
}

/**
 * The values to write when the incoming row wins: every user-owned column it carries replaces the stored
 * one (explicit `null` clears it, an omitted field keeps the stored value), plus the clamped `edited_at`.
 */
export function lww_update<T extends Record<string, unknown>>(columns: readonly (keyof T & string)[], incoming: Partial<T>, edited_at: Date): Partial<T> & { edited_at: Date } {
	const out: Record<string, unknown> = {};
	for (const column of columns) if (incoming[column] !== undefined) out[column] = incoming[column];
	return { ...(out as Partial<T>), edited_at };
}
