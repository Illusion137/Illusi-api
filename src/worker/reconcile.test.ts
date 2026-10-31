import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	run_pass: vi.fn(),
	end: vi.fn(),
	with_monitor: vi.fn(),
	check_in: vi.fn(),
	close: vi.fn(),
	log_error: vi.fn()
}));

vi.mock('../instrument', () => ({}));
vi.mock('@sentry/node', () => ({ withMonitor: mocks.with_monitor, captureCheckIn: mocks.check_in, close: mocks.close }));
vi.mock('../core/log', () => ({ logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.log_error }) }));
vi.mock('../db', () => ({ db: { $client: { end: mocks.end } } }));
vi.mock('./reconcile/run', () => ({ run_pass: mocks.run_pass }));

const report = (over: Record<string, unknown> = {}) => ({ mode: 'incremental', dry_run: false, locked: true, groups: 0, ...over });

async function start(...args: string[]) {
	vi.resetModules();
	process.argv = ['node', 'reconcile.ts', ...args];
	await import('./reconcile.js');
}

const stop = () => process.emit('SIGTERM');
const original_argv = process.argv;

beforeEach(() => {
	vi.resetAllMocks();
	mocks.run_pass.mockResolvedValue(report());
	mocks.with_monitor.mockImplementation(async (_slug: string, fn: () => Promise<unknown>) => fn());
	mocks.close.mockResolvedValue(true);
	mocks.end.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	process.argv = original_argv;
});

describe('reconcile worker one-off runs', () => {
	it('runs one incremental pass and closes the pool, without a monitor check-in', async () => {
		await start('--once');
		await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledTimes(1));
		expect(mocks.run_pass).toHaveBeenCalledWith(expect.objectContaining({ mode: 'incremental', dry_run: false, thresholds: expect.objectContaining({ max_group_size: expect.any(Number) }) }));
		expect(mocks.with_monitor).not.toHaveBeenCalled();
	});

	it('prints the plans of a dry run', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		mocks.run_pass.mockResolvedValue(report({ mode: 'full', dry_run: true, plans: [{ key: 'abc', steps: [] }] }));
		await start('--once', '--full', '--dry-run');
		await vi.waitFor(() => expect(mocks.end).toHaveBeenCalled());
		expect(mocks.run_pass).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full', dry_run: true }));
		expect(log).toHaveBeenCalledWith(expect.stringContaining('"key": "abc"'));
	});

	it('stays quiet when a dry run has no plans', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		await start('--once', '--dry-run');
		await vi.waitFor(() => expect(mocks.end).toHaveBeenCalled());
		expect(log).not.toHaveBeenCalled();
	});

	it('exits with status 1 on bad arguments or a failed pass', async () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		await start('--bogus');
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
		expect(mocks.log_error).toHaveBeenCalledWith('worker crashed', expect.any(Error));
		expect(mocks.close).toHaveBeenCalledWith(2_000);
		exit.mockClear();
		mocks.run_pass.mockRejectedValue(new Error('db down'));
		await start('--once');
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
	});
});

describe('reconcile worker scheduler', () => {
	it('runs the initial full pass under its monitor and also checks in the incremental one', async () => {
		await start('--full');
		await vi.waitFor(() => expect(mocks.run_pass).toHaveBeenCalledTimes(1));
		expect(mocks.run_pass).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full' }));
		expect(mocks.with_monitor).toHaveBeenCalledWith('reconcile-full', expect.any(Function), expect.objectContaining({ schedule: expect.objectContaining({ type: 'crontab' }) }));
		expect(mocks.check_in).toHaveBeenCalledWith({ monitorSlug: 'reconcile-incremental', status: 'ok' }, expect.objectContaining({ schedule: expect.objectContaining({ type: 'interval', unit: 'minute' }) }));
		await vi.waitFor(() => expect(mocks.run_pass).toHaveBeenCalledTimes(1));
		mocks.end.mockClear();
		stop();
		expect(mocks.end).toHaveBeenCalledTimes(1);
	});

	it('runs the nightly full pass once the configured hour has passed', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0));
		await start();
		await vi.waitFor(() => expect(mocks.run_pass).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full' })));
		expect(mocks.with_monitor).toHaveBeenCalledWith('reconcile-full', expect.any(Function), expect.anything());
		stop();
	});

	it('runs an incremental pass when it is not yet time for the full one', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 5, 1, 1, 0, 0));
		await start();
		await vi.waitFor(() => expect(mocks.run_pass).toHaveBeenCalledWith(expect.objectContaining({ mode: 'incremental' })));
		expect(mocks.with_monitor).toHaveBeenCalledWith('reconcile-incremental', expect.any(Function), expect.objectContaining({ schedule: expect.objectContaining({ type: 'interval' }) }));
		expect(mocks.check_in).not.toHaveBeenCalled();
		stop();
	});

	it('keeps running after a failed pass', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 5, 1, 1, 0, 0));
		mocks.run_pass.mockRejectedValue(new Error('boom'));
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		await start();
		await vi.waitFor(() => expect(mocks.run_pass).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(mocks.with_monitor).toHaveBeenCalled());
		expect(exit).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(mocks.log_error).toHaveBeenCalledWith('pass failed', expect.any(Error)));
		stop();
	});

	it('lets a running pass finish before closing the pool, and ignores a second signal', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 5, 1, 1, 0, 0));
		let finish: (r: unknown) => void = () => undefined;
		mocks.run_pass.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
		await start();
		await vi.waitFor(() => expect(mocks.run_pass).toHaveBeenCalledTimes(1));
		stop();
		stop();
		expect(mocks.end).not.toHaveBeenCalled();
		finish(report());
		await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledTimes(1));
	});
});
