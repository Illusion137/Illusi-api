import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
const { API_BASE, add_to_library, api, contribute, create_user, mock_album, query, unique, wav_bytes } = await import('./helpers');
const { config } = await import('../../src/config');
const { db } = await import('../../src/db');
const { artwork_path } = await import('../../src/services/playlists/artwork');
const exporter = await import('../../src/services/account/export');
const { on_emit } = { on_emit: (await import('../../src/core/events')).emit };

afterAll(async () => { await app.stop(); });

const mutable = config as unknown as { MEDIA_ACCEL_PREFIX: string; MEDIA_DIR: string; DISK_MIN_FREE_GB: number };
async function with_accel<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
	const saved = mutable.MEDIA_ACCEL_PREFIX;
	mutable.MEDIA_ACCEL_PREFIX = prefix;
	try { return await fn(); } finally { mutable.MEDIA_ACCEL_PREFIX = saved; }
}
const raw_get = (url: string, token: string, method = 'GET') => fetch(url, { method, headers: { authorization: `Bearer ${token}` } });

describe('playlist artwork downloads', () => {
	it('answers 404 for a missing file, HEAD without a body, accel redirects and unreadable files', async () => {
		const user = await create_user('art-dl');
		const playlist_id = randomUUID();
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: randomUUID(), changes: { playlists: [{ id: playlist_id, title: 'Art', edited_at: new Date(Date.now() - 1000).toISOString() }] } } });
		const artwork_id = `${randomUUID()}.jpg`;
		await query('update playlists_table set artwork_id = $1 where id = $2', [artwork_id, playlist_id]);
		const url = `${API_BASE}/artwork/${artwork_id}`;
		const file = artwork_path(artwork_id)!;

		expect((await raw_get(url, user.access_token)).status).toBe(404);
		expect((await with_accel('/protected/', () => raw_get(url, user.access_token))).status).toBe(404);
		// Moved to the media bucket: redirected there.
		const original = config.MEDIA_PUBLIC_URL;
		config.MEDIA_PUBLIC_URL = 'https://bucket.example.com/media';
		try {
			const moved = await fetch(url, { headers: { authorization: `Bearer ${user.access_token}` }, redirect: 'manual' });
			expect([moved.status, moved.headers.get('location')]).toEqual([302, `https://bucket.example.com/media/artwork/${artwork_id}`]);
		} finally {
			config.MEDIA_PUBLIC_URL = original;
		}

		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]));
		const accel = await with_accel('/protected/', () => raw_get(url, user.access_token));
		expect([accel.status, accel.headers.get('x-accel-redirect')]).toEqual([200, `/protected/artwork/${artwork_id}`]);
		const head = await raw_get(url, user.access_token, 'HEAD');
		expect(head.status).toBe(200);
		expect(head.headers.get('content-length')).toBe('8');
		expect((await raw_get(url, user.access_token)).status).toBe(200);
		await rm(file);

		// A directory where the file should be: stat works, reading fails mid-response.
		await mkdir(file);
		try {
			await raw_get(url, user.access_token).then(r => r.arrayBuffer()).catch(() => undefined);
		} finally {
			await rm(file, { recursive: true, force: true });
		}
	});
});

describe('media downloads', () => {
	it('redirects to nginx when configured and survives an unreadable file', async () => {
		const user = await create_user('media-dl');
		const created = await contribute(user, mock_album({ artist: unique('DL Artist'), album: unique('DL Album'), n: 1, imported: true }));
		const track_id = created.body.refs.t0 as string;
		await add_to_library(user, [track_id]);
		const form = new FormData();
		form.append('file', new Blob([new Uint8Array(wav_bytes(7))], { type: 'audio/wav' }), 'a.wav');
		expect((await api('POST', `/tracks/${track_id}/media`, { token: user.access_token, raw: form })).status).toBe(201);
		const [{ resource_id }] = await query<{ resource_id: string }>('select resource_id from media_table where track_id = $1', [track_id]);
		const url = `${API_BASE}/media/${resource_id}`;

		const accel = await with_accel('/protected/', () => raw_get(url, user.access_token));
		expect(accel.headers.get('x-accel-redirect')).toBe(`/protected/${resource_id}`);

		const file = path.join(config.MEDIA_DIR, resource_id);
		const backup = `${file}.bak`;
		await import('node:fs/promises').then(fs => fs.rename(file, backup));
		await mkdir(file);
		try {
			await raw_get(url, user.access_token).then(r => r.arrayBuffer()).catch(() => undefined);
		} finally {
			await rm(file, { recursive: true, force: true });
			await import('node:fs/promises').then(fs => fs.rename(backup, file));
		}
	});
});

describe('account export downloads', () => {
	it('covers expired, not ready, accel, missing file, HEAD and unreadable file', async () => {
		const user = await create_user('exp-dl');
		const job = async (values: Record<string, unknown>) => {
			const id = randomUUID();
			const cols = { id, user_id: user.id, status: 'READY', file_name: `${id}.json.gz`, expires_at: new Date(Date.now() + 3_600_000), ...values };
			const keys = Object.keys(cols);
			await query(`insert into export_jobs_table (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols));
			return { id, file_name: cols.file_name as string };
		};
		const get = (id: string, method = 'GET') => raw_get(`${API_BASE}/me/export/${id}/file`, user.access_token, method);

		expect((await get((await job({ status: 'EXPIRED' })).id)).status).toBe(410);
		expect((await get((await job({ expires_at: new Date(Date.now() - 1000) })).id)).status).toBe(410);
		expect((await get((await job({ status: 'PENDING', file_name: null })).id)).status).toBe(409);

		const ready = await job({});
		const accel = await with_accel('/protected/', () => get(ready.id));
		expect(accel.headers.get('x-accel-redirect')).toBe(`/protected/.exports/${ready.file_name}`);
		expect((await get(ready.id)).status).toBe(410);

		const file = path.join(exporter.exports_dir(), ready.file_name);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, 'x');
		expect((await get(ready.id, 'HEAD')).status).toBe(200);
		await rm(file);
		await mkdir(file);
		try {
			await get(ready.id).then(r => r.arrayBuffer()).catch(() => undefined);
		} finally {
			await rm(file, { recursive: true, force: true });
		}
		const bad_name = await job({ file_name: 'not-a-valid-name' });
		expect((await get(bad_name.id)).status).toBe(500);
	});
});

describe('export runner', () => {
	it('fails jobs when storage is full or the export cannot be written, and sweeps stray files', async () => {
		const user = await create_user('exp-run');
		const base = { id: randomUUID(), user_id: user.id, status: 'RUNNING', file_name: null, size: null, error: null, created_at: new Date(), started_at: new Date(), finished_at: null, expires_at: null } as const;

		await query('insert into export_jobs_table (id, user_id, status) values ($1, $2, $3)', [base.id, user.id, 'RUNNING']);
		const saved = mutable.DISK_MIN_FREE_GB;
		mutable.DISK_MIN_FREE_GB = 1e9;
		try { await exporter.run_job({ ...base }); } finally { mutable.DISK_MIN_FREE_GB = saved; }
		expect((await query('select status from export_jobs_table where id = $1', [base.id]))[0].status).toBe('FAILED');

		// The user is unknown to the writer: the export throws, the partial file is removed and the job is not found.
		await exporter.run_job({ ...base, id: randomUUID(), user_id: randomUUID() });
		const dir = exporter.exports_dir();
		expect((await readdir(dir)).filter(n => n.endsWith('.part'))).toEqual([]);

		const stray = `${randomUUID()}.json.gz`;
		await writeFile(path.join(dir, stray), 'stale');
		await exporter.cleanup_exports();
		expect(await readdir(dir)).not.toContain(stray);
		const saved_dir = mutable.MEDIA_DIR;
		mutable.MEDIA_DIR = '/nonexistent/illusi-media';
		try { await exporter.cleanup_exports(); } finally { mutable.MEDIA_DIR = saved_dir; }
	});

	it('keeps running when claiming fails and when the periodic cleanup fails', async () => {
		const intervals: (() => void)[] = [];
		const set_interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { intervals.push(fn); return { unref: () => undefined } as unknown as NodeJS.Timeout; }) as never);
		await exporter.start();
		set_interval.mockRestore();
		try {
			const execute = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('claim failed'));
			on_emit('export_requested', { id: 'wake' });
			await vi.waitFor(() => { expect(execute).toHaveBeenCalled(); });
			execute.mockRestore();
			const update = vi.spyOn(db, 'update').mockImplementationOnce((() => { throw new Error('cleanup failed'); }) as never);
			intervals[0]();
			await vi.waitFor(() => { expect(update).toHaveBeenCalled(); });
			update.mockRestore();
		} finally {
			await exporter.stop();
		}
	});
});
