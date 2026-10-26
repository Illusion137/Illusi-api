import { describe, expect, it } from 'vitest';
import { HttpError } from '../../core/http';
import { parse_entity_patch, resolve_table } from './entities';
import { apply_body_schema, default_proposal_index, list_query_schema } from './review';

describe('resolve_table', () => {
	it('accepts shared tables and aliases only', () => {
		expect(resolve_table('tracks')).toBe('tracks_table');
		expect(resolve_table('service_ids')).toBe('service_ids_table');
		expect(resolve_table('users_table')).toBeNull();
		expect(resolve_table('user_tracks_table')).toBeNull();
	});
});

describe('parse_entity_patch', () => {
	it('validates whitelisted columns, including overwriting with null', () => {
		expect(parse_entity_patch('tracks_table', { title: '  New  ', explicit: null, duration_ms: 1000 })).toEqual({ title: 'New', explicit: null, duration_ms: 1000 });
		expect(parse_entity_patch('albums_table', { release_date: '2020-05-01', album_type: 'EP' })).toEqual({ release_date: new Date('2020-05-01'), album_type: 'EP' });
	});

	it('normalizes service ids', () => {
		expect(parse_entity_patch('service_ids_table', {
			youtube_id: 'https://youtu.be/dQw4w9WgXcQ', isrc: 'us-abc-12-34567', genius_id: '42', spotify_id: ''
		})).toEqual({ youtube_id: 'dQw4w9WgXcQ', isrc: 'USABC1234567', genius_id: 42, spotify_id: null });
	});

	it('rejects non-editable columns, bad values and empty patches', () => {
		const status = (fn: () => unknown) => {
			try {
				fn();
			} catch (err) {
				return (err as HttpError).status;
			}
			return null;
		};
		expect(status(() => parse_entity_patch('tracks_table', { id: 'x' }))).toBe(400);
		expect(status(() => parse_entity_patch('tracks_table', { created_at: 'x' }))).toBe(400);
		expect(status(() => parse_entity_patch('tracks_table', { title: '' }))).toBe(400);
		expect(status(() => parse_entity_patch('service_ids_table', { isrc: 'nope' }))).toBe(400);
		expect(status(() => parse_entity_patch('tracks_table', {}))).toBe(400);
		expect(status(() => parse_entity_patch('tracks_table', [1]))).toBe(400);
		expect(() => parse_entity_patch('tracks_table', { foo: 1 })).toThrow(HttpError);
	});
});

describe('review helpers', () => {
	it('picks the most reported value, or the latest plan for service id conflicts', () => {
		const p = (occurrences: number) => ({ value: occurrences, source_user_ids: [], occurrences });
		expect(default_proposal_index('FIELD_CONFLICT', [p(1), p(3), p(2)])).toBe(1);
		expect(default_proposal_index('SERVICE_ID_CONFLICT', [p(5), p(1)])).toBe(1);
		expect(default_proposal_index('FIELD_CONFLICT', [])).toBe(-1);
	});

	it('parses list queries with defaults and bounds', () => {
		expect(list_query_schema.parse({})).toMatchObject({ status: 'OPEN', sort: 'occurrences', page: 1, limit: 25 });
		expect(list_query_schema.parse({ kind: 'AUTO_MERGE', page: '2', limit: '100', sort: 'age' })).toMatchObject({ kind: 'AUTO_MERGE', page: 2, limit: 100, sort: 'age' });
		expect(list_query_schema.safeParse({ limit: '500' }).success).toBe(false);
		expect(list_query_schema.safeParse({ kind: 'NOPE' }).success).toBe(false);
	});

	it('apply body accepts nothing, a proposal index or a typed value', () => {
		expect(apply_body_schema.parse(undefined)).toEqual({});
		expect(apply_body_schema.parse({ proposal_index: 0 })).toEqual({ proposal_index: 0 });
		expect(apply_body_schema.parse({ value: 'Typed' })).toEqual({ value: 'Typed' });
	});
});
