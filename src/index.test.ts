import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
	const server = Object.assign({}, {
		keepAliveTimeout: 0,
		close: (cb: () => void) => { cb(); },
		closeIdleConnections: () => undefined,
		closeAllConnections: () => undefined
	});
	return {
		server,
		config: { PORT: 0, APP_VERSION: 'test', BACKGROUND_SERVICES: true, SHUTDOWN_GRACE_MS: 10 },
		execute: vi.fn(),
		create_app: vi.fn(),
		leader_stop: vi.fn(async () => undefined),
		run_as_leader: vi.fn(),
		service_start: vi.fn(async () => undefined),
		service_stop: vi.fn(async () => undefined),
		sentry_close: vi.fn(async () => true)
	};
});

vi.mock('./instrument', () => ({}));
vi.mock('@sentry/node', () => ({ close: h.sentry_close }));
vi.mock('./config', () => ({ config: h.config }));
vi.mock('./app', () => ({ create_app: h.create_app }));
vi.mock('./db', () => ({ db: { execute: h.execute, $client: { end: vi.fn(async () => undefined) } }, create_pool: vi.fn(() => ({})) }));
vi.mock('./core/rate_limit', () => ({ use_shared_rate_limits: vi.fn() }));
vi.mock('./core/cleanup', () => ({ start: h.service_start, stop: h.service_stop }));
vi.mock('./core/disk', () => ({ start_disk_monitor: () => () => undefined }));
vi.mock('./core/events', () => ({ start_event_bridge: () => async () => undefined }));
vi.mock('./core/health', () => ({ set_draining: vi.fn() }));
vi.mock('./core/leader', () => ({ LEADER_LOCKS: { background_services: 1, exports: 2, cleanup: 3 }, run_as_leader: h.run_as_leader }));
vi.mock('./core/log', () => ({ logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('./services/account/export', () => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('./services/analyzer', () => ({ start: h.service_start, stop: h.service_stop }));
vi.mock('./services/itunes', () => ({ start: h.service_start, stop: h.service_stop }));

describe('server entrypoint', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		h.execute.mockResolvedValue([]);
		h.create_app.mockReturnValue({ listen: (_port: number, cb: () => void) => { cb(); return h.server; } });
		h.run_as_leader.mockImplementation((_name: string, _key: number, start: () => Promise<void>, stop: () => Promise<void>) => {
			void start();
			return { stop: async () => { await stop(); await h.leader_stop(); } };
		});
	});

	it('waits for the database, starts the background services and drains on SIGTERM', async () => {
		h.execute.mockRejectedValueOnce(new Error('not ready'));
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		const handlers: Record<string, () => void> = {};
		const on = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => { handlers[event] = fn; return process; }) as never);
		try {
			await import('./index.js');
			await vi.waitFor(() => { expect(handlers.SIGTERM).toBeDefined(); }, { timeout: 5_000 });
			expect(h.service_start).toHaveBeenCalledTimes(3);
			handlers.SIGTERM();
			handlers.SIGINT();
			await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0); });
			expect(h.service_stop).toHaveBeenCalledTimes(3);
		} finally {
			exit.mockRestore();
			on.mockRestore();
		}
	});

	it('exits with an error when startup fails', async () => {
		h.create_app.mockImplementation(() => { throw new Error('boom'); });
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		try {
			await import('./index.js');
			await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(1); });
		} finally {
			exit.mockRestore();
		}
	});
});
