import { beforeAll, describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

let user: TestUser;
let other: TestUser;
let track_id: string;
let album_id: string;
let artist_id: string;

const bad_cursor = (o: unknown) => Buffer.from(JSON.stringify({ o })).toString('base64url');

const expect_error = (res: { status: number; body: any }, status: number, message?: string) => {
	expect(res.status).toBe(status);
	expect(typeof res.body.error).toBe('string');
	if (message) expect(res.body.error).toBe(message);
};

beforeAll(async () => {
	user = await create_user('catalog');
	other = await create_user('catalog-other');
	const created = await contribute(user, mock_album({ artist: unique('Cat Artist'), album: unique('Cat Album'), n: 3 }));
	track_id = created.body.refs.t0;
	album_id = created.body.refs.al;
	artist_id = created.body.refs.ar;
	await add_to_library(user, [created.body.refs.t0, created.body.refs.t1, created.body.refs.t2]);
});

describe('catalog auth', () => {
	it('requires a token on every read route', async () => {
		const paths = [
			'/me', '/me/library', '/me/playlists', '/me/plays', '/me/recent_searches', '/me/linked_playlists', '/playlists/public',
			`/playlists/${uuid()}`, `/playlists/${uuid()}/tracks`, `/users/${user.id}/playlists`, `/tracks/${track_id}`, `/tracks/${track_id}/similar`,
			`/tracks/${track_id}/vocals`, `/albums/${album_id}`, `/artists/${artist_id}`, `/artists/${artist_id}/albums`, `/artists/${artist_id}/tracks`,
			`/artists/${artist_id}/similar`, '/search?q=a', '/search/suggestions?q=a'
		];
		for (const path of paths) expect_error(await api('GET', path), 401, 'missing access token');
		expect_error(await api('POST', '/tracks/batch', { body: { ids: [track_id] } }), 401, 'missing access token');
		expect_error(await api('GET', '/me', { token: 'bad.token.value' }), 401, 'invalid or expired access token');
	});
});

describe('catalog ids', () => {
	it('rejects malformed uuids with 400 and the entity name', async () => {
		const cases: [string, string][] = [
			['/tracks/nope', 'invalid track id'], ['/tracks/nope/similar', 'invalid track id'], ['/tracks/nope/vocals', 'invalid track id'],
			['/albums/nope', 'invalid album id'], ['/artists/nope', 'invalid artist id'], ['/artists/nope/albums', 'invalid artist id'],
			['/artists/nope/tracks', 'invalid artist id'], ['/artists/nope/similar', 'invalid artist id'], ['/playlists/nope', 'invalid playlist id'],
			['/playlists/nope/tracks', 'invalid playlist id'], ['/users/nope/playlists', 'invalid user id']
		];
		for (const [path, message] of cases) expect_error(await api('GET', path, { token: user.access_token }), 400, message);
	});

	it('answers unknown but well formed ids with 404', async () => {
		const cases: [string, string][] = [
			[`/tracks/${uuid()}`, 'track not found'], [`/albums/${uuid()}`, 'album not found'], [`/artists/${uuid()}`, 'artist not found'],
			[`/playlists/${uuid()}`, 'playlist not found'], [`/playlists/${uuid()}/tracks`, 'playlist not found'],
			[`/tracks/${track_id}/vocals`, 'no vocals detected for this track']
		];
		for (const [path, message] of cases) expect_error(await api('GET', path, { token: user.access_token }), 404, message);
	});

	it('returns empty pages for the playlists of an unknown user', async () => {
		const res = await api('GET', `/users/${uuid()}/playlists`, { token: user.access_token });
		expect(res.body).toEqual({ items: [], next_cursor: null });
	});
});

describe('catalog paging', () => {
	const paged = (path: string) => [`${path}?limit=0`, `${path}?limit=201`, `${path}?limit=abc`, `${path}?limit=1.5`, `${path}?cursor=garbage`, `${path}?cursor=${bad_cursor(-1)}`, `${path}?cursor=${bad_cursor('x')}`];

	it('rejects bad limits and cursors on paged routes', async () => {
		const paths = ['/me/library', '/me/plays', '/playlists/public', `/users/${user.id}/playlists`, `/artists/${artist_id}/albums`, `/artists/${artist_id}/tracks`];
		for (const base of paths) {
			for (const path of paged(base)) {
				const res = await api('GET', path, { token: user.access_token });
				expect_error(res, 400);
				expect(res.body.error).toMatch(/^invalid (query|cursor)$/u);
			}
		}
	});

	it('rejects an oversize cursor', async () => {
		expect_error(await api('GET', `/me/library?cursor=${'a'.repeat(257)}`, { token: user.access_token }), 400, 'invalid query');
	});

	it('pages the library through next_cursor without gaps or repeats', async () => {
		const first = await api('GET', '/me/library?limit=2', { token: user.access_token });
		expect(first.body.items).toHaveLength(2);
		expect(typeof first.body.next_cursor).toBe('string');
		const second = await api('GET', `/me/library?limit=2&cursor=${first.body.next_cursor}`, { token: user.access_token });
		expect(second.body.items).toHaveLength(1);
		expect(second.body.next_cursor).toBeNull();
		const ids = [...first.body.items, ...second.body.items].map((t: { id: string }) => t.id);
		expect(new Set(ids).size).toBe(3);
	});

	it('returns an empty last page for a cursor past the end', async () => {
		const res = await api('GET', `/me/library?cursor=${bad_cursor(100)}`, { token: user.access_token });
		expect(res.body).toEqual({ items: [], next_cursor: null });
	});

	it('rejects an unknown library sort and an oversize q', async () => {
		expect_error(await api('GET', '/me/library?sort=nope', { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', `/me/library?q=${'a'.repeat(257)}`, { token: user.access_token }), 400, 'invalid query');
	});

	it('filters the library with q and keeps the other user out', async () => {
		expect((await api('GET', '/me/library?q=zzzznomatch', { token: user.access_token })).body.items).toEqual([]);
		expect((await api('GET', '/me/library', { token: other.access_token })).body.items).toEqual([]);
	});

	it('validates the other list routes', async () => {
		expect_error(await api('GET', '/me/recent_searches?limit=0', { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', '/me/recent_searches?limit=201', { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', `/tracks/${track_id}/similar?limit=101`, { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', `/artists/${artist_id}/similar?limit=0`, { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', '/me/playlists?include_archived=maybe', { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', '/me/playlists?include_deleted=yes', { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', `/artists/${artist_id}/albums?album_type=NOPE`, { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', `/artists/${artist_id}/tracks?sort=random`, { token: user.access_token }), 400, 'invalid query');
	});

	it('returns query issues in the 400 body', async () => {
		const res = await api('GET', '/me/library?limit=0', { token: user.access_token });
		expect(res.body.issues[0].path).toEqual(['limit']);
	});

	it('accepts numeric and boolean flag spellings', async () => {
		for (const flag of ['true', 'false', '1', '0']) {
			expect((await api('GET', `/me/playlists?include_archived=${flag}&include_deleted=${flag}`, { token: user.access_token })).status).toBe(200);
		}
	});
});

describe('catalog search validation', () => {
	it('rejects a missing, blank or oversize q', async () => {
		for (const path of ['/search', '/search?q=', '/search?q=%20%20', `/search?q=${'a'.repeat(257)}`]) {
			expect_error(await api('GET', path, { token: user.access_token }), 400, 'invalid query');
		}
	});

	it('rejects unknown types and scopes', async () => {
		expect_error(await api('GET', '/search?q=a&types=track,bogus', { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', '/search?q=a&scope=everywhere', { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', `/search?q=a&types=${'track,'.repeat(20)}`, { token: user.access_token }), 400, 'invalid query');
	});

	it('needs exactly one type for a cursor', async () => {
		const cursor = bad_cursor(0);
		expect_error(await api('GET', `/search?q=a&cursor=${cursor}`, { token: user.access_token }), 400, 'cursor needs exactly one type');
		expect_error(await api('GET', `/search?q=a&types=track,album&cursor=${cursor}`, { token: user.access_token }), 400, 'cursor needs exactly one type');
		expect((await api('GET', `/search?q=a&types=track&cursor=${cursor}`, { token: user.access_token })).status).toBe(200);
		expect_error(await api('GET', '/search?q=a&types=track&cursor=bad', { token: user.access_token }), 400, 'invalid cursor');
	});

	it('returns only the requested result groups, ignoring blanks and repeats', async () => {
		const res = await api('GET', '/search?q=a&types=track,,track,%20album', { token: user.access_token });
		expect(Object.keys(res.body).sort()).toEqual(['albums', 'tracks']);
		const all = await api('GET', '/search?q=a&types=', { token: user.access_token });
		expect(Object.keys(all.body).sort()).toEqual(['albums', 'artists', 'playlists', 'tracks']);
	});

	it('validates suggestions', async () => {
		expect_error(await api('GET', '/search/suggestions?limit=0', { token: user.access_token }), 400, 'invalid query');
		expect_error(await api('GET', `/search/suggestions?q=${'a'.repeat(257)}`, { token: user.access_token }), 400, 'invalid query');
		expect((await api('GET', '/search/suggestions', { token: user.access_token })).status).toBe(200);
	});
});

describe('tracks batch', () => {
	it('rejects missing, empty, oversize and malformed id lists', async () => {
		for (const body of [{}, { ids: [] }, { ids: ['nope'] }, { ids: 'x' }, { ids: Array.from({ length: 501 }, uuid) }, { ids: [1] }]) {
			expect_error(await api('POST', '/tracks/batch', { token: user.access_token, body }), 400, 'invalid body');
		}
	});

	it('accepts 500 ids, reports unknown ones as missing and keeps duplicates', async () => {
		const ghost = uuid();
		const res = await api('POST', '/tracks/batch', { token: user.access_token, body: { ids: [track_id, ghost, track_id] } });
		expect(res.status).toBe(200);
		expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([track_id, track_id]);
		expect(res.body.missing).toEqual([ghost]);
		const max = await api('POST', '/tracks/batch', { token: user.access_token, body: { ids: Array.from({ length: 500 }, uuid) } });
		expect(max.status).toBe(200);
		expect(max.body.missing).toHaveLength(500);
	});

	it('answers an oversize body with 413', async () => {
		const res = await api('POST', '/tracks/batch', { token: user.access_token, body: { ids: Array.from({ length: 3_000 }, uuid) } });
		expect_error(res, 413);
	});
});

describe('playlist visibility between users', () => {
	it('hides private playlists from other users and lists only public ones', async () => {
		const pub = uuid();
		const priv = uuid();
		const edited_at = new Date().toISOString();
		const title = unique('Visible');
		const pushed = await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: {
			playlists: [{ id: pub, title, public: true, edited_at }, { id: priv, title: unique('Hidden'), public: false, edited_at }],
			playlist_tracks: [{ playlist_id: pub, track_id, edited_at }, { playlist_id: priv, track_id, edited_at }]
		} } });
		expect(pushed.status).toBe(200);

		expect(( await api('GET', `/playlists/${pub}`, { token: other.access_token })).status).toBe(200);
		expect_error(await api('GET', `/playlists/${priv}`, { token: other.access_token }), 404, 'playlist not found');
		expect_error(await api('GET', `/playlists/${priv}/tracks`, { token: other.access_token }), 404, 'playlist not found');
		expect((await api('GET', `/playlists/${priv}`, { token: user.access_token })).status).toBe(200);

		const theirs = await api('GET', `/users/${user.id}/playlists`, { token: other.access_token });
		expect(theirs.body.items.map((p: { id: string }) => p.id)).toEqual([pub]);
		const mine = await api('GET', `/users/${user.id}/playlists`, { token: user.access_token });
		expect(mine.body.items.map((p: { id: string }) => p.id).sort()).toEqual([pub, priv].sort());

		const found = await api('GET', `/playlists/public?q=${encodeURIComponent(title)}`, { token: other.access_token });
		expect(found.body.items.map((p: { id: string }) => p.id)).toEqual([pub]);
		const wildcard = await api('GET', '/playlists/public?q=%25', { token: other.access_token });
		expect(wildcard.status).toBe(200);
		expect(wildcard.body.items).toEqual([]);
	});

	it('hides a deleted public playlist from other users but not its owner', async () => {
		const id = uuid();
		const edited_at = new Date().toISOString();
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: { playlists: [{ id, title: unique('Gone'), public: true, edited_at }] } } });
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: { playlists: [{ id, deleted: true, edited_at: new Date(Date.now() + 1000).toISOString() }] } } });
		expect_error(await api('GET', `/playlists/${id}`, { token: other.access_token }), 404, 'playlist not found');
		expect((await api('GET', `/playlists/${id}`, { token: user.access_token })).status).toBe(200);
		expect((await api('GET', `/playlists/${id}/tracks`, { token: user.access_token })).body.items).toEqual([]);
		const listed = await api('GET', '/me/playlists?include_deleted=true', { token: user.access_token });
		expect(listed.body.items.some((p: { id: string }) => p.id === id)).toBe(true);
		const hidden = await api('GET', '/me/playlists', { token: user.access_token });
		expect(hidden.body.items.some((p: { id: string }) => p.id === id)).toBe(false);
	});
});

describe('catalog rate limit', () => {
	it('answers 429 once search suggestions exceed their per-user budget', async () => {
		const limited = await create_user('catalog-rl');
		let last = 0;
		for (let i = 0; i < 301; i++) last = (await api('GET', '/search/suggestions?limit=1', { token: limited.access_token })).status;
		expect(last).toBe(429);
		const res = await api('GET', '/search/suggestions', { token: limited.access_token });
		expect_error(res, 429, 'rate limited');
		expect((await api('GET', '/search/suggestions', { token: user.access_token })).status).toBe(200);
	}, 60_000);
});
