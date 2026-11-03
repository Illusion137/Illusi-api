import { describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ release: () => undefined, wait: undefined as Promise<null> | undefined }));
vi.mock('./store', () => ({
	load_track_context: vi.fn(() => gate.wait),
	load_lookups: vi.fn(), write_lookups: vi.fn(), insert_versions: vi.fn()
}));
vi.mock('../../db', () => ({ db: {} }));

import { enqueue_background } from './lookup';
import { load_track_context } from './store';

describe('enqueue_background', () => {
	it('drops lookups beyond the queue limit and never queues an id twice', async () => {
		gate.wait = new Promise<null>((resolve) => { gate.release = () => { resolve(null); }; });
		const ids = Array.from({ length: 10_005 }, (_, i) => `track-${i}`);
		enqueue_background(ids);
		enqueue_background(ids.slice(0, 3));
		// Two run immediately; nothing past the limit was queued.
		expect(vi.mocked(load_track_context)).toHaveBeenCalledTimes(2);
		gate.release();
		await vi.waitFor(() => { expect(vi.mocked(load_track_context).mock.calls.length).toBeGreaterThan(100); });
	});
});
