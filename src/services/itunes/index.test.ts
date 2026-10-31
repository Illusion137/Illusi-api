import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), enqueue_if_needed: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./service', () => ({ ITunesService: vi.fn(function () { return service; }) }));

import { enqueue_if_needed, start, stop } from './index';

describe('iTunes service facade', () => {
	beforeEach(() => vi.clearAllMocks());

	it('starts the shared service', async () => {
		await start();
		expect(service.start).toHaveBeenCalledTimes(1);
	});
	it('stops it and waits for the drain', async () => {
		await stop();
		expect(service.stop).toHaveBeenCalledTimes(1);
	});
	it('forwards ids to enqueue_if_needed', async () => {
		await enqueue_if_needed(['a', 'b']);
		expect(service.enqueue_if_needed).toHaveBeenCalledWith(['a', 'b']);
	});
});
