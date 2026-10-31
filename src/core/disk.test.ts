import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';

const h = vi.hoisted(() => ({ statfs: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('node:fs/promises', () => ({ statfs: h.statfs }));
vi.mock('./log', () => ({ logger: () => h.log }));

const GB = 1024 ** 3;
const free_gb = (gb: number) => h.statfs.mockResolvedValue({ bavail: gb, bsize: GB });
const original = { warn: config.DISK_WARN_FREE_GB, min: config.DISK_MIN_FREE_GB };

async function load() {
	vi.resetModules();
	return await import('./disk.js');
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	config.DISK_WARN_FREE_GB = 10;
	config.DISK_MIN_FREE_GB = 5;
});
afterEach(() => {
	vi.useRealTimers();
	config.DISK_WARN_FREE_GB = original.warn;
	config.DISK_MIN_FREE_GB = original.min;
});

describe('free_bytes', () => {
	it('is available blocks times block size for the given dir', async () => {
		h.statfs.mockResolvedValue({ bavail: 7, bsize: 4096 });
		const { free_bytes } = await load();
		expect(await free_bytes('/x')).toBe(7 * 4096);
		expect(h.statfs).toHaveBeenCalledWith('/x');
	});
});

describe('start_disk_monitor', () => {
	it('stays quiet while there is enough space', async () => {
		free_gb(50);
		const { start_disk_monitor } = await load();
		const stop = start_disk_monitor();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.log.error).not.toHaveBeenCalled();
		stop();
	});

	it('warns once, then every six hours, and logs recovery', async () => {
		free_gb(8);
		const { start_disk_monitor } = await load();
		const stop = start_disk_monitor();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.log.error).toHaveBeenCalledWith('disk space low: upgrade storage soon', expect.objectContaining({ free_gb: 8 }));
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(h.log.error).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
		expect(h.log.error).toHaveBeenCalledTimes(2);
		free_gb(50);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(h.log.info).toHaveBeenCalledWith('disk space recovered: 50 GB free');
		stop();
	});

	it('says uploads are refused below the minimum', async () => {
		free_gb(2);
		const { start_disk_monitor } = await load();
		start_disk_monitor()();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.log.error).toHaveBeenCalledWith('disk full: file uploads are refused', expect.anything());
	});

	it('warns and carries on when statfs fails, and stop ends the timer', async () => {
		h.statfs.mockRejectedValue(new Error('EIO'));
		const { start_disk_monitor } = await load();
		const stop = start_disk_monitor();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(h.log.warn).toHaveBeenCalledTimes(2);
		stop();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(h.log.warn).toHaveBeenCalledTimes(2);
	});
});

describe('require_disk_space', () => {
	function run(guard: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
		const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
		res.status.mockReturnValue(res);
		const next = vi.fn();
		return guard({} as Request, res as unknown as Response, next).then(() => ({ res, next }));
	}

	it('lets the request through when stat fails', async () => {
		h.statfs.mockRejectedValue(new Error('EIO'));
		const { require_disk_space } = await load();
		const { next } = await run(require_disk_space);
		expect(next).toHaveBeenCalled();
		expect(h.log.warn).toHaveBeenCalled();
	});

	it('reports the transition into and out of refusal once each', async () => {
		const { require_disk_space } = await load();
		free_gb(1);
		expect((await run(require_disk_space)).res.status).toHaveBeenCalledWith(507);
		await run(require_disk_space);
		expect(h.log.error).toHaveBeenCalledTimes(1);
		free_gb(20);
		expect((await run(require_disk_space)).next).toHaveBeenCalled();
		expect(h.log.info).toHaveBeenCalledWith('disk space back above 5 GB: accepting file uploads');
	});
});
