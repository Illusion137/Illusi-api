import busboy from 'busboy';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import { HttpError } from '../../core/http';
import type { AudioKind } from './sniff';
import { sniff_audio, SNIFF_BYTES } from './sniff';

export interface ReceivedUpload {
	temp_path: string;
	sha256: string;
	size: number;
	kind: AudioKind;
	fields: Partial<Record<string, string>>;
}

const MAX_FIELDS = 8;
const MAX_FIELD_BYTES = 8 * 1024;

/** Sniffs the head of the stream, hashes and counts every byte, and passes it through unchanged. */
class SniffHash extends Transform {
	readonly hash = createHash('sha256');
	size = 0;
	kind: AudioKind | null = null;
	private head: Buffer[] = [];
	private head_size = 0;

	override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
		this.size += chunk.length;
		this.hash.update(chunk);
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
		this.kind = sniff_audio(head);
		if (this.kind === null) return new HttpError(415, 'unsupported media type: not a recognized audio file');
		this.push(head);
		return null;
	}
}

async function write_temp(file: Readable, incoming_dir: string, max_bytes: number): Promise<Omit<ReceivedUpload, 'fields'>> {
	const temp_path = path.join(incoming_dir, `${randomUUID()}.part`);
	const sniffer = new SniffHash();
	file.once('limit', () => { sniffer.destroy(new HttpError(413, 'file too large', { max_bytes })); });
	try {
		await pipeline(file, sniffer, createWriteStream(temp_path, { flags: 'wx' }));
		if (sniffer.size === 0) throw new HttpError(400, 'empty file');
	} catch (err) {
		await rm(temp_path, { force: true });
		throw err;
	}
	return { temp_path, sha256: sniffer.hash.digest('hex'), size: sniffer.size, kind: sniffer.kind! };
}

/**
 * Streams the `file` part of a multipart request to `incoming_dir` (sniffing, hashing, size-limited) and collects
 * the text fields. On any failure the temp file is removed and an HttpError is thrown.
 */
export async function receive_upload(req: Request, incoming_dir: string, max_bytes: number): Promise<ReceivedUpload> {
	await mkdir(incoming_dir, { recursive: true });
	let bb: busboy.Busboy;
	try {
		bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: max_bytes, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES } });
	} catch {
		throw new HttpError(400, 'expected multipart/form-data');
	}

	return new Promise<ReceivedUpload>((resolve, reject) => {
		const fields: Partial<Record<string, string>> = {};
		let file_task: Promise<Omit<ReceivedUpload, 'fields'>> | undefined;
		let file_stream: Readable | undefined;
		let settled = false;

		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			req.unpipe(bb);
			// Discard the rest of the body; the response closes the connection.
			req.resume();
			// An unfinished file pipeline would otherwise wait forever; destroying it makes write_temp clean up.
			file_stream?.destroy();
			if (file_task) {
				file_task.then(async r => rm(r.temp_path, { force: true }), () => undefined).catch(() => undefined);
			}
			reject(err instanceof HttpError ? err : new HttpError(400, 'malformed multipart body'));
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
			file_task = write_temp(stream, incoming_dir, max_bytes);
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
				if (settled) {
					rm(file.temp_path, { force: true }).catch(() => undefined);
					return;
				}
				settled = true;
				resolve({ ...file, fields });
			}, fail);
		});
		req.on('close', () => { if (!req.complete) fail(new HttpError(400, 'upload aborted')); });
		req.pipe(bb);
	});
}
