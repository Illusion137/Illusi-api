import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, uuid } from './helpers';
import type { TestUser } from './helpers';

interface Ref { id: string; name: string }
interface Suggestions {
	tracks: { id: string; title: string; artists: Ref[]; album: Ref | null; duration_ms: number | null; explicit: boolean | null; thumbnail: { url: string } | null; in_library: boolean }[];
	artists: { id: string; name: string; thumbnail: unknown; in_library: boolean }[];
	albums: {
		id: string; name: string; artists: Ref[]; album_type: string | null; release_date: string | null; track_count: number | null; thumbnail: { url: string; width: number | null } | null;
		in_library: boolean;
	}[];
	text: { text: string; kind: string }[];
}

function suggestions(user: TestUser, q: string, headers: Record<string, string> = {}) {
	return api<Suggestions>('GET', `/search/suggestions?q=${encodeURIComponent(q)}`, { token: user.access_token, headers });
}

describe('search suggestions', () => {
	it('suggests tracks, artists, albums and text, boosted by the library and recent searches', async () => {
		const user = await create_user('suggest');
		// Made-up words, so earlier runs against the same database can't crowd the results.
		const tag = randomBytes(4).toString('hex');
		const artist = `Qv${tag} Orchestra`;
		const album = `Lumen${tag}`;
		const created = await contribute(user, mock_album({ artist, album, n: 3 }));
		expect(created.status).toBe(200);
		const { t0, t1, t2, al, ar } = created.body.refs as Record<string, string>;

		const short = await suggestions(user, 'l');
		expect(short.status).toBe(200);
		expect(short.body).toEqual({ tracks: [], artists: [], albums: [], text: [] });

		const by_album = await suggestions(user, `lumen${tag}`);
		expect(by_album.status).toBe(200);
		expect(by_album.body.albums[0]).toMatchObject({
			id: al, name: album, artists: [{ id: ar, name: artist }], album_type: 'ALBUM', track_count: 3, in_library: false
		});
		expect(by_album.body.albums[0].release_date?.startsWith('2020-01-01')).toBe(true);
		expect(by_album.body.albums[0].thumbnail?.width).toBe(600);
		// Prefix matches lead; weaker (trigram) matches may fill the rest.
		expect(by_album.body.tracks.slice(0, 3).map(t => t.id).sort()).toEqual([t0, t1, t2].sort());
		expect(by_album.body.tracks[0]).toMatchObject({ artists: [{ id: ar, name: artist }], album: { id: al, name: album } });
		expect(by_album.body.tracks.find(t => t.id === t0)?.duration_ms).toBe(180_000);
		expect(by_album.body.text.map(t => t.text)).toContain(`${album} Track 1`);

		// Accents and case fold like search; the artist is suggested by prefix.
		const by_artist = await suggestions(user, `QV${tag} ORCHÉ`);
		expect(by_artist.body.artists[0]).toMatchObject({ id: ar, name: artist });
		expect(by_artist.body.text[0]).toEqual({ text: artist, kind: 'artist' });

		// "artist title": the leading words name the artist, the rest narrows its tracks.
		const combo = await suggestions(user, `qv${tag} orchestra lumen${tag} track 2`);
		expect(combo.body.tracks[0].id).toBe(t1);

		// Library tracks come first within the same match tier.
		await add_to_library(user, [t2]);
		const boosted = await suggestions(user, `lumen${tag} track`);
		expect(boosted.body.tracks[0]).toMatchObject({ id: t2, in_library: true });
		expect((await suggestions(user, `qv${tag}`)).body.artists[0]).toMatchObject({ id: ar, in_library: true });
		expect((await suggestions(user, album)).body.albums[0]).toMatchObject({ id: al, in_library: true });

		// Matching recent searches lead the text completions.
		const push = await api('POST', '/sync/push', {
			token: user.access_token,
			body: { push_id: uuid(), changes: { recent_searches: [{ client_id: uuid(), text: `lumen${tag} live`, created_at: new Date().toISOString() }] } }
		});
		expect(push.status).toBe(200);
		const recent = await suggestions(user, `lumen${tag}`);
		expect(recent.body.text[0]).toEqual({ text: `lumen${tag} live`, kind: 'recent' });
	});

	it('answers 304 until the user or catalog changes', async () => {
		const user = await create_user('suggest-etag');
		const tag = randomBytes(4).toString('hex');
		const created = await contribute(user, mock_album({ artist: `Etagartist${tag}`, album: `Etagalbum${tag}`, n: 1 }));
		const q = `etagalbum${tag}`;

		const first = await suggestions(user, q);
		const etag = first.headers.get('etag');
		expect(etag).toBeTruthy();
		expect(first.headers.get('cache-control')).toBe('private, max-age=30');
		expect((await suggestions(user, q, { 'if-none-match': etag! })).status).toBe(304);

		await add_to_library(user, [created.body.refs.t0 as string]);
		const changed = await suggestions(user, q, { 'if-none-match': etag! });
		expect(changed.status).toBe(200);
		expect(changed.body.tracks[0].in_library).toBe(true);
	});

	it('validates the query', async () => {
		const user = await create_user('suggest-bad');
		expect((await api('GET', '/search/suggestions?q=abc&limit=0', { token: user.access_token })).status).toBe(400);
		expect((await api('GET', `/search/suggestions?q=${'a'.repeat(300)}`, { token: user.access_token })).status).toBe(400);
		expect((await api('GET', '/search/suggestions?q=abc')).status).toBe(401);
	});
});
