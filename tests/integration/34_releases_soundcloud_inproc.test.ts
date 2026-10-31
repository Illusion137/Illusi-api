import { randomInt } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
const { add_to_library, api, contribute, create_user, days_ago, mock_album, query, unique, uuid } = await import('./helpers');
const { ingest_batch, is_transcoding_stale, enqueue_batch } = await import('../../src/services/soundcloud/ingest');
const { flatten_items, unwrap_items } = await import('../../src/services/soundcloud');
const { config } = await import('../../src/config');

afterAll(async () => { await app.stop(); });

const sc_base = () => 730_000_000 + randomInt(0, 1_000_000) * 10;
const sc_user = (id: number, permalink: string, extra: object = {}) => ({ kind: 'user', id, permalink, username: permalink, followers_count: 10, last_modified: '2026-01-01T00:00:00Z', ...extra });
const transcoding = (id: number, n: number) => ({ url: `https://api-v2.soundcloud.com/media/${id}/${n}/stream/hls`, preset: 'mp3_0_0', duration: 1000, snipped: false, format: { protocol: 'hls', mime_type: 'audio/mpeg' }, quality: 'sq' });
const sc_track = (id: number, user: object, extra: object = {}) => ({
	kind: 'track', id, title: `SC Track ${id}`, user, duration: 120_000, permalink: `track-${id}`, permalink_url: `https://soundcloud.com/up/track-${id}`,
	created_at: '2026-01-01T00:00:00Z', last_modified: '2026-01-01T00:00:00Z', ...extra
});
const batch_of = (items: unknown[]) => flatten_items(unwrap_items(items)).batch;

async function create_user_with_session(name: string) {
	return create_user(name);
}

describe('soundcloud ingest writes', () => {
	it('replaces a track\'s transcodings with the latest full set and reports staleness', async () => {
		const user = await create_user_with_session('sc-trans');
		const base = sc_base();
		const uploader = sc_user(base, unique('trans'));
		await ingest_batch(user.id, batch_of([sc_track(base + 1, uploader, { media: { transcodings: [transcoding(base, 1), transcoding(base, 2)] } })]));
		expect(await query(`select url from soundcloud_transcodings_table where track_id = $1`, [base + 1])).toHaveLength(2);
		await ingest_batch(user.id, batch_of([sc_track(base + 1, uploader, { media: { transcodings: [transcoding(base, 1)] } })]));
		expect(await query(`select url from soundcloud_transcodings_table where track_id = $1`, [base + 1])).toHaveLength(1);
		// A track without a media block leaves them alone.
		await ingest_batch(user.id, batch_of([sc_track(base + 1, uploader)]));
		expect(await query(`select url from soundcloud_transcodings_table where track_id = $1`, [base + 1])).toHaveLength(1);

		expect(is_transcoding_stale(null)).toBe(true);
		expect(is_transcoding_stale('garbage')).toBe(true);
		expect(is_transcoding_stale(new Date())).toBe(false);
		expect(is_transcoding_stale(new Date(Date.now() - (config.SC_TRANSCODING_STALE_AFTER_HOURS + 1) * 3_600_000))).toBe(true);
	});

	it('suffixes the permalink of a renamed user when another user takes it, and nulls unknown uploaders', async () => {
		const user = await create_user_with_session('sc-rename');
		const base = sc_base();
		const permalink = unique('taken');
		await ingest_batch(user.id, batch_of([sc_user(base, permalink)]));
		await ingest_batch(user.id, batch_of([sc_user(base + 1, permalink)]));
		const rows = await query(`select id, permalink from soundcloud_users_table where id in ($1, $2) order by id`, [base, base + 1]);
		expect(rows[0].permalink).toBe(`${permalink}~${base}`);
		expect(rows[1].permalink).toBe(permalink);

		const ghost = sc_user(base + 5, unique('ghost'));
		await ingest_batch(user.id, flatten_items(unwrap_items([sc_track(base + 6, { kind: 'user', id: base + 5 })])).batch);
		expect(await query(`select user_id from soundcloud_tracks_table where id = $1`, [base + 6])).toEqual([{ user_id: null }]);
		await ingest_batch(user.id, batch_of([sc_track(base + 7, ghost)]));
		expect(await query(`select user_id from soundcloud_tracks_table where id = $1`, [base + 7])).toEqual([{ user_id: String(base + 5) }]);
	});

	it('replaces membership for complete playlists and only adds for partial ones', async () => {
		const user = await create_user_with_session('sc-playlist');
		const base = sc_base();
		const uploader = sc_user(base, unique('pl'));
		const tracks = [1, 2, 3].map(i => sc_track(base + i, uploader));
		const playlist = (members: number[], count: number) => ({ kind: 'playlist', id: base + 9, title: 'Set', user: uploader, track_count: count, tracks: members.map(id => ({ id })), last_modified: '2026-01-01T00:00:00Z' });
		const members = async () => (await query(`select track_id from soundcloud_playlist_tracks_table where playlist_id = $1 order by position, track_id`, [base + 9])).map(r => Number(r.track_id) - base).sort();
		await ingest_batch(user.id, batch_of([...tracks, playlist([base + 1, base + 2, base + 1], 3)]));
		expect(await members()).toEqual([1, 2]);
		await ingest_batch(user.id, batch_of([playlist([base + 3], 5)]));
		expect(await members()).toEqual([1, 2, 3]);
		await ingest_batch(user.id, batch_of([playlist([base + 3], 1)]));
		expect(await members()).toEqual([3]);
		await ingest_batch(user.id, batch_of([playlist([base + 400], 4)]));
		expect(await members()).toEqual([3]);
	});

	it('enriches Illusi entities linked by SoundCloud id with permalinks, ISRCs and artwork', async () => {
		const user = await create_user_with_session('sc-enrich');
		const base = sc_base();
		const track = await contribute(user, { tracks: [{ ref: 't', title: unique('Linked'), duration_ms: 100_000, service_ids: { soundcloud_id: base + 1 } }] });
		const track_id = track.body.refs.t as string;
		const album_id = uuid();
		const artist_id = uuid();
		await query(`insert into service_ids_table (illusi_id, soundcloud_id) values ($1, $3), ($2, $4)`, [album_id, artist_id, base + 2, base]);
		await query(`insert into albums_table (id, name) values ($1, $2)`, [album_id, unique('Linked Album')]);
		await query(`insert into artists_table (id, name) values ($1, $2)`, [artist_id, unique('Linked Artist')]);
		const orphan = await query<{ illusi_id: string }>(`insert into service_ids_table (soundcloud_id) values ($1) returning illusi_id`, [base + 3]);

		const uploader = sc_user(base, unique('enrich'), { avatar_url: `https://i1.sndcdn.com/avatars-${base}-large.jpg` });
		const permalink = `up/track-${base + 1}`;
		await ingest_batch(user.id, batch_of([
			uploader,
			sc_track(base + 1, uploader, { publisher_metadata: { isrc: 'USABC2600777' }, artwork_url: `https://i1.sndcdn.com/artworks-${base}-large.jpg` }),
			{ kind: 'playlist', id: base + 2, title: 'Set', permalink_url: `https://soundcloud.com/up/sets/set-${base}`, user: uploader, artwork_url: `https://i1.sndcdn.com/artworks-${base}-large.jpg`, tracks: [], track_count: 0, last_modified: '2026-01-01T00:00:00Z' },
			sc_track(base + 3, uploader)
		]));
		const [ids] = await query(`select soundcloud_permalink, isrc from service_ids_table where illusi_id = $1`, [track_id]);
		expect(ids).toEqual({ soundcloud_permalink: permalink, isrc: 'USABC2600777' });
		expect((await query(`select soundcloud_permalink from service_ids_table where illusi_id = $1`, [album_id]))[0].soundcloud_permalink).toBe(`up/sets/set-${base}`);
		expect((await query(`select count(*)::int as n from thumbnails_table where id = any($1)`, [[track_id, album_id, artist_id]]))[0].n).toBeGreaterThanOrEqual(3);
		// A SoundCloud id linked to a row without a matching entity is left alone.
		expect(await query(`select soundcloud_permalink from service_ids_table where illusi_id = $1`, [orphan[0].illusi_id])).toEqual([{ soundcloud_permalink: null }]);
	});

	it('processes queued batches in the background and survives a failing batch', async () => {
		const user = await create_user_with_session('sc-queue');
		const base = sc_base();
		const uploader = sc_user(base, unique('queue'));
		const good = (i: number) => batch_of([sc_track(base + i, uploader)]);
		for (let i = 1; i <= 4; i++) enqueue_batch(user.id, good(i));
		// A batch for a user that does not exist fails on provenance and is only logged.
		enqueue_batch(uuid(), good(9));
		await new Promise(r => setTimeout(r, 1_500));
		expect((await query(`select count(*)::int as n from soundcloud_tracks_table where id between $1 and $2`, [base + 1, base + 4]))[0].n).toBe(4);
	});
});

describe('soundcloud endpoint', () => {
	it('rejects malformed bodies and unauthenticated calls', async () => {
		const user = await create_user('sc-ep');
		expect((await api('POST', '/ingest/soundcloud', { body: { items: [] } })).status).toBe(401);
		expect((await api('POST', '/ingest/soundcloud', { token: user.access_token, body: { items: 'x' } })).status).toBe(400);
		const nested = await api('POST', '/ingest/soundcloud', { token: user.access_token, body: { items: [{ collection: Array.from({ length: 501 }, (_, i) => ({ kind: 'track', id: i + 1, title: 't' })) }] } });
		expect(nested.status).toBe(413);
		const none = await api('POST', '/ingest/soundcloud', { token: user.access_token, body: { items: [{ kind: 'mystery' }] } });
		expect(none.body).toEqual({ accepted: 0, rejected: 1 });
	});
});

describe('new releases endpoints', () => {
	it('validates the limit and defaults the window', async () => {
		const user = await create_user('rel-query');
		expect((await api('GET', '/new-releases?limit=0', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', '/new-releases?limit=501', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', '/new-releases/me?services=nonsense', { token: user.access_token })).body.actions).toBeUndefined();
		expect((await api('GET', '/new-releases')).status).toBe(401);
	});

	async function followed_soundcloud_artist(fan: Awaited<ReturnType<typeof create_user>>) {
		const base = sc_base();
		const created = await contribute(fan, mock_album({ artist: unique('SC Followed'), album: unique('SC Album'), n: 1, release_date: days_ago(30) }));
		const artist_id = created.body.refs.ar as string;
		await query(`update service_ids_table set soundcloud_id = $2 where illusi_id = $1`, [artist_id, base]);
		await add_to_library(fan, [created.body.refs.t0]);
		return { artist_id, base };
	}

	it('fulfils a SoundCloud check, keeping only the target uploader\'s objects', async () => {
		const fan = await create_user('rel-sc');
		const { artist_id, base } = await followed_soundcloud_artist(fan);
		const actions = (await api('GET', '/new-releases/me?services=soundcloud,spotify', { token: fan.access_token })).body.actions as { type: string; service: string; token: string; service_artist_id: string }[];
		const action = actions.find(a => a.service === 'soundcloud')!;
		expect(action.service_artist_id).toBe(String(base));
		const mine = sc_user(base, unique('mine'));
		const other = sc_user(base + 50, unique('other'));
		const res = await api('POST', '/ingest/new_releases', {
			token: fan.access_token,
			body: { token: action.token, artist_id, service: 'soundcloud', soundcloud_items: [mine, sc_track(base + 1, mine, { created_at: days_ago(1).toISOString() }), sc_track(base + 2, other), { kind: 'mystery' }] }
		});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ written: { users: 1, tracks: 1, playlists: 0 }, rejected: 1, dropped: 2 });
		expect(await query(`select id from soundcloud_tracks_table where id in ($1, $2)`, [base + 1, base + 2])).toEqual([{ id: String(base + 1) }]);
		expect((await query(`select checked_by from artist_release_checks_table where artist_id = $1 and service = 'soundcloud'`, [artist_id]))[0].checked_by).toBe(fan.id);
	});

	it('refuses a SoundCloud check for an artist without a SoundCloud id and rolls back', async () => {
		const fan = await create_user('rel-sc-409');
		const created = await contribute(fan, mock_album({ artist: unique('No SC'), album: unique('No SC Album'), n: 1 }));
		const artist_id = created.body.refs.ar as string;
		const { issue_action } = await import('../../src/core/actions');
		const sid = JSON.parse(Buffer.from(fan.access_token.split('.')[1], 'base64url').toString()).sid as string;
		const token = (await issue_action({ id: fan.id, role: 'USER', sid }, { type: 'FETCH_NEW_RELEASES', artist_id, service: 'soundcloud', service_artist_id: '1', since: new Date().toISOString() })).token;
		const res = await api('POST', '/ingest/new_releases', { token: fan.access_token, body: { token, artist_id, service: 'soundcloud', soundcloud_items: [] } });
		expect(res.status).toBe(409);
		expect(await query(`select 1 from artist_release_checks_table where artist_id = $1`, [artist_id])).toHaveLength(0);
	});

	it('validates fulfilment bodies', async () => {
		const fan = await create_user('rel-bad');
		const created = await contribute(fan, mock_album({ artist: unique('Bad Rel'), album: unique('Bad Rel Album'), n: 1 }));
		const artist_id = created.body.refs.ar as string;
		const post = (body: Record<string, unknown>) => api('POST', '/ingest/new_releases', { token: fan.access_token, body });
		expect((await post({ token: 'x', artist_id, service: 'napster' })).status).toBe(400);
		expect((await post({ token: 'x', artist_id: 'nope', service: 'spotify' })).status).toBe(400);
		expect((await post({ token: 'forged', artist_id, service: 'spotify' })).status).toBe(401);
		const many = Array.from({ length: 2_001 }, (_, i) => ({ ref: `a${i}`, name: `Artist ${i}` }));
		expect((await post({ token: 'x', artist_id, service: 'spotify', releases: { artists: many } })).status).toBe(413);
	});
});

describe('backpack endpoints', () => {
	const sid_of = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sid as string;

	it('validates reports, follows redirects and records the reason', async () => {
		const user = await create_user('bp-report');
		const created = await contribute(user, mock_album({ artist: unique('BP Artist'), album: unique('BP Album'), n: 1 }));
		const t = created.body.refs.t0 as string;
		const report = (id: string, body: unknown) => api('POST', `/tracks/${id}/unavailable`, { token: user.access_token, body });
		expect((await report('nope', { service: 'youtube' })).status).toBe(400);
		expect((await report(t, { service: 'napster' })).status).toBe(400);
		expect((await report(t, {})).status).toBe(400);
		expect((await report(uuid(), { service: 'youtube' })).status).toBe(404);

		const old = uuid();
		await query(`insert into service_ids_table (illusi_id) values ($1)`, [old]);
		await query(`insert into illusi_id_redirects_table (old_id, new_id) values ($1, $2)`, [old, t]);
		const res = await report(old, { service: 'youtube', reason: '  gone  ' });
		expect(res.body).toMatchObject({ track_id: t, backpacked: true, redirected_from: old });
		expect(await query(`select reason from track_unavailable_reports_table where track_id = $1`, [t])).toEqual([{ reason: 'gone' }]);
		expect((await report(t, { service: 'youtube', reason: 'still gone' })).status).toBe(200);
		expect(await query(`select reason from track_unavailable_reports_table where track_id = $1`, [t])).toEqual([{ reason: 'still gone' }]);
	});

	it('validates research requests and fulfilments', async () => {
		const user = await create_user('bp-research-bad');
		const created = await contribute(user, mock_album({ artist: unique('BPR Artist'), album: unique('BPR Album'), n: 1 }));
		const t = created.body.refs.t0 as string;
		const { issue_action, research_target } = await import('../../src/core/actions');
		const { research_actions } = await import('../../src/services/backpack');
		const auth = { id: user.id, role: 'USER' as const, sid: sid_of(user.access_token) };
		expect((await api('GET', '/backpack/requests?limit=0', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', '/backpack/requests?limit=51', { token: user.access_token })).status).toBe(400);
		expect(await research_actions(auth, 0)).toEqual([]);
		expect(await research_actions(auth, 5)).toEqual([]);

		const post = (body: Record<string, unknown>) => api('POST', '/ingest/track_research', { token: user.access_token, body });
		const token = async (service: string) => (await issue_action(auth, { type: 'RESEARCH_TRACK', track_id: t, service, query: 'q', title: 't', artists: [], duration_ms: null })).token;
		expect(research_target('youtube', t)).toBe(`youtube:${t}`);
		expect((await post({ token: 'x', track_id: t, service: 'youtube' })).status).toBe(400);
		expect((await post({ token: 'x', track_id: t, service: 'youtube', service_id: 'a', result: 'NOT_FOUND' })).status).toBe(400);
		expect((await post({ token: 'x', track_id: t, service: 'napster', result: 'NOT_FOUND' })).status).toBe(400);
		expect((await post({ token: await token('youtube'), track_id: t, service: 'youtube', service_id: 'not a video' })).status).toBe(422);
		const ok = await post({ token: await token('youtube'), track_id: t, service: 'youtube', result: 'NOT_FOUND' });
		expect(ok.body).toMatchObject({ status: 'NOT_FOUND', applied: false, backpacked: false });
	});
});
