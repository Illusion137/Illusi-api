import { describe, expect, it } from 'vitest';
import { MAX_RAW_BYTES, validate_items } from './normalize';

const track = (extra: Record<string, unknown> = {}) => ({ kind: 'track', service: 'deezer', id: 42, title: 'Song', ...extra });

describe('validate_items', () => {
	it('accepts each kind and stringifies numeric ids', () => {
		const { valid, rejected } = validate_items([
			track({ artist_names: ['A'], artist_ids: [7], duration_ms: 1000, raw: { a: 1 } }),
			{ kind: 'album', service: 'tidal', id: 'x', title: 'Album', release_date: '2020-01-02' },
			{ kind: 'artist', service: 'pandora', id: 'AR1', name: 'Artist', verified: true }
		]);
		expect(rejected).toEqual([]);
		expect(valid.map(v => [v.kind, v.id])).toEqual([['track', '42'], ['album', 'x'], ['artist', 'AR1']]);
		expect(valid[0]).toMatchObject({ artist_ids: ['7'], raw: { a: 1 } });
		expect((valid[1] as { release_date: Date }).release_date).toBeInstanceOf(Date);
	});

	it('rejects YouTube, unknown kinds and malformed items without dropping the rest', () => {
		const { valid, rejected } = validate_items([track({ service: 'youtube' }), { kind: 'playlist' }, track({ title: '' }), track({ id: 1 })]);
		expect(valid).toHaveLength(1);
		expect(rejected.map(r => r.index)).toEqual([0, 1, 2]);
	});

	it('keeps the last of repeated items and normalizes service ids before comparing them', () => {
		const spotify = (id: string, title: string) => track({ service: 'spotify', id, title });
		const id = '4uLU6hMCjMI75M1A2tKUQC';
		const { valid } = validate_items([spotify(id, 'First'), spotify(`spotify:track:${id}`, 'Second')]);
		expect(valid).toHaveLength(1);
		expect(valid[0]).toMatchObject({ id, title: 'Second' });
	});

	it('drops oversized raw payloads but keeps the item', () => {
		const { valid } = validate_items([track({ raw: { blob: 'x'.repeat(MAX_RAW_BYTES) } })]);
		expect(valid[0]).toMatchObject({ title: 'Song', raw: null });
	});
});
