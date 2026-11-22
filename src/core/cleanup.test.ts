import { describe, expect, it, vi } from 'vitest';

const execute = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { execute } }));
vi.mock('./log', () => ({ logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { cleanup_tasks, run_cleanup } from './cleanup';

describe('run_cleanup', () => {
	it('deletes each table in batches until a short batch, and keeps going past a failing task', async () => {
		const tasks = cleanup_tasks();
		execute.mockReset();
		// First task: a full batch then a short one; second task fails; the rest remove nothing.
		execute.mockResolvedValueOnce([{ n: 5_000 }]).mockResolvedValueOnce([{ n: 3 }]).mockRejectedValueOnce(new Error('boom'));
		execute.mockResolvedValue([{ n: 0 }]);
		const removed = await run_cleanup();
		expect(removed[tasks[0].name]).toBe(5_003);
		expect(removed[tasks[1].name]).toBeUndefined();
		expect(Object.keys(removed)).toHaveLength(tasks.length - 1);
	});

	it('covers every table that only grows', () => {
		expect(cleanup_tasks().map(t => t.table)).toEqual(expect.arrayContaining([
			'sync_pushes_table', 'sessions_table', 'action_token_uses_table', 'email_verifications_table', 'password_resets_table', 'users_table', 'rate_limit_counters_table'
		]));
	});
});
