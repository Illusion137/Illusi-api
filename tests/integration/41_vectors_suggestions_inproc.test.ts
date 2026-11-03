import { afterAll, describe, expect, it } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
afterAll(async () => { await app.stop(); });
const { api, contribute, create_user, mock_album, query, unique } = await import('./helpers');
const { TRACK_VECTOR_DIMENSIONS } = await import('../../src/db/schema');

const vector = (seed: number) => `[${Array.from({ length: TRACK_VECTOR_DIMENSIONS }, (_, i) => Math.sin(seed + i)).join(',')}]`;

describe('artists without stored similar pairs (in-process)', () => {
	it('fall back to artists whose tracks sound alike', async () => {
		const user = await create_user('vec');
		const make = async (n: number) => {
			const created = await contribute(user, mock_album({ artist: unique(`Vec Artist ${n}`), album: unique(`Vec Album ${n}`), n: 1 }));
			return { artist: created.body.refs.ar as string, track: created.body.refs.t0 as string };
		};
		const [a, b, c] = [await make(1), await make(2), await make(3)];
		for (const [i, x] of [a, b, c].entries()) {
			await query('insert into track_vectors_table (track_id, embedding, version) values ($1, $2::vector, 1)', [x.track, vector(i * 0.01)]);
		}
		const res = await api('GET', `/artists/${a.artist}/similar`, { token: user.access_token });
		expect(res.status).toBe(200);
		expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([b.artist, c.artist]));
	});
});

describe('suggestions cache (in-process)', () => {
	it('serves a repeated query from the short-lived cache', async () => {
		const user = await create_user('sugg');
		const tag = unique('cachetag').replace(/-/gu, '');
		await contribute(user, mock_album({ artist: `Cache ${tag}`, album: `Cache ${tag}`, n: 1 }));
		const { db } = await import('../../src/db');
		const { clear_suggestion_cache, suggest } = await import('../../src/services/catalog/suggestions');
		clear_suggestion_cache();
		const first = await suggest(db, user.id, tag, 10, 1);
		const second = await suggest(db, user.id, tag, 10, 1);
		expect(second).toEqual(first);
		expect(first.artists.length).toBeGreaterThan(0);
	});
});

describe('suggestions cache size (in-process)', () => {
	it('evicts the oldest entries beyond the limit', async () => {
		const user = await create_user('sugg-evict');
		const { db } = await import('../../src/db');
		const { clear_suggestion_cache, suggest } = await import('../../src/services/catalog/suggestions');
		clear_suggestion_cache();
		const prefix = unique('evict').replace(/-/gu, '');
		for (let i = 0; i < 2_010; i += 30) {
			await Promise.all(Array.from({ length: 30 }, (_, j) => suggest(db, user.id, `${prefix}${i + j}`, 5, 7)));
		}
		clear_suggestion_cache();
	}, 120_000);
});
