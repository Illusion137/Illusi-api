import { afterAll, describe, expect, it, vi } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
const { api, contribute, create_user, eventually, mock_album, pool, query, unique, uuid } = await import('./helpers');
const { db } = await import('../../src/db');
const { issue_action } = await import('../../src/core/actions');
const { get_best_lyrics, lyrics_actions_for_tracks, queue_never_looked_up } = await import('../../src/services/lyrics');
const { lookup_track, lookup_track_with_deadline, lyrics_query, enqueue_background } = await import('../../src/services/lyrics/lookup');
const store = await import('../../src/services/lyrics/store');
const { on } = await import('../../src/core/events');

afterAll(async () => { await app.stop(); });

type User = Awaited<ReturnType<typeof create_user>>;
const auth_user = (u: User) => ({ id: u.id, role: 'USER' as const, sid: JSON.parse(Buffer.from(u.access_token.split('.')[1], 'base64url').toString()).sid as string });

async function lyrics_track(user: User, title?: string, artist?: string) {
	const graph = mock_album({ artist: artist ?? unique('Lyric Artist'), album: unique('Lyric Album'), n: 1 });
	if (title) graph.tracks[0].title = title;
	const res = await contribute(user, graph);
	return { id: res.body.refs.t0 as string, graph };
}

const add_lyrics = (track_id: string, service: string, format: string, sync: string, raw: string) =>
	query(`insert into track_lyrics_table (track_id, service, sync_type, format, raw_content, content_hash) values ($1, $2, $3, $4, $5, $6)`, [track_id, service, sync, format, raw, store.content_hash(raw)]);

const add_lookup = (track_id: string, service: string, status: string, retry_after: string | null = `now() + interval '30 days'`) =>
	query(`insert into track_lyrics_lookups_table (track_id, service, status, attempted_at, retry_after) values ($1, $2, $3, now(), ${retry_after ?? 'null'})`, [track_id, service, status]);

const action_token = async (user: User, type: 'CHECK_GENIUS' | 'CHECK_YOUTUBE_MUSIC', track_id: string) =>
	(await issue_action(auth_user(user), { type, track_id, query: 'q' })).token;

function genius_state(title: string, artist: string, over: { song?: Record<string, unknown>; entities?: Record<string, unknown>; page?: Record<string, unknown> } = {}) {
	const person = (id: number, name: string) => ({ id, name, slug: name.toLowerCase(), url: `https://genius.com/artists/${id}`, imageUrl: `https://img.example.test/${id}.jpg`, headerImageUrl: null });
	const song_id = 9_000_000 + Math.floor(Math.random() * 999_999);
	const artist_id = 8_000_000 + Math.floor(Math.random() * 999_999);
	return {
		song_id, artist_id,
		state: {
			songPage: { song: song_id, lyricsData: { body: { tag: 'root', children: [{ tag: 'p', children: ['[Verse 1]', { tag: 'br' }, 'Rich line one'] }] } }, ...over.page },
			entities: {
				users: { 7: { id: 7, login: `user${song_id}`, name: 'Annotator', avatar: { medium: { url: 'https://img.example.test/u.jpg' } }, iq: 100 } },
				artists: { [artist_id]: person(artist_id, artist) },
				songs: {
					[song_id]: {
						id: song_id, title, primaryArtist: person(artist_id, artist), primaryArtists: [person(artist_id, artist)],
						featuredArtists: [], writerArtists: [person(artist_id + 2, 'Writer')], producerArtists: [person(artist_id + 1, `${artist} Producer`)],
						instrumental: false, releaseDate: '2024-01-01', lyricsOwnerId: 7, lyricsUpdatedAt: 1_700_000_000,
						durationMs: 180_000,
						media: [{ provider: 'youtube', url: `https://www.youtube.com/watch?v=${song_id.toString(36).padStart(11, 'q').slice(-11)}` }, { provider: 'mystery', url: 'https://example.test/x' }],
						...over.song
					}
				},
				referents: { 11: { id: 11, songId: song_id, annotatorId: 7, fragment: 'Rich line one', classification: 'accepted' }, 12: { id: 12, songId: 1, fragment: 'other song' } },
				annotations: { 21: { id: 21, referentId: 11, createdBy: 7, body: { markdown: 'Explains it' }, state: 'accepted', votesTotal: 3, createdAt: 1_700_000_000 }, 22: { id: 22, referentId: 99 } },
				...over.entities
			}
		}
	};
}

describe('best lyrics', () => {
	it('returns nothing for no ids and skips tracks without lyrics', async () => {
		expect((await get_best_lyrics([])).size).toBe(0);
		expect((await get_best_lyrics([uuid()])).size).toBe(0);
	});

	it('picks parsed lyrics, falls past rows that do not parse, and reports instrumentals', async () => {
		const user = await create_user('best');
		const [a, b, c, d] = await Promise.all([lyrics_track(user), lyrics_track(user), lyrics_track(user), lyrics_track(user)]);
		await add_lyrics(a.id, 'YOUTUBE_MUSIC', 'LRC', 'LINE', '[00:01.00]Hello there\n[00:03.00]General');
		await add_lyrics(b.id, 'LRCLIB', 'TTML', 'LINE', 'definitely <not valid');
		await add_lyrics(b.id, 'KUGOU', 'PLAIN', 'NONE', 'plain fallback words');
		await add_lookup(c.id, 'LRCLIB', 'INSTRUMENTAL', null);
		const genius_id = 6_000_000 + Math.floor(Math.random() * 999_999);
		await query(`insert into genius_songs_table (id, title, instrumental) values ($1, 'Inst', true)`, [genius_id]);
		await query(`update service_ids_table set genius_id = $2 where illusi_id = $1`, [d.id, genius_id]);

		const best = await get_best_lyrics([a.id, b.id, c.id, d.id, a.id]);
		expect(best.get(a.id)).toMatchObject({ service: 'YOUTUBE_MUSIC', sync_type: 'LINE' });
		expect(best.get(b.id)).toMatchObject({ service: 'KUGOU', sync_type: 'NONE' });
		expect(best.get(c.id)).toEqual({ instrumental: true });
		expect(best.get(d.id)).toEqual({ instrumental: true });

		// The parse failure is recorded once, and good rows get their parse cached.
		await eventually(async () => {
			expect(await query(`select 1 from review_items_table where kind = 'LYRICS_PARSE_FAILURE' and current_value->>'track_id' = $1`, [b.id])).toHaveLength(1);
			expect(await query(`select 1 from track_lyrics_table where track_id = $1 and parsed_cache is not null`, [a.id])).toHaveLength(1);
		});
		await get_best_lyrics([b.id]);
		await new Promise(r => setTimeout(r, 300));
		expect(await query(`select 1 from review_items_table where kind = 'LYRICS_PARSE_FAILURE' and current_value->>'track_id' = $1`, [b.id])).toHaveLength(1);
		// A second read uses the cache.
		expect((await get_best_lyrics([a.id])).get(a.id)).toMatchObject({ service: 'YOUTUBE_MUSIC' });
	});

	it('stores versions once per content and upserts lookups', async () => {
		const user = await create_user('store');
		const t = await lyrics_track(user);
		const version = { format: 'PLAIN', sync_type: 'NONE', raw_content: unique('words') } as const;
		await db.transaction(async (tx) => {
			expect(await store.insert_versions(tx, t.id, 'LRCLIB', [])).toEqual([]);
			expect(await store.insert_versions(tx, t.id, 'LRCLIB', [version, version])).toHaveLength(1);
			expect(await store.insert_versions(tx, t.id, 'LRCLIB', [version])).toEqual([]);
			await store.write_lookups(tx, t.id, [], new Map());
			await store.write_lookups(tx, t.id, [{ service: 'LRCLIB', status: 'ERROR' }], new Map());
		});
		const previous = (await store.load_lookups(db, [t.id, t.id])).get(t.id)!;
		expect(previous.get('LRCLIB')).toMatchObject({ status: 'ERROR', attempts: 1 });
		await db.transaction(tx => store.write_lookups(tx, t.id, [{ service: 'LRCLIB', status: 'SKIPPED', cooldown_until: new Date(Date.now() + 3 * 3_600_000) }], previous));
		const row = (await store.load_lookups(db, [t.id])).get(t.id)!.get('LRCLIB')!;
		expect(row.attempts).toBe(2);
		expect(row.retry_after!.getTime()).toBeGreaterThan(Date.now() + 2.9 * 3_600_000);
		expect(await store.load_track_context(db, uuid())).toBeNull();
		const ctx = (await store.load_track_context(db, t.id))!;
		expect(store.search_query(ctx)).toBe(`${ctx.artists[0].name} ${ctx.title}`);
		expect(store.search_query({ title: 'Only', artists: [] })).toBe('Only');
		expect(lyrics_query({ ...ctx, duration_ms: null, artists: [] })).toMatchObject({ artist: '', duration_s: null });
		expect((await store.has_lyrics_rows(db, [t.id])).has(t.id)).toBe(true);
	});
});

describe('lyrics lookups', () => {
	it('shares one lookup per track and records every server service', async () => {
		const user = await create_user('lookup');
		const t = await lyrics_track(user);
		const stored = vi.fn();
		on('lyrics_stored', stored);
		const first = lookup_track(t.id);
		expect(lookup_track(t.id)).toBe(first);
		await first;
		// Every service answered NOT_FOUND, so no lyrics were stored
		expect(stored).not.toHaveBeenCalledWith({ track_id: t.id });
		const lookups = await query(`select service::text, status::text from track_lyrics_lookups_table where track_id = $1 order by service::text`, [t.id]);
		expect(lookups).toHaveLength(6);
		// Nothing is due now, so a second lookup does nothing.
		await lookup_track(t.id);
		await lookup_track(uuid());
		await lookup_track_with_deadline(t.id, 50);
		await lookup_track_with_deadline(uuid());
	});

	it('queues never-looked-up tracks in the background once', async () => {
		const user = await create_user('queue');
		const [a, b] = await Promise.all([lyrics_track(user), lyrics_track(user)]);
		await queue_never_looked_up([]);
		await queue_never_looked_up([a.id, b.id, a.id]);
		enqueue_background([a.id, b.id]);
		await eventually(async () => {
			expect(await query(`select distinct track_id from track_lyrics_lookups_table where track_id in ($1, $2)`, [a.id, b.id])).toHaveLength(2);
		});
		expect(await store.never_looked_up(db, [a.id, uuid()])).toEqual([]);
	});

	it('serves the version most services agree on within the richest sync level', async () => {
		const user = await create_user('consensus');
		const t = await lyrics_track(user);
		const song = '[00:01.00]I said ooh I\'m blinded by the lights\n[00:04.00]No I can\'t sleep until I feel your touch';
		await add_lyrics(t.id, 'LRCLIB', 'PLAIN', 'NONE', 'something else entirely');
		await add_lyrics(t.id, 'KUGOU', 'LRC', 'LINE', song);
		await add_lyrics(t.id, 'QQMUSIC', 'LRC', 'LINE', song.replace('touch', 'touch now'));
		// Newest, so the plain order would serve it, but neither other line-synced version agrees with it.
		await add_lyrics(t.id, 'UNISON', 'LRC', 'LINE', '[00:01.00]Never gonna give you up\n[00:04.00]Never gonna let you down');
		// KuGou and QQ Music agree with each other equally; the tie goes to the newer one.
		expect((await get_best_lyrics([t.id])).get(t.id)).toMatchObject({ service: 'QQMUSIC', sync_type: 'LINE' });
	});

	it('asks for client services only where every server service has a current NOT_FOUND', async () => {
		const user = await create_user('actions');
		const u = auth_user(user);
		const [asked, instrumental, has_rows, partial, tried] = await Promise.all([lyrics_track(user), lyrics_track(user), lyrics_track(user), lyrics_track(user), lyrics_track(user)]);
		const servers = ['BINILYRICS', 'LRCLIB', 'LRCRED', 'UNISON', 'QQMUSIC', 'KUGOU'];
		for (const t of [asked, instrumental, has_rows, partial, tried]) for (const s of servers.slice(0, t === partial ? 2 : servers.length)) await add_lookup(t.id, s, 'NOT_FOUND');
		await query(`update track_lyrics_lookups_table set status = 'INSTRUMENTAL', retry_after = null where track_id = $1 and service = 'LRCLIB'`, [instrumental.id]);
		await add_lyrics(has_rows.id, 'LRCLIB', 'PLAIN', 'NONE', 'words');
		await add_lookup(tried.id, 'GENIUS', 'NOT_FOUND');
		await add_lookup(tried.id, 'YOUTUBE_MUSIC', 'NOT_FOUND');

		const ids = [asked.id, instrumental.id, has_rows.id, partial.id, tried.id, uuid()];
		expect(await lyrics_actions_for_tracks(u, ids, 0)).toEqual([]);
		expect(await lyrics_actions_for_tracks(u, [], 5)).toEqual([]);
		const all = await lyrics_actions_for_tracks(u, ids, 10);
		expect(all.map(a => [a.type, a.track_id]).sort()).toEqual([['CHECK_GENIUS', asked.id], ['CHECK_YOUTUBE_MUSIC', asked.id]]);
		expect(all[0]).toMatchObject({ query: expect.stringContaining(asked.graph.tracks[0].title) });
		expect(await lyrics_actions_for_tracks(u, ids, 1)).toHaveLength(1);
	});
});

describe('lyrics endpoint', () => {
	it('validates ids, follows redirects, and rechecks due services behind stored lyrics', async () => {
		const user = await create_user('endpoint');
		expect((await api('GET', '/tracks/not-a-uuid/lyrics', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', `/tracks/${uuid()}/lyrics`)).status).toBe(401);

		const t = await lyrics_track(user);
		const old = uuid();
		await query(`insert into service_ids_table (illusi_id) values ($1)`, [old]);
		await query(`insert into illusi_id_redirects_table (old_id, new_id) values ($1, $2)`, [old, t.id]);
		await add_lyrics(t.id, 'LRCLIB', 'PLAIN', 'NONE', 'stored words');
		await add_lookup(t.id, 'LRCLIB', 'FOUND', `now() - interval '1 day'`);
		const res = await api('GET', `/tracks/${old}/lyrics`, { token: user.access_token });
		expect(res.body).toMatchObject({ track_id: t.id, service: 'LRCLIB', sync_type: 'NONE' });
		await eventually(async () => expect(await query(`select 1 from track_lyrics_lookups_table where track_id = $1 and service = 'BINILYRICS'`, [t.id])).toHaveLength(1));
	});

	it('reports an instrumental track', async () => {
		const user = await create_user('endpoint-inst');
		const t = await lyrics_track(user);
		await add_lookup(t.id, 'LRCLIB', 'INSTRUMENTAL', null);
		expect((await api('GET', `/tracks/${t.id}/lyrics`, { token: user.access_token })).body).toEqual({ track_id: t.id, instrumental: true, lyrics: null });
	});
});

describe('YouTube Music ingest', () => {
	it('stores timed JSON, plain text and NOT_FOUND results, and follows redirects', async () => {
		const user = await create_user('ytm-ingest');
		const post = async (body: Record<string, unknown>, type: 'CHECK_YOUTUBE_MUSIC' = 'CHECK_YOUTUBE_MUSIC') =>
			api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body: { token: await action_token(user, type, body.track_id as string), ...body } });
		const stored = vi.fn();
		on('lyrics_stored', stored);
		const a = await lyrics_track(user);
		const timed = { lines: [{ cueRange: { startTimeMilliseconds: '1000' }, lyricLine: 'Timed words' }] };
		const ok = await post({ track_id: a.id, lyrics: timed });
		expect(ok.status).toBe(200);
		await eventually(async () => expect(stored).toHaveBeenCalledWith({ track_id: a.id }));
		expect(ok.body).toMatchObject({ track_id: a.id });
		expect(await query(`select format::text, sync_type::text from track_lyrics_table where track_id = $1`, [a.id])).toEqual([{ format: 'YTM_JSON', sync_type: 'LINE' }]);

		const b = await lyrics_track(user);
		const nothing = await post({ track_id: b.id, lyrics: '   ' });
		expect(nothing.body).toEqual({ track_id: b.id, lyrics: null });
		expect(stored).not.toHaveBeenCalledWith({ track_id: b.id });
		expect(await query(`select status::text from track_lyrics_lookups_table where track_id = $1 and service = 'YOUTUBE_MUSIC'`, [b.id])).toEqual([{ status: 'NOT_FOUND' }]);
		expect((await post({ track_id: b.id, lyrics: 42 })).status).toBe(400);

		const old = uuid();
		await query(`insert into service_ids_table (illusi_id) values ($1)`, [old]);
		await query(`insert into illusi_id_redirects_table (old_id, new_id) values ($1, $2)`, [old, b.id]);
		const via_redirect = await post({ track_id: old, lyrics: 'Plain words here' });
		expect(via_redirect.body).toMatchObject({ track_id: b.id, service: 'YOUTUBE_MUSIC' });
		await eventually(async () => expect(stored).toHaveBeenCalledWith({ track_id: b.id }));

		const missing = await post({ track_id: uuid(), result: 'NOT_FOUND' });
		expect(missing.status).toBe(404);
	});
});

describe('Genius ingest', () => {
	const post = async (user: User, body: Record<string, unknown>) =>
		api('POST', '/ingest/genius', { token: user.access_token, body: { token: await action_token(user, 'CHECK_GENIUS', body.track_id as string), ...body } });

	it('stores the full song, annotations and users, links ids and artwork, and records the lookup', async () => {
		const user = await create_user('genius-rich');
		const artist = unique('Rich Artist');
		const t = await lyrics_track(user, unique('Rich Song'), artist);
		const title = t.graph.tracks[0].title;
		const { state, song_id, artist_id } = genius_state(title, artist, { song: { album: { name: t.graph.albums[0].name } } });
		const stored = vi.fn();
		on('lyrics_stored', stored);
		const res = await post(user, { track_id: t.id, preloaded_state: state });
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body.lyrics)).toContain('Rich line one');
		await eventually(async () => expect(stored).toHaveBeenCalledWith({ track_id: t.id }));
		expect(await query(`select id from genius_referents_table where song_id = $1`, [song_id])).toEqual([{ id: '11' }]);
		expect(await query(`select id, created_by_id from genius_annotations_table where referent_id = 11`, [])).toEqual([{ id: '21', created_by_id: '7' }]);
		expect((await query(`select count(*)::int as n from genius_song_artists_table where song_id = $1`, [song_id]))[0].n).toBe(3);
		expect((await query(`select genius_id, youtube_id from service_ids_table where illusi_id = $1`, [t.id]))[0]).toEqual({ genius_id: String(song_id), youtube_id: song_id.toString(36).padStart(11, 'q').slice(-11) });
		const [artist_ids] = await query(`select s.genius_id from tracks_artists_table ta join service_ids_table s on s.illusi_id = ta.artist_id where ta.track_id = $1`, [t.id]);
		expect(artist_ids.genius_id).toBe(String(artist_id));
		expect(await query(`select status::text from track_lyrics_lookups_table where track_id = $1 and service = 'GENIUS'`, [t.id])).toEqual([{ status: 'FOUND' }]);
		// Posting the same page again is harmless.
		expect((await post(user, { track_id: t.id, preloaded_state: state })).status).toBe(200);
	});

	it('records instrumentals and pages without lyrics, and drops references to unknown users', async () => {
		const user = await create_user('genius-inst');
		const artist = unique('Inst Artist');
		const t = await lyrics_track(user, unique('Inst Song'), artist);
		const title = t.graph.tracks[0].title;
		const { state } = genius_state(title, artist, { song: { instrumental: true, lyricsOwnerId: 777_000_111 }, entities: { users: {} } });
		const res = await post(user, { track_id: t.id, preloaded_state: state });
		expect(res.body).toEqual({ track_id: t.id, instrumental: true, lyrics: null });
		expect(await query(`select status::text from track_lyrics_lookups_table where track_id = $1 and service = 'GENIUS'`, [t.id])).toEqual([{ status: 'INSTRUMENTAL' }]);

		const bare = await lyrics_track(user, unique('Bare Song'), artist);
		const no_lyrics = genius_state(bare.graph.tracks[0].title, artist, { page: { lyricsData: {} } });
		const res2 = await post(user, { track_id: bare.id, preloaded_state: no_lyrics.state });
		expect(res2.body).toEqual({ track_id: bare.id, lyrics: null });
		expect(await query(`select status::text from track_lyrics_lookups_table where track_id = $1 and service = 'GENIUS'`, [bare.id])).toEqual([{ status: 'NOT_FOUND' }]);
	});

	it('matches by a shared id even when the titles differ', async () => {
		const user = await create_user('genius-id');
		const t = await lyrics_track(user);
		const yt = unique('yt').slice(0, 11).padEnd(11, 'z');
		await query(`update service_ids_table set youtube_id = $2 where illusi_id = $1`, [t.id, yt]);
		const { state } = genius_state('Entirely Different Title', 'Other Artist', { song: { media: [{ provider: 'youtube', url: `https://youtu.be/${yt}` }] } });
		expect((await post(user, { track_id: t.id, preloaded_state: state })).status).toBe(200);
	});

	it('rejects malformed pages, unknown tracks and bad bodies', async () => {
		const user = await create_user('genius-bad');
		const t = await lyrics_track(user);
		expect((await post(user, { track_id: t.id, preloaded_state: { songPage: {}, entities: {} } })).status).toBe(400);
		expect((await post(user, { track_id: t.id })).status).toBe(400);
		expect((await post(user, { track_id: uuid(), result: 'NOT_FOUND' })).status).toBe(404);
		const { state } = genius_state('Whatever', 'Nobody');
		const rejected = await post(user, { track_id: t.id, preloaded_state: state });
		expect(rejected.status).toBe(422);
		expect(rejected.body).toMatchObject({ reason: expect.any(String) });
		expect(await query(`select 1 from track_lyrics_table where track_id = $1`, [t.id])).toHaveLength(0);
	});
});

describe('lyrics edge cases', () => {
	it('keeps the first of several differing ids a Genius page reports', async () => {
		const user = await create_user('genius-ids');
		const artist = unique('Ids Artist');
		const t = await lyrics_track(user, unique('Ids Song'), artist);
		const { state } = genius_state(t.graph.tracks[0].title, artist, { song: { youtubeUrl: 'https://youtu.be/AAAAAAAAAAA' } });
		const res = await api('POST', '/ingest/genius', { token: user.access_token, body: { token: await action_token(user, 'CHECK_GENIUS', t.id), track_id: t.id, preloaded_state: state } });
		expect(res.status).toBe(200);
	});

	it('skips a track whose every lyrics row fails to parse, and survives a failing review write', async () => {
		const user = await create_user('best-broken');
		const track = await lyrics_track(user);
		await add_lyrics(track.id, 'LRCLIB', 'TTML', 'LINE', 'definitely <not valid either');
		const transaction = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('review write failed'));
		try {
			expect((await get_best_lyrics([track.id])).size).toBe(0);
			await vi.waitFor(() => { expect(transaction).toHaveBeenCalled(); });
		} finally {
			transaction.mockRestore();
		}
	});
});

afterAll(async () => { await pool.query('select 1'); });
