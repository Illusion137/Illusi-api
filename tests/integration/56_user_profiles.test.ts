import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, unique, uuid } from './helpers';
import type { TestUser } from './helpers';

async function seed(user: TestUser, imported: boolean) {
	const graph = mock_album({ artist: unique('Profile Artist'), album: unique('Profile Album'), n: 2, imported });
	const res = await contribute(user, graph);
	expect(res.status).toBe(200);
	const refs: Record<string, string> = res.body.refs;
	return graph.tracks.map(t => refs[t.ref]);
}

const ids = (items: { id: string }[]) => items.map(i => i.id);

async function set_public_imports(user: TestUser, public_imports: boolean) {
	const res = await api('PATCH', '/me/settings', { token: user.access_token, body: { public_imports } });
	expect(res.status).toBe(200);
	expect(res.body).toEqual({ public_imports });
}

describe('user profiles', () => {
	it('shows public playlists, and imports only when the owner makes them public', async () => {
		const owner = await create_user('profile-owner');
		const viewer = await create_user('profile-viewer');
		const imported = await seed(owner, true);
		const catalog = await seed(owner, false);
		await add_to_library(owner, [...imported, ...catalog]);
		const shared = uuid();
		const now = new Date().toISOString();
		const push = await api('POST', '/sync/push', {
			token: owner.access_token,
			body: { push_id: uuid(), changes: { playlists: [{ id: shared, title: 'Shared', public: true, edited_at: now }, { id: uuid(), title: 'Mine', edited_at: now }] } }
		});
		expect(push.status).toBe(200);

		const me = await api('GET', '/auth/me', { token: owner.access_token });
		expect(me.body.public_imports).toBe(false);

		const own = await api('GET', `/users/${owner.id}`, { token: owner.access_token });
		expect(own.body).toMatchObject({ id: owner.id, is_self: true, public_imports: false, playlist_count: 2, import_count: 2 });
		const own_imports = await api('GET', `/users/${owner.id}/imports`, { token: owner.access_token });
		expect(new Set(ids(own_imports.body.items))).toEqual(new Set(imported));

		const hidden = await api('GET', `/users/${owner.id}`, { token: viewer.access_token });
		expect(hidden.status).toBe(200);
		expect(hidden.body).toMatchObject({ is_self: false, public_imports: false, playlist_count: 1, import_count: null });
		const refused = await api('GET', `/users/${owner.id}/imports`, { token: viewer.access_token });
		expect(refused.status).toBe(403);
		expect(refused.body.code).toBe('IMPORTS_PRIVATE');

		await set_public_imports(owner, true);
		const shown = await api('GET', `/users/${owner.id}`, { token: viewer.access_token });
		expect(shown.body).toMatchObject({ public_imports: true, import_count: 2 });
		const listed = await api('GET', `/users/${owner.id}/imports?limit=1`, { token: viewer.access_token });
		expect(listed.status).toBe(200);
		expect(listed.body.items).toHaveLength(1);
		const rest = await api('GET', `/users/${owner.id}/imports?limit=1&cursor=${listed.body.next_cursor}`, { token: viewer.access_token });
		expect(new Set([...ids(listed.body.items), ...ids(rest.body.items)])).toEqual(new Set(imported));
		expect(rest.body.next_cursor).toBeNull();
		// The viewer's own overlay, not the owner's library row
		expect(listed.body.items[0].user).toBeNull();

		await set_public_imports(owner, false);
		expect((await api('GET', `/users/${owner.id}/imports`, { token: viewer.access_token })).status).toBe(403);
	});

	it('hides users with nothing public, and validates input', async () => {
		const quiet = await create_user('profile-quiet');
		const viewer = await create_user('profile-viewer');
		expect((await api('GET', `/users/${quiet.id}`, { token: viewer.access_token })).status).toBe(404);
		expect((await api('GET', `/users/${uuid()}`, { token: viewer.access_token })).status).toBe(404);
		expect((await api('GET', '/users/not-a-uuid', { token: viewer.access_token })).status).toBe(400);

		await set_public_imports(quiet, true);
		expect((await api('GET', `/users/${quiet.id}`, { token: viewer.access_token })).body).toMatchObject({ playlist_count: 0, import_count: 0 });

		expect((await api('PATCH', '/me/settings', { token: quiet.access_token, body: { public_imports: 'yes' } })).status).toBe(400);
		expect((await api('PATCH', '/me/settings', { token: quiet.access_token, body: { username: 'x' } })).status).toBe(400);
		expect((await api('PATCH', '/me/settings', { token: quiet.access_token, body: {} })).body).toEqual({ public_imports: true });
	});
});
