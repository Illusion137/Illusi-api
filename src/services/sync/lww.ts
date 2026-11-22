/** Last-write-wins for user-owned rows: row level, by the client's `edited_at` clamped to server time. */

/** A device with its clock in the future can't win every conflict: `edited_at` never exceeds the server's now. */
export function clamp_edited_at(edited_at: Date, server_now: Date): Date {
	return edited_at.getTime() > server_now.getTime() ? server_now : edited_at;
}

/**
 * How far the device's clock is behind the server's (negative if ahead), from the `client_now` it sent. Under a
 * second is network delay, not skew, and counts as none.
 */
export function clock_skew_ms(client_now: Date | undefined, server_now: Date): number {
	if (!client_now) return 0;
	const skew = server_now.getTime() - client_now.getTime();
	return Math.abs(skew) < 1_000 ? 0 : skew;
}

/** Device times further than this from the push's `client_now` keep their value: the clock may well have been right then. */
export const SKEW_WINDOW_MS = 7 * 86_400_000;

/**
 * A device time corrected by the device's current clock offset. Only recent times are corrected: an old timestamp
 * (a library imported from an older app version) was recorded under whatever the clock said back then.
 */
export function correct_skew(at: Date, client_now: Date | undefined, skew_ms: number): Date {
	if (skew_ms === 0 || !client_now || Math.abs(client_now.getTime() - at.getTime()) > SKEW_WINDOW_MS) return at;
	return new Date(at.getTime() + skew_ms);
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
