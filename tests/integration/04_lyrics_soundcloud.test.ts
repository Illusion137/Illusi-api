import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, eventually, mock_album, query, unique } from './helpers';
import type { TestUser } from './helpers';

/** A track with a unique title/artist; the API runs with LYRICS_SERVERS_STUB=not_found, so no server service finds it. */
async function lyrics_track(user: TestUser, title?: string, artist?: string) {
	const graph = mock_album({ artist: artist ?? unique('Lyric Artist'), album: unique('Lyric Album'), n: 1 });
	if (title) graph.tracks[0].title = title;
	const res = await contribute(user, graph);
	return { id: res.body.refs.t0 as string, graph };
}

function genius_state(title: string, artist: string, overrides: Record<string, unknown> = {}) {
	const person = (id: number, name: string) => ({ id, name, slug: name.toLowerCase(), url: `https://genius.com/artists/${id}`, imageUrl: null, headerImageUrl: null });
	const song_id = 9_000_000 + Math.floor(Math.random() * 999_999);
	const artist_id = 8_000_000 + Math.floor(Math.random() * 999_999);
	return {
		songPage: { song: song_id, lyricsData: { body: { tag: 'root', children: [{ tag: 'p', children: ['[Verse 1]', { tag: 'br' }, 'Mock line one', { tag: 'br' }, 'Mock line two'] }] } } },
		entities: {
			users: {},
			artists: { [artist_id]: person(artist_id, artist) },
			songs: {
				[song_id]: {
					id: song_id, title,
					primaryArtist: person(artist_id, artist), primaryArtists: [person(artist_id, artist)],
					featuredArtists: [], writerArtists: [], producerArtists: [person(artist_id + 1, `${artist} Producer`)],
					instrumental: false, releaseDate: '2024-01-01', ...overrides
				}
			},
			referents: {},
			annotations: {}
		}
	};
}

describe('lyrics (§7) with client actions', () => {
	it('asks the client for Genius and YouTube Music once every server service says NOT_FOUND', async () => {
		const user = await create_user('lyrics');
		const track = await lyrics_track(user);
		const res = await api('GET', `/tracks/${track.id}/lyrics`, { token: user.access_token });
		expect(res.status).toBe(200);
		expect(res.body.lyrics).toBeNull();
		expect(res.body.actions.map((a: { type: string }) => a.type).sort()).toEqual(['CHECK_GENIUS', 'CHECK_YOUTUBE_MUSIC']);
		expect(res.body.actions[0]).toMatchObject({ track_id: track.id, token: expect.any(String), query: expect.stringContaining(track.graph.tracks[0].title) });
		const lookups = await query(`select service::text, status::text from track_lyrics_lookups_table where track_id = $1 order by service::text`, [track.id]);
		expect(lookups).toEqual(['BINILYRICS', 'GOLYRICS', 'LRCLIB', 'MUSIXMATCH'].map(service => ({ service, status: 'NOT_FOUND' })));
		expect((await api('GET', `/tracks/00000000-0000-4000-8000-000000000000/lyrics`, { token: user.access_token })).status).toBe(404);
	});

	it('ingests YouTube Music LRC lyrics through the action token and serves them parsed', async () => {
		const user = await create_user('ytm');
		const track = await lyrics_track(user);
		const first = await api('GET', `/tracks/${track.id}/lyrics`, { token: user.access_token });
		const action = first.body.actions.find((a: { type: string }) => a.type === 'CHECK_YOUTUBE_MUSIC');
		const youtube_id = unique('yt').slice(0, 11).padEnd(11, 'x');
		const body = { token: action.token, track_id: track.id, youtube_id, lyrics: '[00:01.00]Hello mock world\n[00:03.50]Second line here\n' };

		const ok = await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body });
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ track_id: track.id, service: 'YOUTUBE_MUSIC', sync_type: 'LINE' });
		expect(JSON.stringify(ok.body.lyrics)).toContain('Hello mock world');

		const again = await api('GET', `/tracks/${track.id}/lyrics`, { token: user.access_token });
		expect(again.body).toMatchObject({ service: 'YOUTUBE_MUSIC', sync_type: 'LINE' });
		expect(again.body.actions).toBeUndefined();
		// The youtube id was enriched, and the row is traceable to the user and token.
		expect((await query(`select youtube_id from service_ids_table where illusi_id = $1`, [track.id]))[0].youtube_id).toBe(youtube_id);
		const [row] = await query(`select source_user_id, source_token_jti from track_lyrics_table where track_id = $1`, [track.id]);
		expect(row.source_user_id).toBe(user.id);
		expect(row.source_token_jti).toEqual(expect.any(String));

		// Single use.
		expect((await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body })).status).toBe(403);
	});

	it('refuses action tokens for another track, another user, the wrong endpoint, or a revoked session', async () => {
		const user = await create_user('attest');
		const other = await create_user('attest-other');
		const a = await lyrics_track(user);
		const b = await lyrics_track(user);
		const actions = (await api('GET', `/tracks/${a.id}/lyrics`, { token: user.access_token })).body.actions;
		const ytm = actions.find((x: { type: string }) => x.type === 'CHECK_YOUTUBE_MUSIC');
		const genius = actions.find((x: { type: string }) => x.type === 'CHECK_GENIUS');
		const lrc = '[00:01.00]x\n';

		expect((await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body: { token: ytm.token, track_id: b.id, lyrics: lrc } })).status).toBe(403);
		expect((await api('POST', '/ingest/youtube_music_lyrics', { token: other.access_token, body: { token: ytm.token, track_id: a.id, lyrics: lrc } })).status).toBe(403);
		expect((await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body: { token: genius.token, track_id: a.id, lyrics: lrc } })).status).toBe(403);
		expect((await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body: { token: 'forged.token.value', track_id: a.id, lyrics: lrc } })).status).toBe(401);

		await api('POST', '/auth/logout', { token: user.access_token });
		expect((await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body: { token: ytm.token, track_id: a.id, lyrics: lrc } })).status).toBe(401);
		// Nothing was stored by any of the refused attempts.
		expect(await query(`select count(*)::int as n from track_lyrics_table where track_id in ($1, $2)`, [a.id, b.id])).toEqual([{ n: 0 }]);
	});

	it('ingests a matching Genius page (lyrics, producers, ids) and rejects a mismatched one', async () => {
		const user = await create_user('genius');
		const artist = unique('Genius Artist');
		const track = await lyrics_track(user, unique('Genius Song'), artist);
		const title = track.graph.tracks[0].title;
		const get_action = async (id: string) => (await api('GET', `/tracks/${id}/lyrics`, { token: user.access_token })).body.actions.find((a: { type: string }) => a.type === 'CHECK_GENIUS');

		const action = await get_action(track.id);
		const state = genius_state(title, artist);
		const ok = await api('POST', '/ingest/genius', { token: user.access_token, body: { token: action.token, track_id: track.id, preloaded_state: state } });
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ service: 'GENIUS' });
		expect(JSON.stringify(ok.body.lyrics)).toContain('Mock line two');
		expect((await query(`select genius_id from service_ids_table where illusi_id = $1`, [track.id]))[0].genius_id).toBe(String(state.songPage.song));
		expect(await query(`select count(*)::int as n from tracks_producers_table where track_id = $1`, [track.id])).toEqual([{ n: 1 }]);

		const wrong = await lyrics_track(user);
		const wrong_action = await get_action(wrong.id);
		const mismatch = await api('POST', '/ingest/genius', { token: user.access_token, body: { token: wrong_action.token, track_id: wrong.id, preloaded_state: genius_state('Completely Different Song', 'Someone Else') } });
		expect(mismatch.status).toBe(422);
		const reviews = await query(`select kind from review_items_table where entity_id = $1`, [wrong.id]);
		expect(reviews.map(r => r.kind)).toContain('GENIUS_MATCH_REJECTED');
	});

	it('a client NOT_FOUND from both services marks the track as checked, so it is not asked again', async () => {
		const user = await create_user('nf');
		const track = await lyrics_track(user);
		const actions = (await api('GET', `/tracks/${track.id}/lyrics`, { token: user.access_token })).body.actions;
		for (const a of actions) {
			const path = a.type === 'CHECK_GENIUS' ? '/ingest/genius' : '/ingest/youtube_music_lyrics';
			const res = await api('POST', path, { token: user.access_token, body: { token: a.token, track_id: track.id, result: 'NOT_FOUND' } });
			expect(res.status).toBe(200);
		}
		const after = await api('GET', `/tracks/${track.id}/lyrics`, { token: user.access_token });
		expect(after.body.lyrics).toBeNull();
		expect(after.body.actions).toBeUndefined();
	});

	it('sync pull carries the best parsed lyrics for library tracks (§8.1)', async () => {
		const user = await create_user('pull-lyrics');
		const track = await lyrics_track(user);
		const action = (await api('GET', `/tracks/${track.id}/lyrics`, { token: user.access_token })).body.actions.find((a: { type: string }) => a.type === 'CHECK_YOUTUBE_MUSIC');
		await api('POST', '/ingest/youtube_music_lyrics', { token: user.access_token, body: { token: action.token, track_id: track.id, lyrics: 'Plain unsynced words\nSecond plain line' } });
		await add_to_library(user, [track.id]);
		await new Promise(r => setTimeout(r, 2_200));
		const pull = await api('POST', '/sync/pull', { token: user.access_token, body: {} });
		const entry = pull.body.lyrics.find((l: { track_id: string }) => l.track_id === track.id);
		expect(entry.lyrics).toMatchObject({ service: 'YOUTUBE_MUSIC', sync_type: 'NONE' });
	});
});

describe('SoundCloud ingest (§5)', () => {
	const sc_user = (id: number, permalink: string) => ({ kind: 'user', id, permalink, username: permalink, followers_count: 10, last_modified: '2026-01-01T00:00:00Z' });
	const sc_track = (id: number, user: object, extra: object = {}) => ({
		kind: 'track', id, title: `SC Mock ${id}`, user, duration: 123_000, permalink_url: `https://soundcloud.com/x/track-${id}`,
		created_at: '2026-01-01T00:00:00Z', last_modified: '2026-01-01T00:00:00Z', playback_count: 5,
		publisher_metadata: { artist: 'Mock Publisher', isrc: 'USABC2600001' },
		media: { transcodings: [{ url: `https://api-v2.soundcloud.com/media/${id}/stream/hls`, preset: 'mp3_0_0', duration: 123_000, snipped: false, format: { protocol: 'hls', mime_type: 'audio/mpeg' }, quality: 'sq' }] },
		...extra
	});

	it('accepts a mixed batch, flattens nested objects and writes them in the background', async () => {
		const user = await create_user('sc');
		const base = 700_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
		const uploader = sc_user(base, unique('uploader'));
		const res = await api('POST', '/ingest/soundcloud', {
			token: user.access_token,
			body: {
				items: [
					sc_track(base + 1, uploader),
					{ collection: [{ track: sc_track(base + 2, uploader) }] },
					{ kind: 'playlist', id: base + 3, title: 'SC Mock Set', user: uploader, track_count: 2, tracks: [{ id: base + 1 }, { id: base + 2 }], last_modified: '2026-01-01T00:00:00Z' },
					{ kind: 'mystery', id: 1 },
					{ kind: 'track' }
				]
			}
		});
		expect(res.status).toBe(202);
		expect(res.body).toEqual({ accepted: 3, rejected: 2 });

		await eventually(async () => {
			const tracks = await query(`select id, title, publisher_artist, isrc from soundcloud_tracks_table where user_id = $1 order by id`, [base]);
			expect(tracks.map(t => Number(t.id))).toEqual([base + 1, base + 2]);
			expect(tracks[0]).toMatchObject({ publisher_artist: 'Mock Publisher', isrc: 'USABC2600001' });
		});
		const members = await query(`select track_id, position from soundcloud_playlist_tracks_table where playlist_id = $1 order by position`, [base + 3]);
		expect(members.map(m => [Number(m.track_id), m.position])).toEqual([[base + 1, 0], [base + 2, 1]]);
		expect(await query(`select count(*)::int as n from soundcloud_transcodings_table where track_id = $1`, [base + 1])).toEqual([{ n: 1 }]);
		expect(await query(`select source from contributions_log_table where user_id = $1`, [user.id])).toEqual([{ source: 'soundcloud' }]);
	});

	it('never nulls out stored data with a partial object, and keeps counters fresh', async () => {
		const user = await create_user('sc2');
		const base = 710_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
		const uploader = sc_user(base, unique('up2'));
		await api('POST', '/ingest/soundcloud', { token: user.access_token, body: { items: [sc_track(base + 1, uploader)] } });
		await eventually(async () => expect(await query(`select 1 from soundcloud_tracks_table where id = $1`, [base + 1])).toHaveLength(1));
		// A stale stub without metadata, but with a newer counter.
		await api('POST', '/ingest/soundcloud', { token: user.access_token, body: { items: [{ kind: 'track', id: base + 1, title: `SC Mock ${base + 1}`, playback_count: 99, last_modified: '2025-01-01T00:00:00Z' }] } });
		await eventually(async () => {
			const [row] = await query(`select playback_count, publisher_artist, duration from soundcloud_tracks_table where id = $1`, [base + 1]);
			expect(row).toMatchObject({ playback_count: '99', publisher_artist: 'Mock Publisher', duration: 123_000 });
		});
	});

	it('limits items per request', async () => {
		const user = await create_user('sc3');
		const items = Array.from({ length: 501 }, (_, i) => ({ kind: 'track', id: i + 1, title: 't' }));
		expect((await api('POST', '/ingest/soundcloud', { token: user.access_token, body: { items } })).status).toBe(400);
	});
});
