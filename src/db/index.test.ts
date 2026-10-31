import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run_in_context } from '../core/context';
import type { RequestContext } from '../core/context';

vi.mock('../core/log', () => ({ logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { all_queries, create_pool, db, owner_database_url, RoutingPool } from './index';

function fake_client() {
	const original = vi.fn();
	return {
		query: vi.fn(async (..._args: unknown[]) => ({ rows: [{ ok: 1 }] })),
		release: original,
		original
	};
}

function fake_restricted(client = fake_client()) {
	const handlers: Record<string, (err: Error) => void> = {};
	return {
		client,
		pool: { connect: vi.fn(async () => client), end: vi.fn(async () => undefined), on: vi.fn((event: string, fn: (err: Error) => void) => { handlers[event] = fn; }) },
		handlers
	};
}

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({ request_id: 'r', user_id: () => 'user-1', ...over });
const set_config_calls = (client: ReturnType<typeof fake_client>) => client.query.mock.calls.filter(c => String(c[0]).includes('set_config'));

let super_query: ReturnType<typeof vi.spyOn>;
let super_connect: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	super_query = vi.spyOn(Pool.prototype, 'query').mockResolvedValue({ rows: [{ owner: 1 }] } as never);
	super_connect = vi.spyOn(Pool.prototype, 'connect').mockResolvedValue('owner-client' as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('RoutingPool routing', () => {
	it('uses the owner pool without a request context', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		await pool.query('select 1');
		expect(super_query).toHaveBeenCalledWith('select 1');
		expect(r.pool.connect).not.toHaveBeenCalled();
	});

	it('uses the owner pool when the context has no user yet (login, registration)', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		await run_in_context(ctx({ user_id: () => undefined }), async () => { await pool.query('select 1'); });
		expect(super_query).toHaveBeenCalledOnce();
		expect(r.pool.connect).not.toHaveBeenCalled();
	});

	it('uses the owner pool for privileged contexts', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		await run_in_context(ctx({ privileged: true }), async () => { await pool.query('select 1'); });
		expect(super_query).toHaveBeenCalledOnce();
		expect(r.pool.connect).not.toHaveBeenCalled();
	});

	it('uses the owner pool when no restricted pool is configured', async () => {
		const pool = new RoutingPool(null, {});
		await run_in_context(ctx(), async () => { await pool.query('select 1'); await pool.connect(); });
		expect(super_query).toHaveBeenCalledOnce();
		expect(super_connect).toHaveBeenCalledOnce();
	});

	it('sees a privilege granted mid-request (require_admin)', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		const context = ctx();
		await run_in_context(context, async () => {
			await pool.query('select 1');
			context.privileged = true;
			await pool.query('select 2');
		});
		expect(r.pool.connect).toHaveBeenCalledOnce();
		expect(super_query).toHaveBeenCalledWith('select 2');
	});
});

describe('RoutingPool scoped queries', () => {
	it('sets app.user_id, runs the query on the restricted client, then resets and releases', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		const result = await run_in_context(ctx(), async () => await pool.query('select $1', [1]));
		expect(result).toEqual({ rows: [{ ok: 1 }] });
		expect(r.client.query.mock.calls.map(c => c[0])).toEqual(['select set_config($1, $2, false)', 'select $1', 'select set_config($1, $2, false)']);
		expect(set_config_calls(r.client).map(c => c[1])).toEqual([['app.user_id', 'user-1'], ['app.user_id', '']]);
		expect(super_query).not.toHaveBeenCalled();
		await vi.waitFor(() => { expect(r.client.original).toHaveBeenCalledOnce(); });
		expect(r.client.original).toHaveBeenCalledWith();
	});

	it('still releases (after a reset) when the query fails', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		r.client.query.mockImplementation(async (sql: unknown) => {
			if (sql === 'select boom') throw new Error('boom');
			return { rows: [] };
		});
		await expect(run_in_context(ctx(), async () => await pool.query('select boom'))).rejects.toThrow('boom');
		await vi.waitFor(() => { expect(r.client.original).toHaveBeenCalledOnce(); });
		expect(set_config_calls(r.client).map(c => c[1])).toEqual([['app.user_id', 'user-1'], ['app.user_id', '']]);
	});

	it('destroys the client when setting the user fails', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		const failure = new Error('set failed');
		r.client.query.mockRejectedValue(failure);
		await expect(run_in_context(ctx(), async () => await pool.query('select 1'))).rejects.toBe(failure);
		expect(r.client.original).toHaveBeenCalledWith(failure);
	});

	it('destroys the client when the reset fails so the user id cannot leak', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		const reset_failure = new Error('reset failed');
		r.client.query.mockImplementation(async (query: unknown, params: unknown) => {
			if (query === 'select set_config($1, $2, false)' && (params as string[])[1] === '') throw reset_failure;
			return { rows: [] };
		});
		await run_in_context(ctx(), async () => { await pool.query('select 1'); });
		await vi.waitFor(() => { expect(r.client.original).toHaveBeenCalledWith(reset_failure); });
	});

	it('destroys the client with true when the reset rejects with a non-error', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		r.client.query.mockImplementation(async (_query: unknown, params: unknown) => {
			if ((params as string[] | undefined)?.[1] === '') throw 'string failure'; // eslint-disable-line @typescript-eslint/only-throw-error
			return { rows: [] };
		});
		await run_in_context(ctx(), async () => { await pool.query('select 1'); });
		await vi.waitFor(() => { expect(r.client.original).toHaveBeenCalledWith(true); });
	});
});

describe('RoutingPool.connect', () => {
	it('hands out a scoped client whose release resets the setting', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		const original_release = r.client.original;
		const client = await run_in_context(ctx(), async () => await pool.connect());
		expect(set_config_calls(r.client)).toHaveLength(1);
		client.release();
		await vi.waitFor(() => { expect(original_release).toHaveBeenCalledOnce(); });
		expect(set_config_calls(r.client).map(c => c[1])).toEqual([['app.user_id', 'user-1'], ['app.user_id', '']]);
	});

	it('passes an explicit release error straight through without a reset', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		const original_release = r.client.original;
		const client = await run_in_context(ctx(), async () => await pool.connect());
		const failure = new Error('bad connection');
		client.release(failure);
		expect(original_release).toHaveBeenCalledWith(failure);
		expect(set_config_calls(r.client)).toHaveLength(1);
	});

	it('leaves callback-style connect to pg', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		const callback = vi.fn();
		await run_in_context(ctx(), async () => { await (pool.connect as (...a: unknown[]) => unknown)(callback); });
		expect(super_connect).toHaveBeenCalledWith(callback);
		expect(r.pool.connect).not.toHaveBeenCalled();
	});

	it('uses the owner pool with no user', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		expect(await pool.connect()).toBe('owner-client');
	});
});

describe('RoutingPool lifecycle', () => {
	it('ends both pools', async () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		await pool.end();
		expect(r.pool.end).toHaveBeenCalledOnce();
	});

	it('ends without a restricted pool', async () => {
		await expect(new RoutingPool(null, {}).end()).resolves.toBeUndefined();
	});

	it('logs idle client errors from both pools instead of crashing', () => {
		const r = fake_restricted();
		const pool = new RoutingPool(r.pool as unknown as Pool, {});
		expect(() => { r.handlers.error(new Error('idle')); pool.emit('error', new Error('idle')); }).not.toThrow();
	});
});

describe('configuration', () => {
	it('prefers MIGRATE_DATABASE_URL for the owner connection', () => {
		vi.stubEnv('DATABASE_URL', 'postgres://app');
		vi.stubEnv('MIGRATE_DATABASE_URL', 'postgres://owner');
		expect(owner_database_url()).toBe('postgres://owner');
		vi.stubEnv('MIGRATE_DATABASE_URL', '');
		expect(owner_database_url()).toBe('postgres://app');
	});

	it('create_pool reads limits from the environment and ignores bad values', async () => {
		vi.stubEnv('DB_POOL_MAX', '3');
		vi.stubEnv('DB_STATEMENT_TIMEOUT_MS', 'abc');
		vi.stubEnv('DB_CONNECT_TIMEOUT_MS', '-5');
		vi.stubEnv('DB_IDLE_TIMEOUT_MS', '');
		vi.stubEnv('LOG_SERVICE', 'worker');
		const pool = create_pool({ max: undefined });
		const options = (pool as unknown as { options: Record<string, unknown> }).options;
		expect(options).toMatchObject({ statement_timeout: 15_000, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, application_name: 'illusi-worker' });
		expect(create_pool().options.max).toBe(3);
		await pool.end();
	});

	it('create_pool honours overrides', async () => {
		const pool = create_pool({ max: 1 });
		expect(pool.options.max).toBe(1);
		await pool.end();
	});
});

describe('all_queries', () => {
	it('runs sequentially inside a transaction and returns results in order', async () => {
		const order: number[] = [];
		const q = (n: number) => ({ then: (ok: (v: number) => void) => { order.push(n); ok(n); } }) as unknown as PromiseLike<number>;
		const tx = {} as never;
		expect(await all_queries(tx, [q(1), q(2), q(3)])).toEqual([1, 2, 3]);
		expect(order).toEqual([1, 2, 3]);
	});

	it('runs in parallel on the pool itself', async () => {
		expect(await all_queries(db, [Promise.resolve('a'), Promise.resolve(2)])).toEqual(['a', 2]);
	});
});
