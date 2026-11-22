import { describe, expect, it } from 'vitest';
import { explicit_rule, resolve_shared_fields, strip_artist_prefix } from './fields';
import { other_artists, prepare_similar_pairs } from './similar';

const spec = { title: 'name', duration_ms: 'duration', explicit: 'bool', release_date: 'date', album_id: 'id' } as const;

describe('resolve_shared_fields (first write wins)', () => {
	it('fills empty fields and never nulls out', () => {
		const r = resolve_shared_fields(spec, { title: 'Song', duration_ms: null, explicit: null }, { title: 'Song', duration_ms: 1000, explicit: undefined });
		expect(r).toEqual({ fill: { duration_ms: 1000 }, conflicts: [] });
	});
	it('flags differing values without applying them', () => {
		const r = resolve_shared_fields(spec, { title: 'Song', explicit: false, album_id: 'a' }, { title: 'Other', explicit: true, album_id: 'b' });
		expect(r.fill).toEqual({});
		expect(r.conflicts.map(c => c.field)).toEqual(['title', 'explicit', 'album_id']);
	});
	it('treats equivalent values as equal', () => {
		const r = resolve_shared_fields(spec, { title: 'Song (Remastered)', duration_ms: 200_000, release_date: new Date('2020-01-01') }, { title: 'song', duration_ms: 201_500, release_date: new Date('2020-01-01T00:00:00Z') });
		expect(r).toEqual({ fill: {}, conflicts: [] });
	});
	it('fills everything on a new row', () => {
		expect(resolve_shared_fields(spec, null, { title: 'T', explicit: false }).fill).toEqual({ title: 'T', explicit: false });
	});
});

describe('similar artists', () => {
	it('keeps pairs as submitted, drops self pairs and duplicates', () => {
		expect(prepare_similar_pairs([
			{ artist_id: 'a', similar_artist_id: 'b' },
			{ artist_id: 'b', similar_artist_id: 'a' },
			{ artist_id: 'a', similar_artist_id: 'b' },
			{ artist_id: 'c', similar_artist_id: 'c' }
		])).toEqual([{ artist_id: 'a', similar_artist_id: 'b' }, { artist_id: 'b', similar_artist_id: 'a' }]);
	});
	it('one row and two rows read the same in both directions', () => {
		const one = [{ artist_id: 'a', similar_artist_id: 'b' }];
		const two = [...one, { artist_id: 'b', similar_artist_id: 'a' }];
		expect(other_artists(one, 'a')).toEqual(['b']);
		expect(other_artists(one, 'b')).toEqual(['a']);
		expect(other_artists(two, 'a')).toEqual(['b']);
		expect(other_artists(two, 'b')).toEqual(['a']);
	});
});

describe('strip_artist_prefix', () => {
	it('drops a leading "Artist - " made of the track\'s artists', () => {
		expect(strip_artist_prefix('Lil Poppa - Russian Roulette', ['Lil Poppa'])).toBe('Russian Roulette');
		expect(strip_artist_prefix('lil poppa – Russian Roulette', ['Lil Poppa'])).toBe('Russian Roulette');
		expect(strip_artist_prefix('A & B - Song', ['A', 'B'])).toBe('Song');
		expect(strip_artist_prefix('Simon & Garfunkel - The Boxer', ['Simon & Garfunkel'])).toBe('The Boxer');
		expect(strip_artist_prefix('playboi carti - molly (not real) (og version)', ['Playboi Carti'])).toBe('molly (not real) (og version)');
	});

	it('leaves other dashes and unknown prefixes alone', () => {
		expect(strip_artist_prefix('Song - Live', ['Artist'])).toBe('Song - Live');
		expect(strip_artist_prefix('Someone Else - Song', ['Artist'])).toBe('Someone Else - Song');
		expect(strip_artist_prefix('A & Stranger - Song', ['A'])).toBe('A & Stranger - Song');
		expect(strip_artist_prefix('Artist - Song', [])).toBe('Artist - Song');
		expect(strip_artist_prefix('Artist-Song', ['Artist'])).toBe('Artist-Song');
	});
});

describe('explicit_rule', () => {
	it('weighs explicit by source', () => {
		expect(explicit_rule('YouTube', true)).toBe('ignore');
		expect(explicit_rule('YouTube Music', false)).toBe('apply');
		expect(explicit_rule('SoundCloud', true)).toBe('apply');
		expect(explicit_rule('SoundCloud', false)).toBe('ignore');
		expect(explicit_rule(null, false)).toBe('ignore');
		expect(explicit_rule('Spotify', false)).toBe('ignore');
		expect(explicit_rule('Apple Music', false)).toBe('review');
	});
});
