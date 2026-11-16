import busboy from 'busboy';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { config } from '../../config';
import { db } from '../../db';
import { playlists_table } from '../../db/schema';
import { PendingEvents } from '../../core/events';
import { HttpError } from '../../core/http';
import { logger } from '../../core/log';
import { clamp_edited_at, lww_wins } from '../sync/lww';
import { delete_remote_media } from '../media/remote';
import { normalize_image } from '../media/transcode';

const log = logger('artwork');

export type ImageKind = 'jpeg' | 'png' | 'webp';

/** Artwork files live in their own folder of MEDIA_DIR as `<uuid>.jpg`, always re-encoded on upload. */
export const ARTWORK_SUBDIR = 'artwork';
const ARTWORK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/u;
const SNIFF_BYTES = 16;

/** Identifies an uploaded image from its leading bytes; never trusts the client's Content-Type. */
export function sniff_image(buf: Buffer): ImageKind | null {
	if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
	if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
	if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
	return null;
}

export function is_valid_artwork_id(artwork_id: string): boolean {
	return ARTWORK_ID_RE.test(artwork_id);
}

/** Absolute path of an artwork file, or null for a malformed id. */
export function artwork_path(artwork_id: string): string | null {
	return is_valid_artwork_id(artwork_id) ? path.join(config.MEDIA_DIR, ARTWORK_SUBDIR, artwork_id) : null;
}

/** Removes artwork files whose rows are gone, here and in the media bucket; a missing file is fine. */
export async function remove_artwork_files(artwork_ids: readonly (string | null)[]) {
	const removed: string[] = [];
	for (const id of artwork_ids) {
		const file = id ? artwork_path(id) : null;
		if (!file) continue;
		await rm(file, { force: true }).catch((err: unknown) => log.warn('could not remove artwork file', { artwork_id: id, err }));
		removed.push(`${ARTWORK_SUBDIR}/${id}`);
	}
	await delete_remote_media(removed);
}

/** Passes bytes through after checking the first ones are an image. */
class SniffImage extends Transform {
	size = 0;
	kind: ImageKind | null = null;
	private head: Buffer[] = [];
	private head_size = 0;

	override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
		this.size += chunk.length;
		if (this.kind !== null) {
			this.push(chunk);
			cb();
			return;
		}
		this.head.push(chunk);
		this.head_size += chunk.length;
		cb(this.head_size >= SNIFF_BYTES ? this.decide() : null);
	}

	override _flush(cb: (err?: Error | null) => void) {
		cb(this.kind === null ? this.decide() : null);
	}

	private decide(): Error | null {
		const head = Buffer.concat(this.head);
		this.head = [];
		this.kind = sniff_image(head);
		if (this.kind === null) return new HttpError(415, 'unsupported image type: expected jpeg, png or webp');
		this.push(head);
		return null;
	}
}

export interface ReceivedImage { temp_path: string; kind: ImageKind; fields: Partial<Record<string, string>> }

/**
 * Streams the `file` part of a multipart request into `dir` (sniffed, size-limited) and collects the text fields.
 * On failure the temp file is removed and an HttpError is thrown.
 */
export async function receive_image(req: Request, dir: string, max_bytes: number): Promise<ReceivedImage> {
	await mkdir(dir, { recursive: true });
	let bb: busboy.Busboy;
	try {
		bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: max_bytes, fields: 4, fieldSize: 1024 } });
	} catch {
		throw new HttpError(400, 'expected multipart/form-data');
	}
	return new Promise<ReceivedImage>((resolve, reject) => {
		const fields: Partial<Record<string, string>> = {};
		let file_task: Promise<{ temp_path: string; kind: ImageKind }> | undefined;
		let file_stream: Readable | undefined;
		let settled = false;

		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			req.unpipe(bb);
			req.resume();
			file_stream?.destroy();
			file_task?.then(async r => rm(r.temp_path, { force: true }), () => undefined).catch(() => undefined);
			reject(err instanceof HttpError ? err : new HttpError(400, 'malformed multipart body'));
		};

		const write = async (file: Readable) => {
			const temp_path = path.join(dir, `${randomUUID()}.part`);
			const sniffer = new SniffImage();
			file.once('limit', () => { sniffer.destroy(new HttpError(413, 'image too large', { max_bytes })); });
			try {
				await pipeline(file, sniffer, createWriteStream(temp_path, { flags: 'wx' }));
				if (sniffer.size === 0) throw new HttpError(400, 'empty file');
			} catch (err) {
				await rm(temp_path, { force: true });
				throw err;
			}
			return { temp_path, kind: sniffer.kind! };
		};

		bb.on('field', (name, value, info) => {
			if (info.valueTruncated) {
				fail(new HttpError(413, `field ${name} too large`));
				return;
			}
			fields[name] = value;
		});
		bb.on('file', (name, stream) => {
			if (name !== 'file' || file_task) {
				stream.resume();
				return;
			}
			file_stream = stream;
			file_task = write(stream);
			file_task.catch(fail);
		});
		bb.on('error', fail);
		bb.on('close', () => {
			if (settled) return;
			if (!file_task) {
				fail(new HttpError(400, 'missing file part'));
				return;
			}
			file_task.then((file) => {
				/* v8 ignore start: only if the request fails between the parser closing and the temp file finishing */
				if (settled) {
					rm(file.temp_path, { force: true }).catch(() => undefined);
					return;
				}
				/* v8 ignore stop */
				settled = true;
				resolve({ ...file, fields });
			}, fail);
		});
		req.on('close', () => { if (!req.complete) fail(new HttpError(400, 'upload aborted')); });
		req.pipe(bb);
	});
}

type PlaylistRow = typeof playlists_table.$inferSelect;

/** The caller's own playlist (deleted ones included, so a late upload can't resurrect it); 404 otherwise. */
export async function owned_playlist(user_id: string, playlist_id: string): Promise<PlaylistRow> {
	const [row] = await db.select().from(playlists_table).where(eq(playlists_table.id, playlist_id));
	if (row?.user_id !== user_id) throw new HttpError(404, 'playlist not found');
	return row;
}

export interface ArtworkResult { playlist: PlaylistRow; applied: boolean }

/**
 * Sets (`new_artwork_id`) or clears (null) a playlist's artwork, last-write-wins on `artwork_edited_at` with the
 * client's clamped edit time. The replaced file, or the new one when the change lost, is removed after commit.
 */
export async function set_artwork(user_id: string, playlist_id: string, new_artwork_id: string | null, client_edited_at: Date | null): Promise<ArtworkResult> {
	const now = new Date();
	const edited_at = clamp_edited_at(client_edited_at ?? now, now);
	const events = new PendingEvents();
	let orphan: string | null = null;
	const result = await db.transaction(async (tx) => {
		const [cur] = await tx.select().from(playlists_table)
			.where(and(eq(playlists_table.id, playlist_id), eq(playlists_table.user_id, user_id))).for('update');
		if (!cur) throw new HttpError(404, 'playlist not found');
		if (!lww_wins(cur.artwork_edited_at, edited_at)) {
			orphan = new_artwork_id;
			return { playlist: cur, applied: false };
		}
		const [updated] = await tx.update(playlists_table)
			.set({ artwork_id: new_artwork_id, artwork_edited_at: edited_at })
			.where(eq(playlists_table.id, playlist_id)).returning();
		orphan = cur.artwork_id;
		events.push('user_library_changed', { user_id });
		return { playlist: updated, applied: true };
	}).catch(async (err: unknown) => {
		// The new file never got a row.
		await remove_artwork_files([new_artwork_id]);
		throw err;
	});
	events.flush();
	if (orphan !== null && orphan !== result.playlist.artwork_id) await remove_artwork_files([orphan]);
	return result;
}

/** Normalizes an accepted upload into `MEDIA_DIR/artwork/<uuid>.jpg` and returns its id. */
export async function store_artwork_file(temp_path: string): Promise<string> {
	const dir = path.join(config.MEDIA_DIR, ARTWORK_SUBDIR);
	await mkdir(dir, { recursive: true });
	const artwork_id = `${randomUUID()}.jpg`;
	const part = path.join(config.MEDIA_DIR, '.incoming', `${artwork_id}.part`);
	try {
		await normalize_image(temp_path, part, config.ARTWORK_MAX_PX);
		if ((await stat(part)).size === 0) throw new HttpError(422, 'could not decode image');
		await rename(part, path.join(dir, artwork_id));
	} finally {
		await rm(part, { force: true });
	}
	return artwork_id;
}
