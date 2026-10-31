import { describe, expect, it, vi } from 'vitest';
import { best_thumbnail, itunes_thumbnails, parse_thumbnail_size, soundcloud_thumbnails, upsert_thumbnails, youtube_thumbnails } from './thumbnails';

describe('parse_thumbnail_size', () => {
	it.each([
		['https://is1.mzstatic.com/x/100x100bb.jpg', { width: 100, height: 100 }],
		['https://lh3.googleusercontent.com/abc=w544-h544-l90', { width: 544, height: 544 }],
		['https://x.com/a-w120-h90.jpg', { width: 120, height: 90 }],
		['https://i1.sndcdn.com/artworks-abc-t500x500.jpg', { width: 500, height: 500 }],
		['https://i1.sndcdn.com/artworks-abc-large.jpg', { width: 100, height: 100 }],
		['https://i.ytimg.com/vi/abc/hqdefault.jpg', { width: 480, height: 360 }],
		['https://i.ytimg.com/vi/abc/unknown.jpg', null],
		['https://example.com/large.jpg', null],
		['https://example.com/-large.jpg', null]
	])('%s', (url, expected) => {
		expect(parse_thumbnail_size(url)).toEqual(expected);
	});
});

describe('builders', () => {
	it('youtube_thumbnails lists all five sizes', () => {
		const list = youtube_thumbnails('vid');
		expect(list).toHaveLength(5);
		expect(list[0]).toEqual({ url: 'https://i.ytimg.com/vi/vid/default.jpg', width: 120, height: 90 });
	});

	it('itunes_thumbnails skips empty urls and parses sizes', () => {
		expect(itunes_thumbnails({ artwork_url_60: 'https://x/60x60bb.jpg', artwork_url_100: null, artwork_url_600: 'https://x/plain.jpg' })).toEqual([
			{ url: 'https://x/60x60bb.jpg', width: 60, height: 60 },
			{ url: 'https://x/plain.jpg' }
		]);
	});

	it('soundcloud_thumbnails adds the 500px variant for -large', () => {
		expect(soundcloud_thumbnails(null)).toEqual([]);
		expect(soundcloud_thumbnails('https://i1.sndcdn.com/a-large.jpg')).toEqual([
			{ url: 'https://i1.sndcdn.com/a-large.jpg', width: 100, height: 100 },
			{ url: 'https://i1.sndcdn.com/a-t500x500.jpg', width: 500, height: 500 }
		]);
		expect(soundcloud_thumbnails('https://x/other.jpg')).toEqual([{ url: 'https://x/other.jpg' }]);
	});
});

describe('best_thumbnail', () => {
	it('picks the largest area, ranks unknown sizes last and handles empty', () => {
		expect(best_thumbnail([])).toBeNull();
		expect(best_thumbnail([{ url: 'a' }, { url: 'b', width: 10, height: 10 }, { url: 'c', width: 5, height: 100 }])?.url).toBe('c');
		expect(best_thumbnail([{ url: 'a' }, { url: 'b' }])?.url).toBe('a');
	});
});

describe('upsert_thumbnails', () => {
	const tx = () => {
		const on_conflict = vi.fn().mockResolvedValue(undefined);
		const values = vi.fn(() => ({ onConflictDoUpdate: on_conflict }));
		return { tx: { insert: vi.fn(() => ({ values })) }, values, on_conflict };
	};

	it('does nothing for no usable thumbnails', async () => {
		const { tx: t } = tx();
		await upsert_thumbnails(t as never, 'id', [{ url: '' }, { url: 'x'.repeat(513) }]);
		expect(t.insert).not.toHaveBeenCalled();
	});

	it('dedupes by url, cleans sizes and falls back to parsed ones', async () => {
		const { tx: t, values, on_conflict } = tx();
		await upsert_thumbnails(t as never, 'owner', [
			{ url: 'https://x/100x100bb.jpg' },
			{ url: 'https://x/a.jpg', width: 10.6, height: -1 },
			{ url: 'https://x/a.jpg', width: NaN, height: 0 },
			{ url: 'https://x/b.jpg', width: 20.4, height: 30 }
		]);
		expect(values).toHaveBeenCalledWith([
			{ id: 'owner', url: 'https://x/100x100bb.jpg', width: 100, height: 100 },
			{ id: 'owner', url: 'https://x/a.jpg', width: null, height: null },
			{ id: 'owner', url: 'https://x/b.jpg', width: 20, height: 30 }
		]);
		expect(on_conflict).toHaveBeenCalledOnce();
	});
});
