import { describe, expect, it } from 'vitest';
import { TRACK_VECTOR_DIMENSIONS } from '../../db/schema';
import { circle_of_fifths_position, encode_key, encode_mood, encode_sample, fold_tempo, GROUP_WEIGHTS, MOOD_LABELS, parse_key, scale_brightness, VECTOR_DIMENSIONS } from './encoding';
import type { SampleFeatures } from './encoding';

const sample: SampleFeatures = {
	mood: 'House/Dance', tempo: 124, brightness: 2750, key: 'Am',
	acousticness: 0.1, instrumentalness: 0.2, liveness: 0.3, danceability: 0.4, speechiness: 0.5, valence: 0.6, arousal: 0.7
};

const dist = (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - b[i]));

describe('vector layout', () => {
	it('matches the column dimensions', () => {
		expect(VECTOR_DIMENSIONS).toBe(TRACK_VECTOR_DIMENSIONS);
		expect(encode_sample(sample)).toHaveLength(TRACK_VECTOR_DIMENSIONS);
	});

	it('keeps every dimension in [0, 1] with default weights', () => {
		for (const x of encode_sample(sample)) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(1);
		}
		expect(Object.values(GROUP_WEIGHTS).every(w => w === 1)).toBe(true);
	});

	it('places groups in order', () => {
		const v = encode_sample(sample);
		expect(v.slice(0, 7)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
		expect(v[7]).toBeCloseTo(fold_tempo(124));
		expect(v[8]).toBeCloseTo(0.5);
		expect(v.slice(9, 12)).toEqual(encode_key('Am'));
		expect(v.slice(12)).toEqual(encode_mood('House/Dance'));
	});

	it('applies group weights', () => {
		const v = encode_sample(sample, { ...GROUP_WEIGHTS, features: 2, mood: 0 });
		expect(v[0]).toBeCloseTo(0.2);
		expect(v.slice(12).every(x => x === 0)).toBe(true);
	});
});

describe('tempo folding', () => {
	it('maps half and double tempo to the same value', () => {
		expect(fold_tempo(90)).toBeCloseTo(fold_tempo(180));
		expect(fold_tempo(100)).toBeCloseTo(fold_tempo(200));
		expect(fold_tempo(75)).toBeCloseTo(fold_tempo(150));
	});

	it('clamps to 60-200 BPM and scales into [0, 1)', () => {
		expect(fold_tempo(30)).toBeCloseTo(fold_tempo(60));
		expect(fold_tempo(400)).toBeCloseTo(fold_tempo(200));
		expect(fold_tempo(70)).toBe(0);
		for (const bpm of [60, 70, 99, 139.9, 140, 200]) {
			expect(fold_tempo(bpm)).toBeGreaterThanOrEqual(0);
			expect(fold_tempo(bpm)).toBeLessThan(1);
		}
		expect(fold_tempo(0)).toBe(0);
		expect(fold_tempo(Number.NaN)).toBe(0);
	});
});

describe('brightness', () => {
	it('min-max scales Hz', () => {
		expect(scale_brightness(500)).toBe(0);
		expect(scale_brightness(5000)).toBe(1);
		expect(scale_brightness(9000)).toBe(1);
		expect(scale_brightness(100)).toBe(0);
	});
});

describe('key encoding', () => {
	it('parses stored and Mood-Detector spellings', () => {
		expect(parse_key('C#m')).toEqual({ pitch_class: 1, major: false });
		expect(parse_key('C# minor')).toEqual({ pitch_class: 1, major: false });
		expect(parse_key('F major')).toEqual({ pitch_class: 5, major: true });
		expect(parse_key('Bb')).toEqual({ pitch_class: 10, major: true });
		expect(parse_key('Ebm')).toEqual({ pitch_class: 3, major: false });
		expect(parse_key('B')).toEqual({ pitch_class: 11, major: true });
		expect(parse_key('Bm')).toEqual({ pitch_class: 11, major: false });
		expect(parse_key('nope')).toBeNull();
	});

	it('places keys on the circle of fifths', () => {
		expect(circle_of_fifths_position(0, true)).toBe(0); // C
		expect(circle_of_fifths_position(7, true)).toBe(1); // G
		expect(circle_of_fifths_position(2, true)).toBe(2); // D
		expect(circle_of_fifths_position(5, true)).toBe(11); // F
		expect(circle_of_fifths_position(9, false)).toBe(0); // Am shares C
		expect(circle_of_fifths_position(4, false)).toBe(1); // Em shares G
	});

	it('keeps neighbouring keys closer than distant ones', () => {
		const c = encode_key('C');
		expect(dist(c, encode_key('G'))).toBeLessThan(dist(c, encode_key('F#')));
		expect(dist(c, encode_key('F'))).toBeCloseTo(dist(c, encode_key('G')));
		// relative minor differs only by the mode flag
		expect(encode_key('Am').slice(0, 2)).toEqual(c.slice(0, 2));
		expect(c[2]).toBe(1);
		expect(encode_key('Am')[2]).toBe(0);
		expect(encode_key('C')[0]).toBeCloseTo(0.5);
		expect(encode_key('C')[1]).toBeCloseTo(1);
	});

	it('encodes unknown keys as neutral', () => {
		expect(encode_key('')).toEqual([0.5, 0.5, 0.5]);
	});
});

describe('mood encoding', () => {
	it('one-hots known labels and zeros unknown ones', () => {
		const v = encode_mood('Drum & Bass');
		expect(v).toHaveLength(MOOD_LABELS.length);
		expect(v.reduce((a, b) => a + b, 0)).toBe(1);
		expect(v[MOOD_LABELS.indexOf('Drum & Bass')]).toBe(1);
		expect(encode_mood('Polka').every(x => x === 0)).toBe(true);
	});

	it('has unique labels that fit varchar(50)', () => {
		expect(new Set(MOOD_LABELS).size).toBe(MOOD_LABELS.length);
		expect(MOOD_LABELS.every(l => l.length <= 50)).toBe(true);
	});
});
