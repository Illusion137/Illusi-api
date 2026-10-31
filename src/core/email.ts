import { config } from '../config';
import { logger } from './log';

const log = logger('email');

export interface Email { to: string; subject: string; text: string; html: string }

const SEND_TIMEOUT_MS = 10_000;

/** Sends through Resend. Without RESEND_API_KEY nothing leaves the process (development and CI). */
export async function send_email(email: Email): Promise<void> {
	if (!config.RESEND_API_KEY) {
		if (config.NODE_ENV === 'production') log.warn(`RESEND_API_KEY is not set; not sending "${email.subject}"`);
		else log.info(`email to ${email.to}: ${email.subject}\n${email.text}`);
		return;
	}
	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: { 'authorization': `Bearer ${config.RESEND_API_KEY}`, 'content-type': 'application/json' },
		body: JSON.stringify({ from: config.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`resend responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
