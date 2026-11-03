import { afterAll, describe, expect, it } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
afterAll(async () => { await app.stop(); });
const { api, contribute, create_user, make_admin, mock_album, query, unique } = await import('./helpers');

const next_id = () => 2_000_000_000 + Math.floor(Math.random() * 900_000_000);

describe('admin review context (in-process)', () => {
	it('shows the linked iTunes, Genius and SoundCloud rows and the group of a service id conflict', async () => {
		const admin = await make_admin(await create_user('rev-ctx-admin'));
		const user = await create_user('rev-ctx');
		const created = await contribute(user, mock_album({ artist: unique('Ctx Artist'), album: unique('Ctx Album'), n: 2 }));
		const [track, other_track] = [created.body.refs.t0 as string, created.body.refs.t1 as string];
		const [album, artist] = [created.body.refs.al as string, created.body.refs.ar as string];
		const [apple_track, apple_album, apple_artist, genius_song, genius_artist, sc_track] = [next_id(), next_id() + 1, next_id() + 2, next_id() + 3, next_id() + 4, next_id() + 5];

		await query('insert into itunes_tracks_table (id, name) values ($1, $2)', [apple_track, 'Apple Track']);
		await query('insert into itunes_collections_table (id, name) values ($1, $2)', [apple_album, 'Apple Album']);
		await query('insert into itunes_artists_table (id, name) values ($1, $2)', [apple_artist, 'Apple Artist']);
		await query('insert into genius_artists_table (id, name) values ($1, $2)', [genius_artist, 'Genius Artist']);
		await query('insert into genius_songs_table (id, title) values ($1, $2)', [genius_song, 'Genius Song']);
		await query('insert into soundcloud_tracks_table (id, title) values ($1, $2)', [sc_track, 'SC Track']);
		await query('update service_ids_table set applemusic_id = $2, genius_id = $3, soundcloud_id = $4 where illusi_id = $1', [track, String(apple_track), genius_song, sc_track]);
		await query('update service_ids_table set applemusic_id = $2 where illusi_id = $1', [album, String(apple_album)]);
		await query('update service_ids_table set applemusic_id = $2, genius_id = $3 where illusi_id = $1', [artist, String(apple_artist), genius_artist]);

		const item = async (entity_table: string, entity_id: string, extra: { kind?: string; proposed?: unknown } = {}) => {
			const [{ id }] = await query<{ id: number }>(
				`insert into review_items_table (kind, entity_table, entity_id, field, proposed_values, dedupe_key) values ($1, $2, $3, 'title', $4, $5) returning id`,
				[extra.kind ?? 'FIELD_CONFLICT', entity_table, entity_id, JSON.stringify(extra.proposed ?? []), unique('dd')]
			);
			return id;
		};
		const [conflict] = await query<{ id: number }>(`insert into service_id_conflicts_table (illusi_id, "column", incoming_value, source, other_illusi_id) values ($1, 'spotify_id', 'x', 'test', $2) returning id`, [track, other_track]);
		const track_item = await item('tracks_table', track);
		const album_item = await item('albums_table', album);
		const artist_item = await item('artists_table', artist);
		const unknown_item = await item('tracks_table', 'not-a-uuid');
		const plan = { group_key: track, kind: 'track', node_ids: [track, other_track], steps: [], conflict_ids: [conflict.id] };
		const group_item = await item('tracks_table', track, { kind: 'SERVICE_ID_CONFLICT', proposed: [{ value: {}, plan, source_user_ids: [], occurrences: 1 }] });

		const list = await api('GET', '/admin/review?limit=100&sort=age&order=desc', { token: admin.access_token });
		expect(list.status).toBe(200);
		const by_id = new Map(list.body.items.map((i: { id: number }) => [i.id, i]));
		const links = (id: number) => (by_id.get(id) as { context: { links: Record<string, { id?: unknown } | null>; kind: string | null } }).context;
		expect(links(track_item).kind).toBe('track');
		expect(Object.keys(links(track_item).links).sort()).toEqual(['genius', 'itunes', 'soundcloud']);
		expect(links(album_item).links.itunes).toMatchObject({ name: 'Apple Album' });
		expect(links(artist_item).links).toMatchObject({ itunes: { name: 'Apple Artist' }, genius: { name: 'Genius Artist' } });
		expect(links(unknown_item).kind).toBeNull();
		const group = by_id.get(group_item) as { group: unknown[]; conflicts: { id: number }[] };
		expect(group.group).toHaveLength(1);
		expect(group.conflicts.map(c => c.id)).toEqual([conflict.id]);

		const dismissed = await api('POST', `/admin/review/${group_item}/dismiss`, { token: admin.access_token });
		expect(dismissed.status).toBe(200);
		expect((await query('select status from service_id_conflicts_table where id = $1', [conflict.id]))[0].status).toBe('dismissed');
	});
});
