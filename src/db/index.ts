import '../load_env';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { current_context } from '../core/context';
import { logger } from '../core/log';

const USER_SETTING = 'app.user_id';
const log = logger('db');

function env_int(name: string, fallback: number): number {
	const raw = process.env[name];
	const value = raw === undefined || raw === '' ? NaN : Number(raw);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Table owner connection (bypasses row-level security). Falls back to DATABASE_URL when no separate owner is configured. */
export function owner_database_url(): string | undefined {
	return process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
}

function pool_options(connectionString: string | undefined, overrides: PoolConfig = {}): PoolConfig {
	return {
		connectionString,
		max: env_int('DB_POOL_MAX', 10),
		idleTimeoutMillis: env_int('DB_IDLE_TIMEOUT_MS', 30_000),
		connectionTimeoutMillis: env_int('DB_CONNECT_TIMEOUT_MS', 5_000),
		statement_timeout: env_int('DB_STATEMENT_TIMEOUT_MS', 15_000),
		idle_in_transaction_session_timeout: env_int('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 60_000),
		application_name: process.env.LOG_SERVICE ? `illusi-${process.env.LOG_SERVICE}` : 'illusi',
		...overrides
	};
}

/**
 * A pg pool on the owner connection. Every connection gets a `statement_timeout` (DB_STATEMENT_TIMEOUT_MS, 0 = none)
 * so a runaway query can't hold a connection forever, and transactions left idle are killed.
 */
export function create_pool(overrides: PoolConfig = {}): Pool {
	return new Pool(pool_options(owner_database_url(), overrides));
}

/**
 * Sends the queries of an authenticated request through the restricted DATABASE_URL role with `app.user_id` set, so
 * row-level security limits them to that user's rows. Everything else (background jobs, login/registration, admin
 * requests) uses the owner connection.
 */
export class RoutingPool extends Pool {
	constructor(private readonly restricted: Pool | null, options: PoolConfig) {
		super(options);
		for (const pool of [this, restricted]) pool?.on('error', err => log.error('idle database client failed', err));
	}

	private scoped_user(): string | undefined {
		const context = current_context();
		if (!this.restricted || !context || context.privileged) return undefined;
		return context.user_id();
	}

	private async scoped_connect(user: string, restricted: Pool): Promise<PoolClient> {
		const client = await restricted.connect();
		try {
			await client.query('select set_config($1, $2, false)', [USER_SETTING, user]);
		} catch (err) {
			client.release(err as Error);
			throw err;
		}
		const release = client.release.bind(client);
		client.release = (err?: Error | boolean) => {
			if (err) return release(err);
			client.query('select set_config($1, $2, false)', [USER_SETTING, '']).then(() => release(), (reset_err: unknown) => release(reset_err instanceof Error ? reset_err : true));
		};
		return client;
	}

	// pg's overloads (callbacks, query configs) can't be forwarded type-safely; drizzle only uses the promise forms.
	override connect(...args: unknown[]): any {
		const user = this.scoped_user();
		if (!user || !this.restricted || typeof args[0] === 'function') return (super.connect as (...a: unknown[]) => unknown)(...args);
		return this.scoped_connect(user, this.restricted);
	}

	override query(...args: unknown[]): any {
		const user = this.scoped_user();
		if (!user || !this.restricted) return (super.query as (...a: unknown[]) => unknown)(...args);
		return this.scoped_connect(user, this.restricted).then(async (client) => {
			try {
				return await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
			} finally {
				client.release();
			}
		});
	}

	override async end(): Promise<void> {
		await Promise.all([super.end(), this.restricted?.end()]);
	}
}

function create_routing_pool(): RoutingPool {
	const owner_url = owner_database_url();
	const restricted = owner_url && owner_url !== process.env.DATABASE_URL ? new Pool(pool_options(process.env.DATABASE_URL)) : null;
	return new RoutingPool(restricted, pool_options(owner_url));
}

export const db = drizzle({ client: create_routing_pool() });

export type DB = typeof db;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type Executor = DB | Tx;

export async function all_queries<const T extends readonly PromiseLike<unknown>[]>(ex: Executor, queries: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
	type Out = { -readonly [K in keyof T]: Awaited<T[K]> };
	if (ex === db) return await Promise.all(queries);
	const out: unknown[] = [];
	for (const q of queries) out.push(await q);
	return out as Out;
}
