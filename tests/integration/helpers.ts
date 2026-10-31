import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';

export const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/u, '');
/** Versioned API base; `/health` lives at the root (`root: true`). */
export const API_BASE = `${API_URL}/api/v1`;
/** Direct database access for setup and assertions: the table owner, so row-level security doesn't hide anything. */
export const pool = new pg.Pool({ connectionString: process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL, max: 4 });

export const uuid = () => randomUUID();
export const days_ago = (days: number) => new Date(Date.now() - days * 86_400_000);
export const unique = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;

/** A distinct client address per simulated device; the API trusts X-Forwarded-For from loopback like it does from nginx. */
export const fresh_ip = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

export interface ApiResponse<T = any> { status: number; body: T; headers: Headers; text: string }

export interface RequestOptions {
	token?: string;
	body?: unknown;
	ip?: string;
	headers?: Record<string, string>;
	/** Sent as-is (e.g. FormData) instead of JSON. */
	raw?: BodyInit;
	/** Path is relative to the server root instead of the versioned API. */
	root?: boolean;
}

export async function api<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
	const headers: Record<string, string> = { ...opts.headers };
	if (opts.token) headers.authorization = `Bearer ${opts.token}`;
	if (opts.ip) headers['x-forwarded-for'] = opts.ip;
	let body: BodyInit | undefined = opts.raw;
	if (opts.body !== undefined) {
		headers['content-type'] = 'application/json';
		body = JSON.stringify(opts.body);
	}
	const res = await fetch(`${opts.root ? API_URL : API_BASE}${path}`, { method, headers, body });
	const text = await res.text();
	let parsed: unknown = text;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch { /* non-JSON body (media) */ }
	return { status: res.status, body: parsed as T, headers: res.headers, text };
}

export interface TestUser {
	id: string;
	email: string;
	password: string;
	ip: string;
	access_token: string;
	refresh_token: string;
}

function jwt_sub(token: string): string {
	return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub as string;
}

/** Registers a user; `verified: false` leaves the email unconfirmed. */
export async function create_user(name = 'user', { verified = true } = {}): Promise<TestUser> {
	const email = `${unique(name)}@example.test`;
	const password = `pw-${randomBytes(8).toString('hex')}`;
	const ip = fresh_ip();
	const res = await api('POST', '/auth/register', { ip, body: { username: name, email, password } });
	if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
	if (verified) await pool.query('update users_table set email_verified_at = now() where email = $1', [email]);
	return { id: jwt_sub(res.body.access_token), email, password, ip, access_token: res.body.access_token, refresh_token: res.body.refresh_token };
}

/** Promotes a user and logs in again so the access token carries the role. */
export async function make_admin(user: TestUser): Promise<TestUser> {
	await pool.query(`update users_table set role = 'ADMIN' where id = $1`, [user.id]);
	const res = await api('POST', '/auth/login', { ip: user.ip, body: { email: user.email, password: user.password } });
	return { ...user, access_token: res.body.access_token, refresh_token: res.body.refresh_token };
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
	return (await pool.query<T>(text, params)).rows;
}

/** Retries `fn` until it stops throwing (for background work like SoundCloud ingest). */
export async function eventually<T>(fn: () => Promise<T>, timeout_ms = 10_000): Promise<T> {
	const deadline = Date.now() + timeout_ms;
	for (;;) {
		try {
			return await fn();
		} catch (err) {
			if (Date.now() > deadline) throw err;
			await new Promise(r => setTimeout(r, 200));
		}
	}
}

/** Runs a repo script (e.g. the reconcile worker) with the API's environment and returns its output. */
export function run_script(args: string[], timeout_ms = 120_000): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn('node', ['--import', 'tsx', ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
		child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
		const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${args.join(' ')}\n${output}`)); }, timeout_ms);
		child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
	});
}

/** A tiny but valid WAV file. `seed` changes the content hash. */
export function wav_bytes(seed = 0, samples = 800): Buffer {
	const data = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((i + seed) / 8) * 8000), i * 2);
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(8000, 24);
	header.writeUInt32LE(16000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

/** A mock catalog: one artist with an album of `n` tracks, as a contribution graph. */
export function mock_album(opts: { artist: string; album: string; n?: number; release_date?: Date; album_type?: 'ALBUM' | 'SINGLE' | 'EP'; tag?: string; imported?: boolean }) {
	const tag = opts.tag ?? randomBytes(3).toString('hex');
	const n = opts.n ?? 3;
	const tracks = Array.from({ length: n }, (_, i) => ({
		ref: `t${i}`,
		title: `${opts.album} Track ${i + 1}`,
		album_ref: 'al',
		duration_ms: 180_000 + i * 1_000,
		...(opts.imported ? { imported: true } : {}),
		service_ids: { spotify_id: `sp${tag}t${i}`.padEnd(22, '0').slice(0, 22), isrc: `US${tag.slice(0, 3).toUpperCase()}${String(parseInt(tag, 16) % 100_000 * 100 + i).padStart(7, '0')}` }
	}));
	return {
		artists: [{ ref: 'ar', name: opts.artist, service_ids: { spotify_id: `sp${tag}ar`.padEnd(22, '0').slice(0, 22) } }],
		albums: [{
			ref: 'al', name: opts.album, artist_ref: 'ar', album_type: opts.album_type ?? 'ALBUM', track_count: n,
			release_date: (opts.release_date ?? new Date('2020-01-01')).toISOString(),
			service_ids: { spotify_id: `sp${tag}al`.padEnd(22, '0').slice(0, 22) },
			thumbnails: [{ url: `https://img.example.test/${tag}/600x600.jpg`, width: 600, height: 600 }]
		}],
		tracks,
		relations: {
			tracks_artists: tracks.map(t => ({ track_ref: t.ref, artist_ref: 'ar' })),
			album_tracks: tracks.map((t, i) => ({ album_ref: 'al', track_ref: t.ref, track_number: i + 1 })),
			artist_albums: [{ artist_ref: 'ar', album_ref: 'al', position: 0 }]
		}
	};
}

export async function contribute(user: TestUser, graph: object, contribution_id = uuid()) {
	return api('POST', '/contribute', { token: user.access_token, body: { contribution_id, ...graph } });
}

/** Adds tracks to the user's library through sync push. */
export async function add_to_library(user: TestUser, track_ids: string[], extra: Record<string, unknown> = {}) {
	const edited_at = new Date().toISOString();
	const res = await api('POST', '/sync/push', {
		token: user.access_token,
		body: { push_id: uuid(), changes: { user_tracks: track_ids.map(track_id => ({ track_id, edited_at, ...extra })) } }
	});
	if (res.status !== 200) throw new Error(`push failed: ${res.status} ${res.text}`);
	return res;
}
