import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';

export const db = drizzle(process.env.DATABASE_URL!);

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
