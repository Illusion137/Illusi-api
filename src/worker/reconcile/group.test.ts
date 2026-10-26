import { describe, expect, it } from 'vitest';
import { build_groups, claims_of, metadata_block_key, UnionFind } from './group';
import { conflict, node } from './test_fixtures';
import { DEFAULT_THRESHOLDS as T } from './thresholds';

const ids = (groups: ReturnType<typeof build_groups>) => groups.map(g => g.nodes.map(n => n.illusi_id));

describe('UnionFind', () => {
	it('merges sets transitively and keeps singletons', () => {
		const uf = new UnionFind();
		for (const x of ['a', 'b', 'c', 'd', 'e']) uf.add(x);
		uf.union('a', 'b');
		uf.union('c', 'b');
		uf.union('d', 'd');
		expect(uf.find('a')).toBe(uf.find('c'));
		expect(uf.find('d')).not.toBe(uf.find('a'));
		const sets = uf.sets().map(s => s.sort()).sort((x, y) => x[0].localeCompare(y[0]));
		expect(sets).toEqual([['a', 'b', 'c'], ['d'], ['e']]);
	});

	it('handles long chains', () => {
		const uf = new UnionFind();
		for (let i = 1; i < 1000; i++) uf.union(`n${i - 1}`, `n${i}`);
		expect(uf.sets()).toHaveLength(1);
		expect(uf.find('n0')).toBe(uf.find('n999'));
	});
});

describe('claims_of', () => {
	it('sources stored ids by the confirming service row and adds reported ids and conflict values', () => {
		const n = node('a', {
			ids: { applemusic_id: '1', spotify_id: 'S'.repeat(22) },
			facets: [
				{ source: 'itunes', columns: ['applemusic_id'] },
				{ source: 'genius', columns: ['genius_id'], reported: { youtube_id: 'abcdefghijk' } },
				{ source: 'soundcloud', columns: ['soundcloud_id'], isrc: 'USABC1234567' }
			]
		});
		const claims = claims_of(n, [conflict('a', 'deezer_id', 'D1', { source: 'contribute' }), conflict('b', 'deezer_id', 'D2')]);
		expect(claims).toEqual(expect.arrayContaining([
			{ column: 'applemusic_id', value: '1', source: 'itunes' },
			{ column: 'spotify_id', value: 'S'.repeat(22), source: 'stored' },
			{ column: 'youtube_id', value: 'abcdefghijk', source: 'genius' },
			{ column: 'isrc', value: 'USABC1234567', source: 'soundcloud' },
			{ column: 'deezer_id', value: 'D1', source: 'contribute' }
		]));
		expect(claims.some(c => c.value === 'D2')).toBe(false);
	});
});

describe('build_groups', () => {
	it('chains A–B (Apple Music conflict) and B–C (SoundCloud conflict) into one group', () => {
		const nodes = [
			node('A', { ids: { applemusic_id: '10' }, meta: { title: 'One' } }),
			node('B', { ids: { applemusic_id: '11', soundcloud_id: '20' }, meta: { title: 'Two' } }),
			node('C', { meta: { title: 'Three' } }),
			node('D', { meta: { title: 'Four' } })
		];
		const conflicts = [
			conflict('A', 'applemusic_id', '11', { other_illusi_id: 'B', source: 'itunes' }),
			conflict('C', 'soundcloud_id', '20', { other_illusi_id: 'B', source: 'soundcloud' })
		];
		const groups = build_groups(nodes, conflicts, T);
		expect(ids(groups)).toEqual([['A', 'B', 'C'], ['D']]);
		expect(groups[0].conflicts).toHaveLength(2);
	});

	it('connects by a shared reported id even without a conflict record', () => {
		const nodes = [
			node('A', { ids: { applemusic_id: '10' }, meta: { title: 'X' } }),
			node('B', { meta: { title: 'Y' }, facets: [{ source: 'genius', columns: ['genius_id'], reported: { applemusic_id: '10' } }] })
		];
		expect(ids(build_groups(nodes, [], T))).toEqual([['A', 'B']]);
	});

	it('connects by shared ISRC', () => {
		const nodes = [
			node('A', { ids: { isrc: 'USABC1234567' }, meta: { title: 'X' } }),
			node('B', { ids: { isrc: 'USABC1234567' }, meta: { title: 'Y' } }),
			node('C', { ids: { isrc: 'USABC7654321' }, meta: { title: 'Z' } })
		];
		expect(ids(build_groups(nodes, [], T))).toEqual([['A', 'B'], ['C']]);
	});

	it('connects strong metadata matches only within the duration tolerance', () => {
		const nodes = [
			node('A', { meta: { title: 'Hello (Remastered)', artist: 'Adele', duration_ms: 295_000 } }),
			node('B', { meta: { title: 'hello', artist: 'Adele feat. X', duration_ms: 296_500 } }),
			node('C', { meta: { title: 'Hello', artist: 'Adele', duration_ms: 400_000 } }),
			node('D', { meta: { title: 'Hello', artist: 'Lionel Richie', duration_ms: 295_000 } })
		];
		expect(ids(build_groups(nodes, [], T))).toEqual([['A', 'B'], ['C'], ['D']]);
	});

	it('does not link different kinds through the same id value', () => {
		const nodes = [
			node('A', { kind: 'track', ids: { genius_id: '5' }, meta: { title: 'X' } }),
			node('B', { kind: 'artist', meta: { title: 'Y' }, facets: [{ source: 'genius', columns: [], reported: { genius_id: '5' } }] })
		];
		expect(ids(build_groups(nodes, [], T))).toEqual([['A'], ['B']]);
	});

	it('skips oversized metadata blocks', () => {
		const nodes = Array.from({ length: T.max_metadata_block + 1 }, (_, i) => node(`n${String(i).padStart(2, '0')}`, { meta: { title: 'Intro', artist: 'Various', duration_ms: 60_000 } }));
		expect(build_groups(nodes, [], T)).toHaveLength(nodes.length);
	});

	it('has no block key without title and artist', () => {
		expect(metadata_block_key(node('a', { meta: { artist: null } }))).toBeNull();
		expect(metadata_block_key(node('a', { kind: 'artist' }))).toBeNull();
	});
});
