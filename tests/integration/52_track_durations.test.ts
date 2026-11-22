import { beforeAll, describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, query, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

let users: TestUser[];
let track_id: string;

const report = (user: TestUser, id: string, body: unknown) => api('POST', `/tracks/${id}/duration`, { token: user.access_token, body });

beforeAll(async () => {
	users = await Promise.all([1, 2, 3, 4, 5].map(i => create_user(`dur${i}`)));
	const created = await contribute(users[0], { tracks: [{ ref: 't', title: unique('Duration Track') }] });
	track_id = created.body.refs.t;
	// Only established accounts with the track in their library count toward consensus
	await query(`update users_table set created_at = now() - interval '30 days' where id = any($1)`, [users.map(u => u.id)]);
	for (const user of users) await add_to_library(user, [track_id]);
});

describe('POST /tracks/:id/duration', () => {
	it('fills a missing duration and bumps modified_at so clients pull it', async () => {
		const [before] = await query('select duration_ms, modified_at from tracks_table where id = $1', [track_id]);
		expect(before.duration_ms).toBeNull();
		const res = await report(users[0], track_id, { duration_ms: 200_000, source: 'download', service: 'youtube' });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ track_id, duration_ms: 200_000, outcome: 'filled' });
		const [after] = await query('select duration_ms, modified_at from tracks_table where id = $1', [track_id]);
		expect(Number(after.duration_ms)).toBe(200_000);
		expect(after.modified_at.getTime()).toBeGreaterThan(before.modified_at.getTime());
	});

	it('confirms a measurement within tolerance without changing anything', async () => {
		const res = await report(users[1], track_id, { duration_ms: 201_500, source: 'service' });
		expect(res.body).toMatchObject({ duration_ms: 200_000, outcome: 'confirmed' });
	});

	it('sends a lone disagreement to review', async () => {
		const res = await report(users[2], track_id, { duration_ms: 260_000, source: 'download' });
		expect(res.body).toMatchObject({ duration_ms: 200_000, outcome: 'disputed' });
		const items = await query(`select status, proposed_values from review_items_table where entity_id = $1 and field = 'duration_ms'`, [track_id]);
		expect(items).toHaveLength(1);
		expect(items[0].status).toBe('OPEN');
	});

	it('keeps one report per user', async () => {
		await report(users[2], track_id, { duration_ms: 260_500, source: 'download' });
		const rows = await query('select duration_ms from track_duration_reports_table where track_id = $1 and user_id = $2', [track_id, users[2].id]);
		expect(rows).toEqual([{ duration_ms: 260_500 }]);
	});

	it('replaces the duration once enough users agree, closing the review item', async () => {
		expect((await report(users[3], track_id, { duration_ms: 259_000, source: 'download' })).body.outcome).toBe('disputed');
		const res = await report(users[4], track_id, { duration_ms: 261_000, source: 'download' });
		// Three agree (260.5 s, 259 s, 261 s) against two backing 200 s: the median wins.
		expect(res.body).toMatchObject({ duration_ms: 260_500, outcome: 'corrected' });
		expect(Number((await query('select duration_ms from tracks_table where id = $1', [track_id]))[0].duration_ms)).toBe(260_500);
		expect((await query(`select status from review_items_table where entity_id = $1 and field = 'duration_ms'`, [track_id]))[0].status).toBe('APPLIED');
		const [audit] = await query(`select * from audit_log_table where action = 'duration_consensus' and entity_id = $1`, [track_id]);
		expect(audit.undo).toMatchObject({ values: { duration_ms: 200_000 } });
		// The old value's backers now disagree; they alone can't flip it back.
		expect((await report(users[0], track_id, { duration_ms: 200_000, source: 'download' })).body.outcome).toBe('disputed');
	});

	it('does not let new accounts or ones without the track outvote established users', async () => {
		const created = await contribute(users[0], { tracks: [{ ref: 't', title: unique('Sybil Track') }] });
		const id: string = created.body.refs.t;
		await add_to_library(users[0], [id]);
		expect((await report(users[0], id, { duration_ms: 200_000, source: 'download' })).body.outcome).toBe('filled');
		const fresh = await Promise.all([1, 2, 3].map(i => create_user(`sybil${i}`)));
		for (const user of fresh) await add_to_library(user, [id]);
		const strangers = await Promise.all([1, 2, 3].map(i => create_user(`stranger${i}`)));
		await query(`update users_table set created_at = now() - interval '30 days' where id = any($1)`, [strangers.map(u => u.id)]);
		for (const user of [...fresh, ...strangers]) expect((await report(user, id, { duration_ms: 320_000, source: 'download' })).body.outcome).toBe('disputed');
		expect(Number((await query('select duration_ms from tracks_table where id = $1', [id]))[0].duration_ms)).toBe(200_000);
	});

	it('rejects bad requests', async () => {
		expect((await api('POST', `/tracks/${track_id}/duration`, { body: { duration_ms: 200_000, source: 'download' } })).status).toBe(401);
		expect((await report(users[0], 'nope', { duration_ms: 200_000, source: 'download' })).status).toBe(400);
		expect((await report(users[0], uuid(), { duration_ms: 200_000, source: 'download' })).status).toBe(404);
		for (const body of [{}, { duration_ms: 500, source: 'download' }, { duration_ms: 200_000, source: 'guess' }, { duration_ms: 1.5e3 + 0.5, source: 'download' }]) {
			expect((await report(users[0], track_id, body)).status).toBe(400);
		}
	});
});
