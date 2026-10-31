import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, query, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

async function seed_album(user: TestUser, n = 3) {
	const graph = mock_album({ artist: unique('Perf Artist'), album: unique('Perf Album'), n });
	const res = await contribute(user, graph);
	expect(res.status).toBe(200);
	const refs: Record<string, string> = res.body.refs;
	return { artist_id: refs.ar, track_ids: graph.tracks.map(t => refs[t.ref]) };
}

async function play(user: TestUser, track_ids: string[]) {
	const changes = { track_plays: track_ids.map(track_id => ({ client_id: uuid(), track_id, created_at: new Date().toISOString() })) };
	const res = await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes } });
	expect(res.status).toBe(200);
}

async function counts(track_ids: string[]): Promise<number[]> {
	const rows = await query<{ track_id: string; plays: string }>(`select track_id, plays from track_play_counts_table where track_id = any($1)`, [track_ids]);
	const by_id = new Map(rows.map(r => [r.track_id, Number(r.plays)]));
	return track_ids.map(id => by_id.get(id) ?? 0);
}

describe('stored play totals', () => {
	it('follow inserts, deletes and merges, and order artist tracks by popularity', async () => {
		const a = await create_user('perf-a');
		const b = await create_user('perf-b');
		const { artist_id, track_ids: [t0, t1, t2] } = await seed_album(a);
		await add_to_library(a, [t0, t1, t2]);
		await add_to_library(b, [t0, t1, t2]);

		await play(a, [t1, t1, t2]);
		await play(b, [t1]);
		expect(await counts([t0, t1, t2])).toEqual([0, 3, 1]);
		const popular = await api('GET', `/artists/${artist_id}/tracks?sort=popular`, { token: a.access_token });
		expect(popular.body.items.map((t: { id: string }) => t.id)).toEqual([t1, t2, t0]);

		await query(`delete from track_plays_table where id = (select min(id) from track_plays_table where track_id = $1)`, [t1]);
		expect(await counts([t0, t1, t2])).toEqual([0, 2, 1]);

		// A merge repoints plays with an UPDATE of track_id.
		await query(`update track_plays_table set track_id = $1 where track_id = $2`, [t0, t1]);
		expect(await counts([t0, t1, t2])).toEqual([2, 0, 1]);
		expect(await query(`select (select count(*) from track_plays_table where track_id = $1)::int as n`, [t0])).toEqual([{ n: 2 }]);
	});
});

describe('catalog validators', () => {
	it('answers 304 while nothing changed, and a fresh response once the caller\'s library changes', async () => {
		const user = await create_user('perf-etag');
		const { track_ids: [t0] } = await seed_album(user, 1);
		const first = await api('GET', `/tracks/${t0}`, { token: user.access_token });
		expect(first.status).toBe(200);
		expect(first.headers.get('cache-control')).toBe('private, max-age=60');
		const etag = first.headers.get('etag')!;
		expect(etag).toMatch(/^W\//u);

		const again = await api('GET', `/tracks/${t0}`, { token: user.access_token, headers: { 'if-none-match': etag } });
		expect(again.status).toBe(304);
		expect(again.text).toBe('');

		// Another user sees their own overlay, so never the same validator.
		const other = await create_user('perf-etag-other');
		const theirs = await api('GET', `/tracks/${t0}`, { token: other.access_token, headers: { 'if-none-match': etag } });
		expect(theirs.status).toBe(200);

		await add_to_library(user, [t0]);
		const changed = await api('GET', `/tracks/${t0}`, { token: user.access_token, headers: { 'if-none-match': etag } });
		expect(changed.status).toBe(200);
		expect(changed.body.user).not.toBeNull();
		expect(changed.headers.get('etag')).not.toBe(etag);
	});

	it('moves the catalog version once per committed transaction', async () => {
		const [{ version: before }] = await query<{ version: string }>(`select version from read_versions_table where key = 'catalog'`);
		const user = await create_user('perf-version');
		await seed_album(user, 2);
		const [{ version: after }] = await query<{ version: string }>(`select version from read_versions_table where key = 'catalog'`);
		expect(Number(after)).toBeGreaterThan(Number(before));
		// One contribution is one transaction over many rows: it bumps the counter once, not per row.
		expect(Number(after) - Number(before)).toBeLessThan(5);
	});
});
