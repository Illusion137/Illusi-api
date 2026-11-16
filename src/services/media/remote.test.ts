import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config';
import { delete_remote_media, remote_media_url, sign_s3_request } from './remote';

const saved = { ...config };
afterEach(() => {
	Object.assign(config, saved);
	vi.unstubAllGlobals();
});

describe('sign_s3_request', () => {
	it('matches the GET Object example of the AWS Signature V4 documentation', () => {
		const headers = sign_s3_request({
			method: 'GET',
			url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
			region: 'us-east-1',
			access_key: 'AKIAIOSFODNN7EXAMPLE',
			secret_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
			now: new Date('2013-05-24T00:00:00Z'),
			headers: { Range: 'bytes=0-9' }
		});
		expect(headers['x-amz-date']).toBe('20130524T000000Z');
		expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
			+ 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
	});
});

describe('remote_media_url', () => {
	it('is null without a bucket and the public URL of the path otherwise', () => {
		config.MEDIA_PUBLIC_URL = '';
		expect(remote_media_url('a.m4a')).toBeNull();
		config.MEDIA_PUBLIC_URL = 'https://eu2.contabostorage.com/abc:illusi-media';
		expect(remote_media_url('artwork/b.jpg')).toBe('https://eu2.contabostorage.com/abc:illusi-media/artwork/b.jpg');
	});
});

describe('delete_remote_media', () => {
	const fetch_mock = (status: number) => {
		const mock = vi.fn(async (_url: URL, _init: RequestInit) => new Response(null, { status }));
		vi.stubGlobal('fetch', mock);
		return mock;
	};
	const bucket = () => Object.assign(config, {
		MEDIA_S3_ENDPOINT: 'https://eu2.contabostorage.com',
		MEDIA_S3_BUCKET: 'illusi-media',
		MEDIA_S3_ACCESS_KEY: 'key',
		MEDIA_S3_SECRET_KEY: 'secret'
	});

	it('does nothing without an endpoint', async () => {
		config.MEDIA_S3_ENDPOINT = '';
		const mock = fetch_mock(204);
		await delete_remote_media(['a.m4a']);
		expect(mock).not.toHaveBeenCalled();
	});

	it('sends a signed path-style DELETE per file and accepts a file that is already gone', async () => {
		bucket();
		const mock = fetch_mock(404);
		await delete_remote_media(['a.m4a', 'artwork/b.jpg']);
		expect(mock.mock.calls.map(([url, init]) => [String(url), init.method])).toEqual([
			['https://eu2.contabostorage.com/illusi-media/a.m4a', 'DELETE'],
			['https://eu2.contabostorage.com/illusi-media/artwork/b.jpg', 'DELETE']
		]);
		const headers = mock.mock.calls[0][1].headers as Record<string, string>;
		expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, /u);
		expect(headers).not.toHaveProperty('host');
	});

	it('never throws when the bucket refuses or is unreachable', async () => {
		bucket();
		fetch_mock(403);
		await expect(delete_remote_media(['a.m4a'])).resolves.toBeUndefined();
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
		await expect(delete_remote_media(['a.m4a'])).resolves.toBeUndefined();
	});
});
