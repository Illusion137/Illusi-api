import { afterAll, describe, expect, it } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
afterAll(async () => { await app.stop(); });
const { contribute, create_user, mock_album, query, unique } = await import('./helpers');

const kinds = (res: { body: { conflicts?: { kind: string }[] } }) => (res.body.conflicts ?? []).map(c => c.kind);

describe('contribute edge cases (in-process)', () => {
	it('links an entity matched by several ids to the other holders', async () => {
		const user = await create_user('multi-id');
		const one = await contribute(user, mock_album({ artist: unique('Multi One'), album: unique('Multi Album One'), n: 1 }));
		const two = await contribute(user, mock_album({ artist: unique('Multi Two'), album: unique('Multi Album Two'), n: 1 }));
		const apple = String(1_500_000_000 + Math.floor(Math.random() * 99_999_999));
		await query('update service_ids_table set applemusic_id = $1 where illusi_id = $2', [apple, two.body.refs.t0]);
		const [first] = await query('select spotify_id from service_ids_table where illusi_id = $1', [one.body.refs.t0]);
		const res = await contribute(user, { tracks: [{ ref: 'x', title: 'Whatever', service_ids: { spotify_id: first.spotify_id, applemusic_id: apple } }] });
		expect(res.status).toBe(200);
		expect(kinds(res)).toContain('service_id_multiple');
	});

	it('links an entity matched by metadata to every other strong candidate', async () => {
		const user = await create_user('multi-meta');
		const created = await contribute(user, mock_album({ artist: unique('Meta Artist'), album: unique('Meta Album'), n: 1 }));
		const artist_id = created.body.refs.ar as string;
		const title = unique('Twin Song');
		for (let i = 0; i < 2; i++) {
			const [{ illusi_id }] = await query('insert into service_ids_table default values returning illusi_id');
			await query('insert into tracks_table (id, title, duration_ms) values ($1, $2, 200000)', [illusi_id, title]);
			await query('insert into tracks_artists_table (track_id, artist_id) values ($1, $2)', [illusi_id, artist_id]);
		}
		const res = await contribute(user, {
			tracks: [{ ref: 't', title, duration_ms: 200_000 }],
			relations: { tracks_artists: [{ track_ref: 't', artist_ref: artist_id }] }
		});
		expect(res.status).toBe(200);
		expect(kinds(res)).toContain('metadata_multiple');
	});

	it('rejects a relation row the database refuses, row by row', async () => {
		const user = await create_user('rel-fail');
		const marker = unique('refused').replace(/-/gu, '_');
		await query(`create or replace function pg_temp_refuse() returns trigger language plpgsql as $$ begin
			if exists (select 1 from tracks_table where id = new.track_id and title like '${marker}%') then raise exception 'refused by test'; end if; return new; end $$`);
		await query('create trigger refuse_relation_test before insert on tracks_artists_table for each row execute function pg_temp_refuse()');
		try {
			const res = await contribute(user, {
				artists: [{ ref: 'a', name: unique('Refuse Artist') }],
				tracks: [{ ref: 'ok', title: unique('fine') }, { ref: 'no', title: `${marker} track` }],
				relations: { tracks_artists: [{ track_ref: 'ok', artist_ref: 'a' }, { track_ref: 'no', artist_ref: 'a' }] }
			});
			expect(res.status).toBe(200);
			expect(res.body.rejected).toEqual([expect.objectContaining({ kind: 'tracks_artists', index: 1, reason: 'could not be applied' })]);
		} finally {
			await query('drop trigger refuse_relation_test on tracks_artists_table');
			await query('drop function pg_temp_refuse()');
		}
	});

	it('answers a concurrent retry of the same contribution with the stored response', async () => {
		const user = await create_user('contrib-twin');
		const contribution_id = crypto.randomUUID();
		const graph = mock_album({ artist: unique('Twin Artist'), album: unique('Twin Album'), n: 1 });
		const [a, b] = await Promise.all([contribute(user, graph, contribution_id), contribute(user, graph, contribution_id)]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(a.body.refs).toEqual(b.body.refs);
	});

	it('rejects what cannot be applied and relations that reference a rejected entity', async () => {
		const user = await create_user('rej');
		const res = await contribute(user, {
			artists: [{ ref: 'a', name: 'ok' }],
			tracks: [{ ref: 't', title: 'T', duration_ms: 1_000, service_ids: { isrc: 'US0000000001' } }, { ref: 'bad', title: '\u0000bad' }],
			relations: { tracks_artists: [{ track_ref: 'bad', artist_ref: 'a' }, { track_ref: 't', artist_ref: 'a' }] }
		});
		expect(res.body.rejected.map((r: { reason: string }) => r.reason).sort()).toEqual(['could not be applied', 'references an entity that was not applied']);
	});
});
