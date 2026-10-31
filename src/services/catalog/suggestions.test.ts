import { describe, expect, it } from 'vitest';
import { fold, match_tier, pick_thumbnail, rank_suggestions, text_completions } from './suggestions';

const candidate = (id: string, texts: string[], plays = 0, in_library = false) => ({ id, texts, plays, in_library });

describe('match_tier', () => {
	it('orders exact > prefix > contains > trigram, ignoring case and accents', () => {
		expect(match_tier(fold('Beyonce'), fold('Beyoncé'))).toBe(3);
		expect(match_tier('hotl', 'hotline bling')).toBe(2);
		expect(match_tier('bling', 'hotline bling')).toBe(1);
		expect(match_tier('hotlin blig', 'hotline bling')).toBe(0);
		expect(match_tier('zzz', 'hotline bling')).toBe(-1);
	});
});

describe('rank_suggestions', () => {
	it('ranks by tier first, then library, then plays', () => {
		const ranked = rank_suggestions('dra', [
			candidate('contains', ['Hydrate'], 1_000_000, true),
			candidate('prefix-popular', ['Dragon'], 500),
			candidate('prefix-library', ['Drama'], 1, true),
			candidate('exact', ['DRA'])
		]);
		expect(ranked.map(c => c.id)).toEqual(['exact', 'prefix-library', 'prefix-popular', 'contains']);
	});

	it('scores a candidate by its best text and drops non-matches', () => {
		const ranked = rank_suggestions('drake hot', [
			candidate('combo', ['Hotline Bling', 'Drake Hotline Bling']),
			candidate('none', ['Something Else'])
		]);
		expect(ranked.map(c => c.id)).toEqual(['combo']);
	});

	it('prefers the closer text within a tier', () => {
		const ranked = rank_suggestions('hotline bl', [
			candidate('longer', ['Hotline Bling Boy Cold'], 1000),
			candidate('closer', ['Hotline Bling'])
		]);
		expect(ranked.map(c => c.id)).toEqual(['closer', 'longer']);
	});

	it('breaks trigram-only ties by similarity before plays', () => {
		const ranked = rank_suggestions('hotlin blig', [
			candidate('far', ['hot bling machine'], 1000),
			candidate('near', ['hotline bling'], 0)
		]);
		expect(ranked[0].id).toBe('near');
	});
});

describe('text_completions', () => {
	it('puts matching recent searches first, de-duplicates by folded text, and skips the query itself', () => {
		const out = text_completions('dra', ['Drake', 'dra', 'unrelated', 'hydra'], [
			{ text: 'drake', kind: 'artist' },
			{ text: 'Dragon', kind: 'track' },
			{ text: 'Hydrate', kind: 'track' }
		], 10);
		expect(out).toEqual([
			{ text: 'Drake', kind: 'recent' },
			{ text: 'hydra', kind: 'recent' },
			{ text: 'Dragon', kind: 'track' },
			{ text: 'Hydrate', kind: 'track' }
		]);
	});

	it('orders entity completions by tier, keeping the given order within a tier, and honours the limit', () => {
		const out = text_completions('love', [], [
			{ text: 'Crazy in Love', kind: 'track' },
			{ text: 'Love Story', kind: 'track' },
			{ text: 'Lovely', kind: 'artist' }
		], 2);
		expect(out.map(s => s.text)).toEqual(['Love Story', 'Lovely']);
	});
});

describe('pick_thumbnail', () => {
	it('prefers the smallest one wide enough, else the largest known', () => {
		expect(pick_thumbnail([
			{ url: 'a', width: 600, height: 600 },
			{ url: 'b', width: 160, height: 160 },
			{ url: 'c', width: 60, height: 60 }
		])?.url).toBe('b');
		expect(pick_thumbnail([{ url: 'c', width: 60, height: 60 }, { url: 'd', width: null, height: null }])?.url).toBe('c');
		expect(pick_thumbnail([])).toBeNull();
	});
});
