import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	clients: [] as {
		connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>;
		on: (event: string, fn: (err: Error) => void) => void; fire: (err: Error) => void; opts: unknown;
	}[],
	locked: [] as (boolean | Error)[],
	connect_error: null as Error | null
}));

vi.mock('pg', () => ({
	Client: class {
		listeners: ((err: Error) => void)[] = [];
		connect = vi.fn(async () => { if (h.connect_error) throw h.connect_error; });
		query = vi.fn(async () => {
			const next = h.locked.shift() ?? false;
			if (next instanceof Error) throw next;
			return { rows: [{ locked: next }] };
		});

		end = vi.fn(async () => undefined);
		constructor(public opts: unknown) { h.clients.push(this); }
		on(_event: string, fn: (err: Error) => void) { this.listeners.push(fn); }
		fire(err: Error) { for (const fn of this.listeners) fn(err); }
	}
}));
vi.mock('../db', () => ({ owner_database_url: () => 'postgres://owner' }));
vi.mock('./log', () => ({ logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { LEADER_LOCKS, run_as_leader } from './leader';

const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => {
	vi.useFakeTimers();
	h.clients.length = 0;
	h.locked = [];
	h.connect_error = null;
});
afterEach(() => { vi.useRealTimers(); });

describe('run_as_leader', () => {
	it('has distinct lock keys', () => {
		expect(new Set(Object.values(LEADER_LOCKS)).size).toBe(Object.keys(LEADER_LOCKS).length);
	});

	it('starts once it wins the advisory lock, and stops on stop()', async () => {
		h.locked = [true];
		const start = vi.fn(async () => undefined);
		const stop = vi.fn(async () => undefined);
		const handle = run_as_leader('t', 42, start, stop);
		await flush();
		expect(start).toHaveBeenCalledOnce();
		expect(h.clients[0].query).toHaveBeenCalledWith('select pg_try_advisory_lock($1) as locked', [42]);
		expect(h.clients[0].opts).toMatchObject({ connectionString: 'postgres://owner', application_name: 'illusi-leader-t' });
		await handle.stop();
		expect(stop).toHaveBeenCalledOnce();
		expect(h.clients[0].end).toHaveBeenCalled();
	});

	it('retries as a standby until the lock frees up', async () => {
		h.locked = [false, false, true];
		const start = vi.fn(async () => undefined);
		const handle = run_as_leader('t', 1, start, async () => undefined, 1_000);
		await flush();
		expect(start).not.toHaveBeenCalled();
		expect(h.clients[0].end).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(start).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(start).toHaveBeenCalledOnce();
		await handle.stop();
	});

	it('does not call stop when it never led', async () => {
		h.locked = [false];
		const stop = vi.fn(async () => undefined);
		const handle = run_as_leader('t', 1, async () => undefined, stop, 1_000);
		await flush();
		await handle.stop();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(stop).not.toHaveBeenCalled();
		expect(h.clients).toHaveLength(1);
	});

	it('retries after a connection failure', async () => {
		h.connect_error = new Error('refused');
		const start = vi.fn(async () => undefined);
		const handle = run_as_leader('t', 1, start, async () => undefined, 1_000);
		await flush();
		h.connect_error = null;
		h.locked = [true];
		await vi.advanceTimersByTimeAsync(1_000);
		expect(start).toHaveBeenCalledOnce();
		await handle.stop();
	});

	it('retries when the lock query fails, and when start throws', async () => {
		h.locked = [new Error('query failed'), true];
		const start = vi.fn().mockRejectedValueOnce(new Error('start failed')).mockResolvedValue(undefined);
		const handle = run_as_leader('t', 1, start, async () => undefined, 1_000);
		await flush();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(start).toHaveBeenCalledTimes(1);
		h.locked = [true];
		await vi.advanceTimersByTimeAsync(1_000);
		expect(start).toHaveBeenCalledTimes(2);
		await handle.stop();
	});

	it('steps down and re-elects when the lock connection drops', async () => {
		h.locked = [true, true];
		const start = vi.fn(async () => undefined);
		const stop = vi.fn(async () => undefined);
		const handle = run_as_leader('t', 1, start, stop, 1_000);
		await flush();
		h.clients[0].fire(new Error('terminated'));
		await flush();
		expect(stop).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(start).toHaveBeenCalledTimes(2);
		await handle.stop();
		expect(stop).toHaveBeenCalledTimes(2);
	});

	it('ignores client errors while not leading', async () => {
		h.locked = [false];
		const stop = vi.fn(async () => undefined);
		const handle = run_as_leader('t', 1, async () => undefined, stop, 1_000);
		await flush();
		h.clients[0].fire(new Error('x'));
		await flush();
		expect(stop).not.toHaveBeenCalled();
		await handle.stop();
	});

	it('survives a failing stop callback', async () => {
		h.locked = [true];
		const handle = run_as_leader('t', 1, async () => undefined, async () => { throw new Error('stop failed'); });
		await flush();
		await expect(handle.stop()).resolves.toBeUndefined();
	});

	it('releases the lock if stopped while acquiring', async () => {
		h.locked = [true];
		const start = vi.fn(async () => undefined);
		const handle = run_as_leader('t', 1, start, async () => undefined);
		const stopping = handle.stop();
		await flush();
		await stopping;
		expect(start).not.toHaveBeenCalled();
		expect(h.clients[0].end).toHaveBeenCalled();
	});
});
