import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import { email_verifications_table, users_table } from '../../db/schema';
import { send_email } from '../email';
import { hash_token } from './tokens';

const escape_html = (value: string) => value.replace(/[&<>"']/gu, c => `&#${c.charCodeAt(0)};`);

export function verification_link(token: string): string {
	return `${config.PUBLIC_API_URL.replace(/\/$/u, '')}/api/v1/auth/verify_email?token=${token}`;
}

/** Replaces any pending link with a new one and emails it. Throws if the email can't be sent. */
export async function send_verification_email(user: { id: string; email: string; username: string }): Promise<void> {
	const token = randomBytes(32).toString('base64url');
	await db.transaction(async (tx) => {
		await tx.delete(email_verifications_table).where(and(eq(email_verifications_table.user_id, user.id), isNull(email_verifications_table.used_at)));
		await tx.insert(email_verifications_table).values({
			user_id: user.id,
			email: user.email,
			token_hash: hash_token(token),
			expires_at: new Date(Date.now() + config.EMAIL_VERIFICATION_TTL_HOURS * 3_600_000)
		});
	});
	const link = verification_link(token);
	const hours = config.EMAIL_VERIFICATION_TTL_HOURS;
	await send_email({
		to: user.email,
		subject: 'Confirm your email',
		text: `Hi ${user.username},\n\nConfirm your email address to finish setting up your account:\n${link}\n\nThe link works for ${hours} hours. If you didn't create an account, ignore this email.`,
		html: `<p>Hi ${escape_html(user.username)},</p><p><a href="${link}">Confirm your email address</a> to finish setting up your account.</p><p>The link works for ${hours} hours. If you didn't create an account, ignore this email.</p>`
	});
}

/** Marks the account's email as verified. False when the token is unknown, used, expired, or for an address that has since changed. */
export async function verify_email(token: string): Promise<boolean> {
	return await db.transaction(async (tx) => {
		const [row] = await tx.select().from(email_verifications_table)
			.where(and(eq(email_verifications_table.token_hash, hash_token(token)), isNull(email_verifications_table.used_at), gt(email_verifications_table.expires_at, new Date())))
			.for('update');
		if (!row) return false;
		await tx.update(email_verifications_table).set({ used_at: new Date() }).where(eq(email_verifications_table.id, row.id));
		const verified = await tx.update(users_table).set({ email_verified_at: new Date() })
			.where(and(eq(users_table.id, row.user_id), eq(users_table.email, row.email)))
			.returning({ id: users_table.id });
		return verified.length > 0;
	});
}
