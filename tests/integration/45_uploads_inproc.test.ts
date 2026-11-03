import { crc32, deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { start_inproc_app } from './inproc_app';

const app = await start_inproc_app();
process.env.API_URL = app.url;
afterAll(async () => { await app.stop(); });
const { api, contribute, create_user, mock_album, unique, uuid, wav_bytes } = await import('./helpers');

function png(size: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 2;
	const noise = Buffer.alloc(size * (size * 3 + 1));
	for (let i = 0; i < noise.length; i++) noise[i] = i % (size * 3 + 1) === 0 ? 0 : (i * 31 + (i >> 5)) & 0xff;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', header), chunk('IDAT', deflateSync(noise, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

const form_of = (parts: [string, string | Blob, string?][]) => {
	const form = new FormData();
	for (const [name, value, filename] of parts) {
		if (filename === undefined) form.append(name, value as string);
		else form.append(name, value, filename);
	}
	return form;
};
const blob = (bytes: Buffer, type: string) => new Blob([new Uint8Array(bytes)], { type });

describe('media upload streaming (in-process)', () => {
	it('handles multi-chunk files, ignored leading parts, late field errors and concurrent identical uploads', async () => {
		const user = await create_user('upload-stream');
		const created = await contribute(user, mock_album({ artist: unique('Up Artist'), album: unique('Up Album'), n: 1, imported: true }));
		const track_id = created.body.refs.t0 as string;
		const upload = (parts: [string, string | Blob, string?][]) => api('POST', `/tracks/${track_id}/media`, { token: user.access_token, raw: form_of(parts) });
		const big = blob(wav_bytes(11, 300_000), 'audio/wav');

		expect((await upload([['other', blob(wav_bytes(1), 'audio/wav'), 'x.wav'], ['file', big, 'a.wav']])).status).toBe(400);
		expect((await upload([['file', big, 'a.wav'], ['note', 'x'.repeat(2_000_000)]])).status).toBe(413);
		const same = blob(wav_bytes(12, 300_000), 'audio/wav');
		const results = await Promise.all([upload([['file', same, 'a.wav']]), upload([['file', same, 'a.wav']])]);
		expect(results.map(r => r.status).sort()).toEqual([200, 201]);
	});
});

describe('artwork upload streaming (in-process)', () => {
	it('handles multi-chunk images, ignored leading parts and late field errors', async () => {
		const user = await create_user('art-stream');
		const playlist_id = uuid();
		await api('POST', '/sync/push', { token: user.access_token, body: { push_id: uuid(), changes: { playlists: [{ id: playlist_id, title: 'Art', edited_at: new Date(Date.now() - 1_000).toISOString() }] } } });
		const put = (parts: [string, string | Blob, string?][]) => api('PUT', `/playlists/${playlist_id}/artwork`, { token: user.access_token, raw: form_of(parts) });
		const image = blob(png(700), 'image/png');

		expect((await put([['other', blob(png(8), 'image/png'), 'x.png'], ['file', image, 'cover.png']])).status).toBe(400);
		expect((await put([['file', image, 'cover.png'], ['note', 'x'.repeat(5_000)]])).status).toBe(413);
		expect((await put([['file', image, 'cover.png']])).status).toBe(200);
	});
});
