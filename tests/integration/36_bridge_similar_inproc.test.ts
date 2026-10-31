import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { emit, on, start_event_bridge } from '../../src/core/events';
import { similar_artist_ids } from '../../src/services/entities/similar';
import { eventually, pool, query, unique } from './helpers';

const configured = Boolean(process.env.DATABASE_URL);

async function artist(name: string) {
	const [{ illusi_id }] = await query<{ illusi_id: string }>('insert into service_ids_table default values returning illusi_id');
	await query('insert into artists_table (id, name) values ($1, $2)', [illusi_id, name]);
	return illusi_id;
}

describe.skipIf(!configured)('similar artists (database)', () => {
	const ids: string[] = [];
	afterAll(async () => {
		await query('delete from artists_table where id = any($1)', [ids]);
		await query('delete from service_ids_table where illusi_id = any($1)', [ids]);
	});

	it('reads pairs in both directions without duplicates', async () => {
		const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(i => artist(unique(`sim${i}`))));
		ids.push(a, b, c, d);
		await query('insert into similar_artists_table (artist_id, similar_artist_id) values ($1, $2), ($3, $1), ($1, $4), ($4, $1)', [a, b, c, d]);
		expect((await similar_artist_ids(db, a)).sort()).toEqual([b, c, d].sort());
		expect(await similar_artist_ids(db, b)).toEqual([a]);
		expect(await similar_artist_ids(db, randomUUID())).toEqual([]);
	});
});

describe.skipIf(!configured)('event bridge (database)', () => {
	it('re-emits broadcast events published by other processes and survives a lost connection', async () => {
		const stop = start_event_bridge();
		const seen: unknown[] = [];
		on('export_requested', payload => { seen.push(payload); });
		const notify = (payload: unknown) => query('select pg_notify($1, $2)', ['illusi_events', JSON.stringify({ name: 'export_requested', payload, origin: 'another-process' })]);
		try {
			await eventually(async () => {
				await notify({ id: 'first' });
				await new Promise(r => setTimeout(r, 100));
				expect(seen).toContainEqual({ id: 'first' });
			});
			// A notification on another channel or without a payload is ignored, never thrown.
			await query('select pg_notify($1, $2)', ['other_channel', '{}']);
			// Kill the bridge's connection: it reconnects and keeps delivering.
			await query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'illusi-events' and pid <> pg_backend_pid()`);
			await eventually(async () => {
				await notify({ id: 'after-reconnect' });
				await new Promise(r => setTimeout(r, 300));
				expect(seen).toContainEqual({ id: 'after-reconnect' });
			}, 15_000);
			// Own events are published to the other processes.
			const heard = new Promise<unknown>(resolve => { void pool.connect().then(async client => {
				client.on('notification', m => { if (m.payload?.includes('"mine"')) { client.release(); resolve(JSON.parse(m.payload)); } });
				await client.query('listen illusi_events');
				emit('export_requested', { id: 'mine' });
			}); });
			expect(await heard).toMatchObject({ name: 'export_requested', payload: { id: 'mine' } });
		} finally {
			await stop();
		}
	}, 40_000);
});
