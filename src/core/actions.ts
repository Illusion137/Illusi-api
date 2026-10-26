import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config';
import type { Tx } from '../db';
import { action_token_uses_table } from '../db/schema';
import { is_session_live } from './auth/sessions';
import type { AuthUser } from './auth/tokens';
import { HttpError } from './http';
import { logger } from './log';

const log = logger('actions');

/** Client actions. Add new members here; clients ignore unknown `type`s. */
export type ActionBody
	= | { type: 'CHECK_GENIUS'; track_id: string; query: string }
		| { type: 'CHECK_YOUTUBE_MUSIC'; track_id: string; query: string; youtube_id?: string }
		| { type: 'UPLOAD_MEDIA'; track_id: string }
		| { type: 'FETCH_NEW_RELEASES'; artist_id: string; service: string; service_artist_id: string; since: string }
		| { type: 'RESEARCH_TRACK'; track_id: string; service: string; query: string; title: string; artists: string[]; duration_ms: number | null };

export type ActionType = { token: string } & ActionBody;
export type ActionKind = ActionBody['type'];

export interface ActionResponse { actions: ActionType[] }

const action_key = new TextEncoder().encode(config.ACTION_TOKEN_SECRET);

function target_of(action: ActionBody): string {
	if (action.type === 'FETCH_NEW_RELEASES') return release_check_target(action.service, action.artist_id);
	if (action.type === 'RESEARCH_TRACK') return research_target(action.service, action.track_id);
	return action.track_id;
}

/** The token target of a RESEARCH_TRACK action: one track on one service. */
export function research_target(service: string, track_id: string): string {
	return `${service}:${track_id}`;
}

/** The token target of a FETCH_NEW_RELEASES action: one artist on one service. */
export function release_check_target(service: string, artist_id: string): string {
	return `${service}:${artist_id}`;
}

/** Signs an action for `user`: binds user, session, type, target, iat/exp and a single-use jti. */
export async function issue_action(user: AuthUser, action: ActionBody): Promise<ActionType> {
	const token = await new SignJWT({ typ: action.type, tgt: target_of(action), sid: user.sid })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(user.id)
		.setJti(randomUUID())
		.setIssuedAt()
		.setExpirationTime(`${config.ACTION_TOKEN_TTL_S}s`)
		.sign(action_key);
	return { ...action, token };
}

export async function issue_actions(user: AuthUser, actions: ActionBody[]): Promise<ActionType[]> {
	return Promise.all(actions.map(a => issue_action(user, a)));
}

export interface ConsumedAction { jti: string; user_id: string; type: ActionKind; target: string }

/**
 * Runs every check and marks the jti used, inside the caller's transaction so a later failure
 * rolls the use back too. Throws 401/403 if anything fails; the caller must then store nothing.
 */
export async function consume_action_token(tx: Tx, user: AuthUser, token: string, expected_type: ActionKind, target: string): Promise<ConsumedAction> {
	let payload;
	try {
		({ payload } = await jwtVerify(token, action_key, { algorithms: ['HS256'] }));
	} catch {
		throw new HttpError(401, 'invalid or expired action token');
	}
	const { sub, typ, tgt, sid, jti, exp } = payload as { sub?: string; typ?: string; tgt?: string; sid?: string; jti?: string; exp?: number };
	if (!sub || !typ || !tgt || !sid || !jti || !exp) throw new HttpError(401, 'malformed action token');
	if (sub !== user.id) throw new HttpError(403, 'action token issued to another user');
	if (typ !== expected_type) throw new HttpError(403, 'action token type mismatch');
	if (tgt !== target) throw new HttpError(403, 'action token target mismatch');
	if (!(await is_session_live(tx, sid))) throw new HttpError(401, 'action token session revoked');

	const inserted = await tx.insert(action_token_uses_table)
		.values({ jti, user_id: sub, type: typ, target: tgt, expires_at: new Date(exp * 1000) })
		.onConflictDoNothing()
		.returning({ jti: action_token_uses_table.jti });
	if (inserted.length === 0) throw new HttpError(403, 'action token already used');

	log.info(`action ${typ} fulfilled`, { user_id: sub, target: tgt, jti });
	return { jti, user_id: sub, type: typ, target: tgt };
}

/** Attaches `actions` next to a response's normal data, only when there are any. */
export function with_actions<T extends object>(data: T, actions: readonly ActionType[]): T & Partial<ActionResponse> {
	return actions.length > 0 ? { ...data, actions: [...actions] } : data;
}
