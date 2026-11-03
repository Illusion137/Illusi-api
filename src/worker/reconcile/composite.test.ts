import { describe, expect, it } from 'vitest';
import { merge_entity_row, merge_membership, plan_ref_merge, REF_TABLES } from './composite';
import type { RefTableSpec } from './composite';

const spec = (kind: keyof typeof REF_TABLES, table: string, ref_col?: string): RefTableSpec =>
	REF_TABLES[kind].find(s => s.table === table && (!ref_col || s.ref_col === ref_col))!;
const d = (s: string) => new Date(s);

describe('plan_ref_merge', () => {
	it('repoints rows that do not collide and merges library rows of the same user (earliest created_at, union of flags)', () => {
		const rows = [
			{ user_id: 'u1', track_id: 'S', created_at: d('2024-05-01'), deleted: true, title: null, edited_at: d('2024-06-01'), downloaded_at: null },
			{ user_id: 'u1', track_id: 'L', created_at: d('2023-01-01'), deleted: false, title: 'My title', edited_at: d('2024-01-01'), downloaded_at: d('2023-02-01') },
			{ user_id: 'u2', track_id: 'L', created_at: d('2023-01-01'), deleted: false, title: null, edited_at: null, downloaded_at: null }
		];
		const plan = plan_ref_merge(spec('track', 'user_tracks_table'), 'S', 'L', rows);
		expect(plan.repoint.map(r => r.user_id)).toEqual(['u2']);
		expect(plan.delete.map(r => r.user_id)).toEqual(['u1']);
		expect(plan.update).toHaveLength(1);
		expect(plan.update[0].key).toEqual({ user_id: 'u1', track_id: 'S' });
		expect(plan.update[0].set).toEqual({ created_at: d('2023-01-01'), deleted: false, title: 'My title', downloaded_at: d('2023-02-01') });
	});

	it('playlist membership stays if either row was live', () => {
		expect(merge_membership({ deleted: true, created_at: d('2024-01-01') }, { deleted: true, created_at: d('2025-01-01') })).toMatchObject({ deleted: true, created_at: d('2024-01-01') });
		const rows = [
			{ playlist_id: 'p', track_id: 'S', deleted: false, created_at: d('2024-01-01'), edited_at: null },
			{ playlist_id: 'p', track_id: 'L', deleted: false, created_at: d('2025-01-01'), edited_at: null }
		];
		const plan = plan_ref_merge(spec('track', 'playlist_tracks_table'), 'S', 'L', rows);
		expect(plan.delete).toHaveLength(1);
		expect(plan.update).toEqual([]);
	});

	it('media collides on either unique key', () => {
		const rows = [
			{ id: 1, track_id: 'S', resource_id: 'r1', content_hash: 'h1', created_at: d('2024-01-01') },
			{ id: 2, track_id: 'L', resource_id: 'r2', content_hash: 'h1', created_at: d('2024-01-01') },
			{ id: 3, track_id: 'L', resource_id: 'r1', content_hash: 'h3', created_at: d('2024-01-01') },
			{ id: 4, track_id: 'L', resource_id: 'r4', content_hash: 'h4', created_at: d('2024-01-01') }
		];
		const plan = plan_ref_merge(spec('track', 'media_table'), 'S', 'L', rows);
		expect(plan.delete.map(r => r.id)).toEqual([2, 3]);
		expect(plan.repoint.map(r => r.id)).toEqual([4]);
	});

	it('one-row-per-entity tables keep the survivor\'s row, or take the loser\'s if the survivor has none', () => {
		const s = spec('track', 'track_vectors_table');
		expect(plan_ref_merge(s, 'S', 'L', [{ track_id: 'S' }, { track_id: 'L' }])).toEqual({ delete: [{ track_id: 'L' }], update: [], repoint: [] });
		expect(plan_ref_merge(s, 'S', 'L', [{ track_id: 'L' }])).toEqual({ delete: [], update: [], repoint: [{ track_id: 'L' }] });
	});

	it('lookup rows keep the better outcome', () => {
		const rows = [
			{ track_id: 'S', service: 'GENIUS', status: 'NOT_FOUND', attempts: 3, attempted_at: d('2024-01-01'), retry_after: null, source_user_id: null },
			{ track_id: 'L', service: 'GENIUS', status: 'FOUND', attempts: 1, attempted_at: d('2023-01-01'), retry_after: null, source_user_id: 'u' },
			{ track_id: 'L', service: 'LRCLIB', status: 'ERROR', attempts: 1, attempted_at: d('2023-01-01'), retry_after: null, source_user_id: null }
		];
		const plan = plan_ref_merge(spec('track', 'track_lyrics_lookups_table'), 'S', 'L', rows);
		expect(plan.update[0].set).toMatchObject({ status: 'FOUND', attempts: 1, source_user_id: 'u' });
		expect(plan.repoint.map(r => r.service)).toEqual(['LRCLIB']);
	});

	it('similar artists: drops pairs that would become self-references and merges duplicates', () => {
		const rows = [
			{ artist_id: 'L', similar_artist_id: 'S', created_at: d('2024-01-01') },
			{ artist_id: 'L', similar_artist_id: 'X', created_at: d('2023-01-01') },
			{ artist_id: 'S', similar_artist_id: 'X', created_at: d('2024-01-01') },
			{ artist_id: 'L', similar_artist_id: 'Y', created_at: d('2024-01-01') }
		];
		const plan = plan_ref_merge(spec('artist', 'similar_artists_table', 'artist_id'), 'S', 'L', rows);
		expect(plan.delete.map(r => r.similar_artist_id)).toEqual(['S', 'X']);
		expect(plan.update).toEqual([{ key: { artist_id: 'S', similar_artist_id: 'X' }, before: rows[2], set: { created_at: d('2023-01-01') } }]);
		expect(plan.repoint.map(r => r.similar_artist_id)).toEqual(['Y']);
	});

	it('plays and thumbnails never collide', () => {
		const plan = plan_ref_merge(spec('track', 'thumbnails_table'), 'S', 'L', [{ id: 'S', url: 'a' }, { id: 'L', url: 'b' }]);
		expect(plan.repoint).toEqual([{ id: 'L', url: 'b' }]);
		expect(plan_ref_merge(spec('track', 'track_plays_table'), 'S', 'L', [{ id: 1, track_id: 'L' }, { id: 2, track_id: 'S' }]).repoint).toHaveLength(1);
	});

	it('covers every referencing table from the spec', () => {
		const tables = new Set(Object.values(REF_TABLES).flat().map(s => s.table));
		for (const t of ['user_tracks_table', 'playlist_tracks_table', 'track_plays_table', 'track_lyrics_table', 'track_lyrics_lookups_table', 'track_sample_data_table',
			'track_sample_lookups_table', 'track_vectors_table', 'track_vocals_table', 'media_table', 'album_tracks_table', 'artist_albums_table', 'tracks_artists_table',
			'tracks_producers_table', 'similar_artists_table', 'itunes_lookups_table', 'thumbnails_table', 'tracks_table', 'albums_table']) {
			expect(tables.has(t), t).toBe(true);
		}
	});
});

describe('merge_entity_row', () => {
	it('fills survivor gaps from the loser and ORs flags, never overwriting', () => {
		const set = merge_entity_row(
			{ id: 'S', title: 'A', album_id: null, duration_ms: 1, explicit: null, imported: false, backpacked: false, created_at: d('2024-01-01') },
			{ id: 'L', title: 'B', album_id: 'alb', duration_ms: 2, explicit: true, imported: true, backpacked: true, created_at: d('2020-01-01') }
		);
		expect(set).toEqual({ album_id: 'alb', explicit: true, backpacked: true });
	});
});

describe('plan_ref_merge fills nulls', () => {
	it('keeps the survivor row and fills its missing track number from the loser', () => {
		const plan = plan_ref_merge(spec('track', 'album_tracks_table', 'track_id'), 'S', 'L', [
			{ album_id: 'al', track_id: 'S', track_number: null },
			{ album_id: 'al', track_id: 'L', track_number: 3 }
		]);
		expect(plan.update[0].set).toMatchObject({ track_number: 3 });
	});
});
