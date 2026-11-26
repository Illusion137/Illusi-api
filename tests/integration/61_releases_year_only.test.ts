import { afterAll, describe, expect, it } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
const { create_user, days_ago, query, unique, uuid } = await import('./helpers');
const { prune_feed, released_albums } = await import('../../src/services/releases/query');
const { release_window } = await import('../../src/services/releases/logic');
const { db } = await import('../../src/db');

afterAll(async () => { await app.stop(); });

async function artist() {
	const id = uuid();
	await query(`insert into service_ids_table (illusi_id) values ($1)`, [id]);
	await query(`insert into artists_table (id, name) values ($1, $2)`, [id, unique('Year Artist')]);
	return id;
}

async function album(artist_id: string, release_date: Date, created_at: Date) {
	const id = uuid();
	await query(`insert into service_ids_table (illusi_id) values ($1)`, [id]);
	await query(`insert into albums_table (id, artist_id, name, release_date, created_at) values ($1, $2, $3, $4, $5)`, [id, artist_id, unique('Year Album'), release_date, created_at]);
	return id;
}

describe('year-only releases', () => {
	it('count from when the catalog first stored them, once the artist\'s other albums were stored before', async () => {
		const now = new Date();
		const window = release_window(now, 7);
		const this_year = new Date(Date.UTC(window.since.getUTCFullYear(), 0, 1));
		const last_year = new Date(Date.UTC(window.since.getUTCFullYear() - 1, 0, 1));

		const known = await artist();
		await album(known, last_year, days_ago(30));
		const fresh = await album(known, this_year, days_ago(1));
		const stored_long_ago = await album(known, this_year, days_ago(30));

		// The first time anyone views an artist, its whole discography arrives at once
		const discovered = await artist();
		const first = await album(discovered, this_year, now);
		const second = await album(discovered, this_year, now);

		const ids = new Set([fresh, stored_long_ago, first, second]);
		const rows = (await released_albums(db, window, 500)).filter(row => ids.has(row.id));
		expect(rows.map(row => row.id)).toEqual([fresh]);
		expect(new Date(rows[0].release_date).getTime()).toBeCloseTo(days_ago(1).getTime(), -5);
	});
});

describe('feed pruning', () => {
	it('keeps an aged-out row the client still hands over, so it keeps the time it was first seen', async () => {
		const user = await create_user('feed-prune');
		const window = release_window(new Date(), 7);
		const insert = (external_id: string, modified_at: Date) => query(
			`insert into user_release_feed_table (user_id, service, external_id, kind, name, first_seen_at, modified_at) values ($1, 'youtube_music', $2, 'album', $2, $3, $4)`,
			[user.id, external_id, days_ago(10), modified_at]
		);
		await insert('still-listed', days_ago(1));
		await insert('gone', days_ago(8));
		await prune_feed(db, user.id, window);
		const rows = await query(`select external_id from user_release_feed_table where user_id = $1`, [user.id]);
		expect(rows.map(row => row.external_id)).toEqual(['still-listed']);
	});
});
