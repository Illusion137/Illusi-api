import { describe, expect, it } from 'vitest';
import { API_BASE, add_to_library, api, contribute, create_user, make_admin, mock_album, query, unique, uuid, wav_bytes } from './helpers';
import type { TestUser } from './helpers';

function upload(user: TestUser, track_id: string, file: Buffer, fields: Record<string, string> = {}, type = 'audio/wav') {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	form.append('file', new Blob([new Uint8Array(file)], { type }), 'song.wav');
	return api('POST', `/tracks/${track_id}/media`, { token: user.access_token, raw: form });
}

describe('media uploads (§13)', () => {
	it('asks only the device that has the file, and forgets removed downloads and logged-out devices', async () => {
		const phone = await create_user('devices');
		const laptop = { ...phone, access_token: (await api('POST', '/auth/login', { ip: phone.ip, body: { email: phone.email, password: phone.password } })).body.access_token };
		const created = await contribute(phone, mock_album({ artist: unique('Device Artist'), album: unique('Device Album'), n: 2, imported: true }));
		const [t0, t1] = [created.body.refs.t0, created.body.refs.t1];
		const asked = async (device: typeof phone) => (await api('GET', '/media/requests', { token: device.access_token })).body.actions.map((a: { track_id: string }) => a.track_id).sort();
		const devices = (track_id: string) => query(`select count(*)::int as n from track_downloads_table where track_id = $1`, [track_id]);

		await add_to_library(phone, [t0, t1], { downloaded_at: new Date().toISOString(), downloaded: true });
		await add_to_library(laptop, [t1], { downloaded: true });
		expect(await asked(phone)).toEqual([t0, t1].sort());
		expect(await asked(laptop)).toEqual([t1]);

		// Removed on the phone: no longer asked there, even though the library still shows it as downloaded.
		await add_to_library(phone, [t0], { downloaded: false });
		expect(await asked(phone)).toEqual([t1]);
		expect(await query(`select downloaded_at is not null as d from user_tracks_table where user_id = $1 and track_id = $2`, [phone.id, t0])).toEqual([{ d: true }]);

		// A stale push losing last-write-wins still updates what the device holds.
		await add_to_library(laptop, [t0], { downloaded: true, edited_at: new Date(0).toISOString() });
		expect(await asked(laptop)).toEqual([t0, t1].sort());

		expect((await api('POST', '/auth/logout', { token: laptop.access_token })).status).toBe(204);
		expect(await devices(t0)).toEqual([{ n: 0 }]);
		expect(await devices(t1)).toEqual([{ n: 1 }]);
	});

	it('asks for downloaded imported tracks, accepts the upload with the token, dedupes, and streams with ranges', async () => {
		const user = await create_user('media');
		const created = await contribute(user, mock_album({ artist: unique('Media Artist'), album: unique('Media Album'), n: 2, imported: true }));
		const [t0, t1] = [created.body.refs.t0, created.body.refs.t1];
		await add_to_library(user, [t0], { downloaded_at: new Date().toISOString() });
		await add_to_library(user, [t1]);
		// Downloaded but neither imported nor backpacked: a service can still play it, so no copy is asked for.
		const streamed = await contribute(user, mock_album({ artist: unique('Streamed Artist'), album: unique('Streamed Album'), n: 1 }));
		await add_to_library(user, [streamed.body.refs.t0], { downloaded_at: new Date().toISOString() });

		const requests = await api('GET', '/media/requests', { token: user.access_token });
		expect(requests.body.actions.map((a: { track_id: string }) => a.track_id)).toEqual([t0]);
		const action = requests.body.actions[0];
		expect(action.type).toBe('UPLOAD_MEDIA');

		const file = wav_bytes(Math.floor(Math.random() * 1000));
		const stored = await upload(user, t0, file, { token: action.token, quality: 'lossless' });
		expect(stored.status).toBe(201);
		const resource_id: string = stored.body.media.resource_id;
		// Stored as AAC .m4a, whatever was uploaded.
		expect(resource_id).toMatch(/\.m4a$/u);
		expect((await api('GET', '/media/requests', { token: user.access_token })).body.actions).toEqual([]);

		// Same bytes again (no token needed for a user's own library track): deduped by the uploaded bytes' hash.
		const dup = await upload(user, t0, file);
		expect(dup.status).toBe(200);
		expect(dup.body.duplicate).toBe(true);

		const full = await fetch_media(user, resource_id);
		expect(full.status).toBe(200);
		expect(full.headers.get('content-type')).toBe('audio/mp4');
		const stored_file = Buffer.from(await full.arrayBuffer());
		expect(stored_file.toString('ascii', 4, 8)).toBe('ftyp');
		expect(full.headers.get('accept-ranges')).toBe('bytes');
		const part = await fetch_media(user, resource_id, { range: 'bytes=0-11' });
		expect(part.status).toBe(206);
		expect(part.headers.get('content-range')).toBe(`bytes 0-11/${stored_file.length}`);
		expect(Buffer.from(await part.arrayBuffer()).equals(stored_file.subarray(0, 12))).toBe(true);
		expect((await fetch_media(user, resource_id, { range: `bytes=${stored_file.length + 10}-` })).status).toBe(416);

		// Another user only gets it once the track is in their library.
		const other = await create_user('media-other');
		expect((await fetch_media(other, resource_id)).status).toBe(403);
		await add_to_library(other, [t0]);
		expect((await fetch_media(other, resource_id)).status).toBe(200);
	});

	it('asks for downloaded tracks whose only lyrics are unsynced', async () => {
		const user = await create_user('media-lyrics');
		const created = await contribute(user, mock_album({ artist: unique('Lyrics Media'), album: unique('Lyrics Media Album'), n: 4 }));
		const [plain, synced, both, none] = [0, 1, 2, 3].map(i => created.body.refs[`t${i}`] as string);
		await add_to_library(user, [plain, synced, both, none], { downloaded_at: new Date().toISOString() });
		const add_lyrics = (track_id: string, sync_type: string) => query(
			`insert into track_lyrics_table (track_id, service, sync_type, format, raw_content, content_hash) values ($1, 'LRCLIB', $2, 'PLAIN', $3, md5($3) || md5($3))`,
			[track_id, sync_type, `${track_id} ${sync_type}`]
		);
		await add_lyrics(plain, 'NONE');
		await add_lyrics(synced, 'LINE');
		await add_lyrics(both, 'NONE');
		await add_lyrics(both, 'WORD');

		const requests = await api('GET', '/media/requests', { token: user.access_token });
		expect(requests.body.actions.map((a: { track_id: string }) => a.track_id)).toEqual([plain]);
	});

	it('serves detected vocals once the analyzer has stored them', async () => {
		const user = await create_user('vocals');
		const created = await contribute(user, mock_album({ artist: unique('Vocals Artist'), album: unique('Vocals Album'), n: 1 }));
		const t0: string = created.body.refs.t0;
		expect((await api('GET', `/tracks/${t0}/vocals`, { token: user.access_token })).status).toBe(404);
		await query(`insert into track_vocals_table (track_id, resource_id, status) values ($1, 'failed.m4a', 'BAD_FILE')`, [t0]);
		expect((await api('GET', `/tracks/${t0}/vocals`, { token: user.access_token })).status).toBe(404);
		await query(
			`update track_vocals_table set resource_id = 'x.m4a', status = 'DONE', model = 'm', hop_ms = 256, window_ms = 2048, duration_ms = 30000,
				voice = '{0.01,0.9,0.95}', segments = '{9856,17024}' where track_id = $1`,
			[t0]
		);
		const vocals = await api('GET', `/tracks/${t0}/vocals`, { token: user.access_token });
		expect(vocals.status).toBe(200);
		expect(vocals.body).toMatchObject({
			track_id: t0, resource_id: 'x.m4a', hop_ms: 256, window_ms: 2048, duration_ms: 30_000,
			segments: [{ start_ms: 9856, end_ms: 17_024 }]
		});
		expect(vocals.body.voice).toHaveLength(3);
		expect(vocals.body.voice[1]).toBeCloseTo(0.9);
		expect(vocals.body.rhythm).toBeNull();
		expect(vocals.body).toMatchObject({ words: null, speech: null, beat_grid: null });

		await query(`update track_vocals_table set rhythm_model = 'r', rhythm_bpm = 120, rhythm_confidence = 3.4, beats = '{500,1000}', bpm_estimates = '{120}' where track_id = $1`, [t0]);
		const timed = await api('GET', `/tracks/${t0}/vocals`, { token: user.access_token });
		expect(timed.body.rhythm).toMatchObject({ model: 'r', bpm: 120, beats_ms: [500, 1000], bpm_estimates: [120] });
		expect(timed.body.rhythm.confidence).toBeCloseTo(3.4);

		await query(`update track_vocals_table set words_model = 'w', words = '{hi,there}', word_times = '{100,200,300,450}', word_probabilities = '{0.5,1}', speech_model = 's', speech_hop_ms = 32, speech = '{0.25}', beat_grid_model = 'g', grid_beats = '{500,1000}', downbeats = '{500}' where track_id = $1`, [t0]);
		const aligned = await api('GET', `/tracks/${t0}/vocals`, { token: user.access_token });
		expect(aligned.body).toMatchObject({
			words: { model: 'w', words: [{ text: 'hi', start_ms: 100, end_ms: 200, probability: 0.5 }, { text: 'there', start_ms: 300, end_ms: 450, probability: 1 }] },
			speech: { model: 's', hop_ms: 32, voice: [0.25] },
			beat_grid: { model: 'g', beats_ms: [500, 1000], downbeats_ms: [500] }
		});
	});

	it('serves the alignment analysis once the analyzer has stored it', async () => {
		const user = await create_user('alignment');
		const created = await contribute(user, mock_album({ artist: unique('Alignment Artist'), album: unique('Alignment Album'), n: 1 }));
		const t0: string = created.body.refs.t0;
		expect((await api('GET', `/tracks/${t0}/alignment`, { token: user.access_token })).status).toBe(404);
		await query(`insert into track_alignment_table (track_id, resource_id, status) values ($1, 'failed.m4a', 'BAD_FILE')`, [t0]);
		expect((await api('GET', `/tracks/${t0}/alignment`, { token: user.access_token })).status).toBe(404);
		await query(
			`update track_alignment_table set resource_id = 'x.m4a', status = 'DONE', model = 'm', duration_ms = 30000, frame_ms = 20, alphabet = '-ab', letter_scale = 4,
				letters = '\\x000102030405', loudness = '\\x0709', words_model = 'w', words = '{hi,there}', word_times = '{100,200,300,450}', word_probabilities = '{0.5,1}',
				beat_grid_model = 'g', grid_beats = '{500,1000}', downbeats = '{500}', repeats = '{2000,4000,1000}', repeat_strengths = '{0.5}' where track_id = $1`,
			[t0]
		);
		const aligned = await api('GET', `/tracks/${t0}/alignment`, { token: user.access_token });
		expect(aligned.status).toBe(200);
		expect(aligned.body).toMatchObject({
			track_id: t0, resource_id: 'x.m4a', model: 'm', duration_ms: 30_000, frame_ms: 20, alphabet: '-ab', letter_scale: 4,
			letters: Buffer.from([0, 1, 2, 3, 4, 5]).toString('base64'), loudness: Buffer.from([7, 9]).toString('base64'),
			words: { model: 'w', words: [{ text: 'hi', start_ms: 100, end_ms: 200, probability: 0.5 }, { text: 'there', start_ms: 300, end_ms: 450, probability: 1 }] },
			beat_grid: { model: 'g', beats_ms: [500, 1000], downbeats_ms: [500] },
			repeats: [{ start_ms: 2000, end_ms: 4000, lag_ms: 1000, strength: 0.5 }]
		});
		expect(typeof aligned.body.analyzed_at).toBe('string');
		expect((await api('GET', `/tracks/${uuid()}/alignment`, { token: user.access_token })).status).toBe(404);
	});

	it('rejects non-audio files and tracks outside the user\'s library', async () => {
		const user = await create_user('media-bad');
		const created = await contribute(user, mock_album({ artist: unique('Bad Media'), album: unique('Bad Media Album'), n: 1 }));
		const t0 = created.body.refs.t0;
		const not_audio = await upload(user, t0, Buffer.from('#!/bin/sh\necho definitely not audio\n'.repeat(20)), {}, 'audio/wav');
		expect([403, 415]).toContain(not_audio.status);
		await add_to_library(user, [t0]);
		const after = await upload(user, t0, Buffer.from('<html>not audio</html>'.repeat(20)), {}, 'audio/wav');
		expect(after.status).toBe(415);
		expect((await upload(user, uuid(), wav_bytes())).status).toBe(404);
		expect((await api('GET', '/media/..%2F..%2Fetc%2Fpasswd', { token: user.access_token })).status).toBe(400);
	});
});

function fetch_media(user: TestUser, resource_id: string, headers: Record<string, string> = {}) {
	return fetch(`${API_BASE}/media/${resource_id}`, { headers: { authorization: `Bearer ${user.access_token}`, ...headers } });
}

describe('playlist copy (§10.2)', () => {
	it('copies another user\'s public playlist as a private one, and hides private ones', async () => {
		const owner = await create_user('pl-owner');
		const fan = await create_user('pl-fan');
		const created = await contribute(owner, mock_album({ artist: unique('PL Artist'), album: unique('PL Album'), n: 3 }));
		const tracks = [created.body.refs.t0, created.body.refs.t1, created.body.refs.t2];
		const now = new Date().toISOString();
		const [pub, priv] = [uuid(), uuid()];
		await api('POST', '/sync/push', {
			token: owner.access_token,
			body: {
				push_id: uuid(),
				changes: {
					playlists: [{ id: pub, title: 'Public Mix', public: true, edited_at: now }, { id: priv, title: 'Secret Mix', edited_at: now }],
					playlist_tracks: [...tracks.map(track_id => ({ playlist_id: pub, track_id, edited_at: now })), { playlist_id: priv, track_id: tracks[0], edited_at: now }]
				}
			}
		});

		const copy = await api('POST', `/playlists/${pub}/copy`, { token: fan.access_token });
		expect(copy.status).toBe(201);
		const new_id = copy.body.id ?? copy.body.playlist?.id;
		const [row] = await query(`select user_id, title, public from playlists_table where id = $1`, [new_id]);
		expect(row).toMatchObject({ user_id: fan.id, public: false });
		const copied = await query(`select track_id from playlist_tracks_table where playlist_id = $1 and not deleted`, [new_id]);
		expect(copied.map(r => r.track_id).sort()).toEqual([...tracks].sort());

		expect((await api('POST', `/playlists/${priv}/copy`, { token: fan.access_token })).status).toBe(404);
		expect((await api('POST', `/playlists/${uuid()}/copy`, { token: fan.access_token })).status).toBe(404);
	});
});

describe('admin review (§11)', () => {
	it('is admin-only, re-checking the role in the database', async () => {
		const user = await create_user('not-admin');
		expect((await api('GET', '/admin/review', { token: user.access_token })).status).toBe(403);
		const admin = await make_admin(await create_user('admin'));
		expect((await api('GET', '/admin/review', { token: admin.access_token })).status).toBe(200);
		// Demotion takes effect immediately, even with a token that still says ADMIN.
		await query(`update users_table set role = 'USER' where id = $1`, [admin.id]);
		expect((await api('GET', '/admin/review', { token: admin.access_token })).status).toBe(403);
	});

	it('lists a field conflict, applies the proposed value, and edits entities directly', async () => {
		const admin = await make_admin(await create_user('admin2'));
		const a = await create_user('rev-a');
		const b = await create_user('rev-b');
		const created = await contribute(a, mock_album({ artist: unique('Review Artist'), album: unique('Review Album'), n: 1 }));
		const track_id = created.body.refs.t0;
		const title = (await query(`select title from tracks_table where id = $1`, [track_id]))[0].title;
		await contribute(b, { tracks: [{ ref: track_id, title, duration_ms: 240_000 }] });

		const list = await api('GET', '/admin/review?kind=FIELD_CONFLICT&limit=100', { token: admin.access_token });
		const item = list.body.items.find((i: { entity_id: string; field: string }) => i.entity_id === track_id && i.field === 'duration_ms');
		expect(item).toBeDefined();
		const applied = await api('POST', `/admin/review/${item.id}/apply`, { token: admin.access_token, body: {} });
		expect(applied.status).toBe(200);
		expect((await query(`select duration_ms from tracks_table where id = $1`, [track_id]))[0].duration_ms).toBe('240000');
		expect((await query(`select status from review_items_table where id = $1`, [item.id]))[0].status).toBe('APPLIED');
		expect((await api('POST', `/admin/review/${item.id}/dismiss`, { token: admin.access_token })).status).toBe(409);

		const patched = await api('PATCH', `/admin/entities/tracks/${track_id}`, { token: admin.access_token, body: { title: `${title} (Admin Fix)`, explicit: true } });
		expect(patched.status).toBe(200);
		expect(await query(`select title, explicit from tracks_table where id = $1`, [track_id])).toEqual([{ title: `${title} (Admin Fix)`, explicit: true }]);
		const audit = await query(`select action, actor_user_id from audit_log_table where entity_id = $1 order by id`, [track_id]);
		expect(audit.map(r => r.actor_user_id)).toContain(admin.id);
		expect((await api('PATCH', `/admin/entities/users/${a.id}`, { token: admin.access_token, body: { role: 'ADMIN' } })).status).toBe(404);
	});
});
