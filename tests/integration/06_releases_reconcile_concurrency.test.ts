import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, days_ago, mock_album, query, run_script, unique, uuid } from './helpers';

describe('new releases (§15)', () => {
	it('lists the last 7 days globally and per library, and hands out FETCH_NEW_RELEASES actions', async () => {
		const fan = await create_user('releases');
		const stranger = await create_user('releases-other');
		const followed = mock_album({ artist: unique('Followed Artist'), album: unique('Fresh Single'), n: 1, album_type: 'SINGLE', release_date: days_ago(2) });
		const created = await contribute(fan, followed);
		const artist_id = created.body.refs.ar;
		// An older album by the same artist gives the fan a library track without being new itself.
		const old_album = await contribute(fan, {
			albums: [{ ref: 'old', name: unique('Old Album'), artist_ref: artist_id, album_type: 'ALBUM', release_date: days_ago(40).toISOString() }],
			tracks: [{ ref: 'ot', title: unique('Old Song'), album_ref: 'old', duration_ms: 200_000 }],
			relations: { tracks_artists: [{ track_ref: 'ot', artist_ref: artist_id }] }
		});
		await add_to_library(fan, [old_album.body.refs.ot]);
		const unrelated = await contribute(stranger, mock_album({ artist: unique('Unfollowed Artist'), album: unique('Fresh EP'), n: 1, album_type: 'EP', release_date: days_ago(1) }));
		await contribute(stranger, mock_album({ artist: unique('Future Artist'), album: unique('Not Out Yet'), n: 1, release_date: days_ago(-5) }));

		const all = await api('GET', '/new-releases?limit=500', { token: fan.access_token });
		expect(all.status).toBe(200);
		const all_ids = all.body.albums.map((a: { id: string }) => a.id);
		expect(all_ids).toEqual(expect.arrayContaining([created.body.refs.al, unrelated.body.refs.al]));
		expect(all_ids).not.toContain(old_album.body.refs.old);
		expect(all.body.albums.every((a: { release_date: string }) => new Date(a.release_date) <= new Date())).toBe(true);
		expect(all.body.actions).toBeUndefined();

		const mine = await api('GET', '/new-releases/me?services=spotify,deezer', { token: fan.access_token });
		expect(mine.body.albums.map((a: { id: string }) => a.id)).toEqual([created.body.refs.al]);
		expect(mine.body.albums[0]).toMatchObject({ album_type: 'SINGLE', artists: [{ id: artist_id, name: followed.artists[0].name }], thumbnails: [expect.objectContaining({ width: 600 })] });
		// Only spotify: the artist has no deezer id.
		expect(mine.body.actions).toEqual([expect.objectContaining({ type: 'FETCH_NEW_RELEASES', service: 'spotify', artist_id, service_artist_id: followed.artists[0].service_ids.spotify_id })]);
		// Handed out once; not again within the cooldown.
		expect((await api('GET', '/new-releases/me?services=spotify', { token: fan.access_token })).body.actions).toBeUndefined();

		// Fulfil: the client found a brand-new album, plus something by another artist that must be dropped.
		const action = mine.body.actions[0];
		const fresh = unique('Surprise Drop');
		const res = await api('POST', '/ingest/new_releases', {
			token: fan.access_token,
			body: {
				token: action.token, artist_id, service: 'spotify',
				releases: {
					albums: [
						{ ref: 'n', name: fresh, artist_ref: artist_id, album_type: 'ALBUM', release_date: days_ago(0.5).toISOString() },
						{ ref: 'x', name: unique('Someone Else'), artist_ref: 'stranger', release_date: days_ago(0.5).toISOString() }
					],
					artists: [{ ref: 'stranger', name: unique('Stranger') }],
					tracks: [{ ref: 'nt', title: `${fresh} Intro`, album_ref: 'n', duration_ms: 95_000 }],
					relations: { tracks_artists: [{ track_ref: 'nt', artist_ref: artist_id }] }
				}
			}
		});
		expect(res.status).toBe(200);
		expect(Object.keys(res.body.refs).sort()).toEqual(['n', 'nt']);
		expect(res.body.rejected.map((r: { ref?: string }) => r.ref).sort()).toEqual(['stranger', 'x']);
		expect((await api('POST', '/ingest/new_releases', { token: fan.access_token, body: { token: action.token, artist_id, service: 'spotify' } })).status).toBe(403);
		const [check] = await query(`select checked_by from artist_release_checks_table where artist_id = $1 and service = 'spotify'`, [artist_id]);
		expect(check.checked_by).toBe(fan.id);

		const after = await api('GET', '/new-releases/me', { token: fan.access_token });
		expect(after.body.albums.map((a: { name: string }) => a.name)).toContain(fresh);
	});

	it('includes SoundCloud uploads from uploaders followed through the library', async () => {
		const fan = await create_user('sc-releases');
		const base = 720_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
		const uploader = { kind: 'user', id: base, permalink: unique('scr'), username: 'Uploader', last_modified: new Date().toISOString() };
		const old = { kind: 'track', id: base + 1, title: 'Old upload', user: uploader, created_at: days_ago(60).toISOString(), last_modified: days_ago(60).toISOString(), sharing: 'public', public: true };
		const fresh = { kind: 'track', id: base + 2, title: 'Fresh upload', user: uploader, created_at: days_ago(1).toISOString(), last_modified: days_ago(1).toISOString(), sharing: 'public', public: true };
		const hidden = { kind: 'track', id: base + 3, title: 'Private upload', user: uploader, created_at: days_ago(1).toISOString(), last_modified: days_ago(1).toISOString(), sharing: 'private', public: false };
		await api('POST', '/ingest/soundcloud', { token: fan.access_token, body: { items: [old, fresh, hidden] } });
		// The fan's library holds the old upload (linked to an Illusi track by soundcloud_id).
		const linked = await contribute(fan, { tracks: [{ ref: 't', title: 'Old upload', duration_ms: 100_000, service_ids: { soundcloud_id: base + 1 } }] });
		await add_to_library(fan, [linked.body.refs.t]);

		await new Promise(r => setTimeout(r, 500));
		const mine = await api('GET', '/new-releases/me', { token: fan.access_token });
		expect(mine.body.soundcloud_tracks.map((t: { id: number }) => Number(t.id))).toEqual([base + 2]);
		const someone = await create_user('sc-releases-other');
		expect((await api('GET', '/new-releases/me', { token: someone.access_token })).body.soundcloud_tracks).toEqual([]);
	});
});

describe('reconciliation worker (§4.5)', () => {
	it('merges duplicates with the same ISRC and close durations, keeping user data and leaving a redirect', async () => {
		const user = await create_user('reconcile');
		const isrc = `QZ${unique('x').slice(-3).toUpperCase()}${String(Math.floor(Math.random() * 9_999_999)).padStart(7, '0')}`;
		const title = unique('Dup Song');
		const [a, b] = [uuid(), uuid()];
		// Simulates two rows that slipped in before matching existed (e.g. a legacy import).
		await query(`insert into service_ids_table (illusi_id, isrc, spotify_id, created_at) values ($1, $3, $4, now() - interval '1 day'), ($2, $3, null, now())`, [a, b, isrc, `sp${uuid().replace(/-/gu, '').slice(0, 20)}`]);
		await query(`insert into tracks_table (id, title, duration_ms) values ($1, $3, 200000), ($2, $3, 201500)`, [a, b, title]);
		await add_to_library(user, [a, b]);
		const now = new Date().toISOString();
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: { track_plays: [{ client_id: uuid(), track_id: b, created_at: now }] } } });

		const run = await run_script(['src/worker/reconcile.ts', '--once', '--full']);
		expect(run.code).toBe(0);

		const redirects = await query(`select old_id, new_id from illusi_id_redirects_table where old_id in ($1, $2)`, [a, b]);
		expect(redirects).toHaveLength(1);
		const { old_id, new_id } = redirects[0];
		expect(await query(`select id from tracks_table where id in ($1, $2)`, [a, b])).toEqual([{ id: new_id }]);
		// Library rows collapsed into one, the play moved, and the survivor has both rows' ids.
		expect(await query(`select track_id from user_tracks_table where user_id = $1`, [user.id])).toEqual([{ track_id: new_id }]);
		expect(await query(`select track_id from track_plays_table where user_id = $1`, [user.id])).toEqual([{ track_id: new_id }]);
		expect((await query(`select spotify_id from service_ids_table where illusi_id = $1`, [new_id]))[0].spotify_id).not.toBeNull();
		expect((await query(`select count(*)::int as n from audit_log_table where entity_id in ($1, $2)`, [old_id, new_id]))[0].n).toBeGreaterThan(0);

		// Old ids keep working through the API, and pull tells the client to rewrite them.
		const lyrics = await api('GET', `/tracks/${old_id}/lyrics`, { token: user.access_token });
		expect(lyrics.status).toBe(200);
		expect(lyrics.body.track_id).toBe(new_id);
		await new Promise(r => setTimeout(r, 2_200));
		const pull = await api('POST', '/sync/pull', { token: user.access_token, body: {} });
		expect(pull.body.redirects).toEqual(expect.arrayContaining([{ old_id, new_id }]));
	});

	it('dry run reports without writing', async () => {
		const run = await run_script(['src/worker/reconcile.ts', '--once', '--full', '--dry-run']);
		expect(run.code).toBe(0);
	});
});

describe('concurrency', () => {
	it('many users contributing the same new album at once create it exactly once', async () => {
		const users = await Promise.all(Array.from({ length: 8 }, (_, i) => create_user(`race${i}`)));
		const graph = mock_album({ artist: unique('Race Artist'), album: unique('Race Album'), n: 4 });
		const results = await Promise.all(users.map(u => contribute(u, graph)));
		const statuses = results.map(r => r.status);
		expect(statuses.filter(s => s === 200).length).toBeGreaterThan(0);
		expect(statuses.every(s => s === 200)).toBe(true);
		const ok = results.filter(r => r.status === 200);
		// Losers of the creation race re-match onto the winner: same ids for everyone, nothing rejected.
		for (const ref of ['ar', 'al', 't0', 't1', 't2', 't3']) expect(new Set(ok.map(r => r.body.refs[ref])).size).toBe(1);
		expect(ok.flatMap(r => r.body.rejected)).toEqual([]);
		expect(await query(`select count(*)::int as n from albums_table where name = $1`, [graph.albums[0].name])).toEqual([{ n: 1 }]);
		expect(await query(`select count(*)::int as n from tracks_table t join album_tracks_table at on at.track_id = t.id join albums_table al on al.id = at.album_id where al.name = $1`, [graph.albums[0].name])).toEqual([{ n: 4 }]);
	});

	it('parallel pushes from several devices of one user all apply', async () => {
		const user = await create_user('devices');
		const created = await contribute(user, mock_album({ artist: unique('Device Artist'), album: unique('Device Album'), n: 6 }));
		const ids = Object.entries(created.body.refs).filter(([k]) => k.startsWith('t')).map(([, v]) => v as string);
		const results = await Promise.all(ids.map(track_id => add_to_library(user, [track_id]).then(r => r.status, () => 500)));
		expect(results.every(s => s === 200)).toBe(true);
		expect((await query(`select count(*)::int as n from user_tracks_table where user_id = $1`, [user.id]))[0].n).toBe(6);
	});
});
