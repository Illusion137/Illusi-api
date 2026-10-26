import { describe, expect, it } from 'vitest';
import { decide_metadata, decide_service_id_match, evaluate_album, evaluate_artist, evaluate_track } from './matching';
import type { TrackCandidate } from './matching';

describe('decide_service_id_match', () => {
	it('returns none without hits', () => {
		expect(decide_service_id_match([])).toEqual({ kind: 'none' });
	});
	it('takes the entity with the most unique ids and records the others', () => {
		const d = decide_service_id_match([
			{ illusi_id: 'a', columns: ['spotify_id'] },
			{ illusi_id: 'b', columns: ['applemusic_id', 'youtube_id'] },
			{ illusi_id: 'c', columns: ['isrc'] }
		]);
		expect(d).toEqual({ kind: 'match', illusi_id: 'b', others: [{ illusi_id: 'a', columns: ['spotify_id'] }] });
	});
	it('several ISRC-only hits are not conflicts; the tiebreak picks one', () => {
		const d = decide_service_id_match([{ illusi_id: 'a', columns: ['isrc'] }, { illusi_id: 'b', columns: ['isrc'] }], id => (id === 'b' ? 1 : 0));
		expect(d).toEqual({ kind: 'match', illusi_id: 'b', others: [] });
	});
});

const candidate = (over: Partial<TrackCandidate> = {}): TrackCandidate => ({
	id: 't1', title: 'Song Name', duration_ms: 200_000, artist_ids: ['ar1'], artist_names: ['Artist'], album_ids: ['al1'], album_names: ['Album'], ...over
});

describe('evaluate_track', () => {
	it('strong on title, primary artist, duration within tolerance and matching album', () => {
		expect(evaluate_track({ title: 'Song Name (feat. X)', duration_ms: 202_000, artist_ids: ['ar1', 'ar9'], album_id: 'al1' }, candidate()).strength).toBe('strong');
		expect(evaluate_track({ title: 'song name', duration_ms: 199_000, artist_name: 'Artist & Other' }, candidate()).strength).toBe('strong');
	});
	it('unclear when the duration is missing or the album differs', () => {
		expect(evaluate_track({ title: 'Song Name', artist_ids: ['ar1'] }, candidate()).strength).toBe('unclear');
		expect(evaluate_track({ title: 'Song Name', duration_ms: 200_000, artist_ids: ['ar1'], album_id: 'al2', album_name: 'Other' }, candidate()).strength).toBe('unclear');
	});
	it('no match on another artist, title or a clearly different duration', () => {
		expect(evaluate_track({ title: 'Song Name', duration_ms: 200_000, artist_ids: ['zz'] }, candidate()).strength).toBe('none');
		expect(evaluate_track({ title: 'Different', duration_ms: 200_000, artist_ids: ['ar1'] }, candidate()).strength).toBe('none');
		expect(evaluate_track({ title: 'Song Name', duration_ms: 260_000, artist_ids: ['ar1'] }, candidate()).strength).toBe('none');
	});
});

describe('evaluate_album / evaluate_artist', () => {
	it('albums need name and artist', () => {
		const c = { id: 'al', name: 'Album (Deluxe Edition)', artist_ids: ['ar1'], artist_names: ['Artist'] };
		expect(evaluate_album({ name: 'Album', artist_id: 'ar1' }, c).strength).toBe('strong');
		expect(evaluate_album({ name: 'Album' }, c).strength).toBe('unclear');
		expect(evaluate_album({ name: 'Album', artist_id: 'other' }, c).strength).toBe('none');
	});
	it('artists need name plus a shared work', () => {
		const c = { id: 'ar', name: 'The Band', work_ids: ['t1'], album_names: ['First LP'], track_titles: ['Hit'] };
		expect(evaluate_artist({ name: 'the band', work_ids: ['t1'] }, c).strength).toBe('strong');
		expect(evaluate_artist({ name: 'The Band', track_titles: ['Hit (Remastered)'] }, c).strength).toBe('strong');
		expect(evaluate_artist({ name: 'The Band' }, c).strength).toBe('unclear');
		expect(evaluate_artist({ name: 'Someone Else', work_ids: ['t1'] }, c).strength).toBe('none');
	});
});

describe('decide_metadata', () => {
	it('prefers the best strong match and lists other strong ones', () => {
		expect(decide_metadata([
			{ id: 'a', strength: 'strong', score: 1 },
			{ id: 'b', strength: 'strong', score: 2 },
			{ id: 'c', strength: 'unclear', score: 3 }
		])).toEqual({ kind: 'match', illusi_id: 'b', others: ['a'] });
	});
	it('reports unclear candidates or none', () => {
		expect(decide_metadata([{ id: 'c', strength: 'unclear', score: 1 }, { id: 'd', strength: 'none', score: 0 }])).toEqual({ kind: 'unclear', candidates: ['c'] });
		expect(decide_metadata([{ id: 'd', strength: 'none', score: 0 }])).toEqual({ kind: 'none' });
	});
});
