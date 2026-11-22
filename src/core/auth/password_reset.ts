import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, notExists, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import { email_verifications_table, password_resets_table, users_table } from '../../db/schema';
import { send_email } from '../email';

/** Codes are short, so they're stored as an HMAC under a server secret: a leaked table alone doesn't reveal them. */
export function hash_reset_code(user_id: string, code: string): string {
	return createHmac('sha256', config.ACTION_TOKEN_SECRET).update(`password_reset:${user_id}:${code}`).digest('hex');
}

export function new_reset_code(): string {
	return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Replaces any pending code for the user with a new one and emails it. Throws if the email can't be sent. */
export async function send_password_reset(user: { id: string; email: string; username: string }): Promise<void> {
	const code = new_reset_code();
	await db.transaction(async (tx) => {
		await tx.delete(password_resets_table).where(and(eq(password_resets_table.user_id, user.id), isNull(password_resets_table.used_at)));
		await tx.insert(password_resets_table).values({
			user_id: user.id,
			code_hash: hash_reset_code(user.id, code),
			expires_at: new Date(Date.now() + config.PASSWORD_RESET_TTL_MIN * 60_000)
		});
	});
	const minutes = config.PASSWORD_RESET_TTL_MIN;
	await send_email({
		to: user.email,
		subject: `${code} is your password reset code`,
		text: `Hi ${user.username},\n\nEnter this code in the app to choose a new password:\n\n${code}\n\nIt works for ${minutes} minutes. If you didn't ask to reset your password, ignore this email.`,
		html: `<p>Hi ${user.username.replace(/[&<>"']/gu, c => `&#${c.charCodeAt(0)};`)},</p><p>Enter this code in the app to choose a new password:</p><p style="font-size:28px;letter-spacing:4px"><b>${code}</b></p><p>It works for ${minutes} minutes. If you didn't ask to reset your password, ignore this email.</p>`
	});
}

/**
 * Checks a code against the user's newest pending reset and marks it used on success. Every wrong guess counts
 * against PASSWORD_RESET_MAX_ATTEMPTS, after which the code is dead even if later guessed right.
 */
export async function consume_reset_code(user_id: string, code: string): Promise<boolean> {
	return await db.transaction(async (tx) => {
		const [row] = await tx.select().from(password_resets_table)
			.where(and(eq(password_resets_table.user_id, user_id), isNull(password_resets_table.used_at), gt(password_resets_table.expires_at, new Date())))
			.orderBy(desc(password_resets_table.created_at)).limit(1).for('update');
		if (!row || row.attempts >= config.PASSWORD_RESET_MAX_ATTEMPTS) return false;
		const expected = Buffer.from(row.code_hash, 'hex');
		const given = Buffer.from(hash_reset_code(user_id, code), 'hex');
		if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
			await tx.update(password_resets_table).set({ attempts: sql`${password_resets_table.attempts} + 1` }).where(eq(password_resets_table.id, row.id));
			return false;
		}
		await tx.update(password_resets_table).set({ used_at: new Date() }).where(eq(password_resets_table.id, row.id));
		return true;
	});
}

/**
 * The user registered under `email` if it's a never-verified account that has given up: older than a verification
 * link's lifetime with no live link left. Its address can be registered again. Such an account never reached
 * anything outside `/auth`, so there is nothing of its to keep.
 */
export async function abandoned_unverified_account(email: string): Promise<string | null> {
	const cutoff = new Date(Date.now() - config.EMAIL_VERIFICATION_TTL_HOURS * 3_600_000);
	const [row] = await db.select({ id: users_table.id }).from(users_table)
		.where(and(
			eq(users_table.email, email),
			isNull(users_table.email_verified_at),
			lt(users_table.created_at, cutoff),
			notExists(db.select({ one: sql`1` }).from(email_verifications_table).where(and(
				eq(email_verifications_table.user_id, users_table.id),
				isNull(email_verifications_table.used_at),
				gt(email_verifications_table.expires_at, new Date())
			)))
		));
	return row?.id ?? null;
}
