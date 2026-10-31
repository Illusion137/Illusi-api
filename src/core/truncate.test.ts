import { describe, expect, it, vi } from 'vitest';
import { soundcloud_users_table, thumbnails_table } from '../db/schema';

const warn = vi.hoisted(() => vi.fn());
vi.mock('./log', () => ({ logger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { truncate_to_columns } from './truncate';

describe('truncate_to_columns', () => {
	it('cuts strings over a varchar length and logs', () => {
		const out = truncate_to_columns(thumbnails_table, { url: 'x'.repeat(600) }, 'ctx');
		expect(out.url).toHaveLength(512);
		expect(warn).toHaveBeenCalledWith('truncated url from 600 to 512', 'ctx');
	});

	it('counts code points, not UTF-16 units', () => {
		const out = truncate_to_columns(thumbnails_table, { url: '😀'.repeat(513) });
		expect(Array.from(out.url)).toHaveLength(512);
	});

	it('leaves short strings, non-strings and unknown keys alone', () => {
		warn.mockClear();
		const values = { url: 'short', width: 5, unknown_key: 'y'.repeat(1000) };
		expect(truncate_to_columns(thumbnails_table, values)).toEqual(values);
		expect(warn).not.toHaveBeenCalled();
	});

	it('does not mutate its input', () => {
		const values = { url: 'x'.repeat(600) };
		truncate_to_columns(thumbnails_table, values);
		expect(values.url).toHaveLength(600);
	});

	it('ignores text columns without a length', () => {
		const values = { description: 'z'.repeat(5000) };
		expect(truncate_to_columns(soundcloud_users_table, values).description).toHaveLength(5000);
	});
});
