import { beforeAll, describe, expect, it } from 'vitest';
import { api, contribute, create_user, mock_album, pool, unique } from './helpers';
import type { TestUser } from './helpers';

let user: TestUser;

beforeAll(async () => {
	user = await create_user('svc');
});

const ingest = (items: unknown[], token = user.access_token) => api('POST', '/ingest/service', { token, body: { items } });

describe('POST /ingest/service', () => {
	it('requires a token', async () => {
		expect((await api('POST', '/ingest/service', { body: { items: [] } })).status).toBe(401);
	});

	it('stores tracks, albums and artists and keeps earlier fields when a later sighting lacks them', async () => {
		const id = unique('dz');
		const first = await ingest([
			{ kind: 'track', service: 'deezer', id, title: 'Song', artist_names: ['A'], duration_ms: 1000, isrc: 'USRC17607839', raw: { v: 1 } },
			{ kind: 'album', service: 'deezer', id: `${id}-al`, title: 'Album', track_count: 3 },
			{ kind: 'artist', service: 'deezer', id: `${id}-ar`, name: 'A', verified: true }
		]);
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ accepted: 3, rejected: [] });
		await ingest([{ kind: 'track', service: 'deezer', id, title: 'Song (Remastered)', raw: { v: 2 } }]);
		const { rows } = await pool.query('select title, duration_ms, isrc, raw from service_tracks_table where service = $1 and external_id = $2', ['deezer', id]);
		expect(rows).toEqual([{ title: 'Song (Remastered)', duration_ms: 1000, isrc: 'USRC17607839', raw: { v: 2 } }]);
	});

	it('rejects bad items individually and refuses YouTube', async () => {
		const res = await ingest([{ kind: 'track', service: 'youtube', id: 'x', title: 'T' }, { kind: 'artist', service: 'tidal', id: '1', name: 'Ok' }]);
		expect(res.body.accepted).toBe(1);
		expect(res.body.rejected.map((r: { index: number }) => r.index)).toEqual([0]);
	});

	it('links rows to the global entity that shares the service id', async () => {
		const spotify_id = '4uLU6hMCjMI75M1A2tKUQC';
		const base = mock_album({ artist: unique('Svc Artist'), album: unique('Svc Album'), n: 1 });
		(base.tracks[0] as { service_ids?: Record<string, string> }).service_ids = { spotify_id };
		const refs = (await contribute(user, base)).body.refs;
		await ingest([{ kind: 'track', service: 'spotify', id: spotify_id, title: 'Linked' }]);
		const { rows } = await pool.query('select illusi_id from service_tracks_table where service = $1 and external_id = $2', ['spotify', spotify_id]);
		expect(rows[0].illusi_id).toBe(refs.t0);
	});
});
