import { createHash, createHmac } from 'node:crypto';
import { config } from '../../config';
import { logger } from '../../core/log';

const log = logger('media');

/**
 * Public URL of a file in the media bucket, keyed by its path under MEDIA_DIR (`<uuid>.m4a`, `artwork/<uuid>.jpg`),
 * or null when there is no bucket. scripts/backup-media.sh moves files there, so a file missing locally is served from it.
 */
export function remote_media_url(key: string): string | null {
	return config.MEDIA_PUBLIC_URL ? `${config.MEDIA_PUBLIC_URL}/${key}` : null;
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

interface SignInput {
	method: string;
	url: URL;
	region: string;
	access_key: string;
	secret_key: string;
	now: Date;
	/** Extra headers to sign. */
	headers?: Record<string, string>;
}

/** AWS Signature V4 headers for an S3 request without a body or query string. */
export function sign_s3_request(input: SignInput): Record<string, string> {
	const amz_date = input.now.toISOString().replace(/[-:]|\.\d{3}/gu, '');
	const day = amz_date.slice(0, 8);
	const payload_hash = sha256('');
	const headers: Record<string, string> = { 'host': input.url.host, 'x-amz-content-sha256': payload_hash, 'x-amz-date': amz_date };
	for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value.trim();
	const names = Object.keys(headers).sort();
	const signed_headers = names.join(';');
	const canonical = [input.method, input.url.pathname, '', names.map(n => `${n}:${headers[n]}\n`).join(''), signed_headers, payload_hash].join('\n');
	const scope = `${day}/${input.region}/s3/aws4_request`;
	const string_to_sign = ['AWS4-HMAC-SHA256', amz_date, scope, sha256(canonical)].join('\n');
	const key = ['s3', 'aws4_request'].reduce(hmac, hmac(hmac(`AWS4${input.secret_key}`, day), input.region));
	const signature = createHmac('sha256', key).update(string_to_sign).digest('hex');
	headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.access_key}/${scope}, SignedHeaders=${signed_headers}, Signature=${signature}`;
	return headers;
}

/**
 * Deletes files (paths under MEDIA_DIR) from the media bucket so their public URLs stop working. A file that isn't
 * there is fine. Does nothing without MEDIA_S3_ENDPOINT; failures are logged, never thrown.
 */
export async function delete_remote_media(keys: readonly string[]): Promise<void> {
	if (!config.MEDIA_S3_ENDPOINT) return;
	for (const key of keys) {
		const url = new URL(`${config.MEDIA_S3_ENDPOINT}/${config.MEDIA_S3_BUCKET}/${key}`);
		const { host: _host, ...headers } = sign_s3_request({
			method: 'DELETE',
			url,
			region: config.MEDIA_S3_REGION,
			access_key: config.MEDIA_S3_ACCESS_KEY,
			secret_key: config.MEDIA_S3_SECRET_KEY,
			now: new Date()
		});
		try {
			const res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(15_000) });
			await res.body?.cancel();
			if (!res.ok && res.status !== 404) log.error('could not delete media from the bucket', { key, status: res.status });
		} catch (err) {
			log.error('could not delete media from the bucket', { key, err });
		}
	}
}
