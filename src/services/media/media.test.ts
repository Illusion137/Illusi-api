import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { parse_range } from './range';
import { is_valid_resource_id, resource_ext, resource_path } from './resource_id';
import { sniff_audio } from './sniff';
import { token_target } from './store';

function pad(head: number[] | Buffer, length = 64): Buffer {
	const buf = Buffer.alloc(Math.max(length, head.length));
	Buffer.from(head).copy(buf);
	return buf;
}

function ogg(packet: string): Buffer {
	const header = Buffer.alloc(28);
	header.write('OggS', 0, 'latin1');
	header[26] = 1; // one segment
	header[27] = 19;
	return pad(Buffer.concat([header, Buffer.from(packet, 'latin1')]));
}

function ftyp(major: string, compatible: string[] = []): Buffer {
	const size = 16 + compatible.length * 4;
	const buf = Buffer.alloc(size);
	buf.writeUInt32BE(size, 0);
	buf.write('ftyp', 4, 'latin1');
	buf.write(major, 8, 'latin1');
	compatible.forEach((brand, i) => buf.write(brand, 16 + i * 4, 'latin1'));
	return pad(buf);
}

describe('sniff_audio', () => {
	it('detects mp3 by ID3 tag and by frame sync', () => {
		expect(sniff_audio(pad(Buffer.from('ID3\x04\x00', 'latin1')))?.ext).toBe('mp3');
		expect(sniff_audio(pad([0xFF, 0xFB, 0x90, 0x64]))?.ext).toBe('mp3');
	});
	it('rejects invalid mpeg frame headers', () => {
		expect(sniff_audio(pad([0xFF, 0xFB, 0xF0, 0x64]))).toBeNull(); // bad bitrate index
		expect(sniff_audio(pad([0xFF, 0xEB, 0x90, 0x64]))).toBeNull(); // reserved version
	});
	it('detects ADTS aac', () => {
		expect(sniff_audio(pad([0xFF, 0xF1, 0x50, 0x80]))).toEqual({ ext: 'aac', mime: 'audio/aac' });
	});
	it('detects m4a by ftyp brand', () => {
		expect(sniff_audio(ftyp('M4A '))?.ext).toBe('m4a');
		expect(sniff_audio(ftyp('XXXX', ['isom']))?.ext).toBe('m4a');
		expect(sniff_audio(ftyp('qt  '))).toBeNull();
	});
	it('detects flac and wav', () => {
		expect(sniff_audio(pad(Buffer.from('fLaC', 'latin1')))?.ext).toBe('flac');
		const wav = pad(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'));
		expect(sniff_audio(wav)).toEqual({ ext: 'wav', mime: 'audio/wav' });
		expect(sniff_audio(pad(Buffer.from('RIFF\x24\x00\x00\x00AVI ', 'latin1')))).toBeNull();
	});
	it('distinguishes opus and vorbis in ogg and rejects other ogg streams', () => {
		expect(sniff_audio(ogg('OpusHead'))?.ext).toBe('opus');
		expect(sniff_audio(ogg('\x01vorbis'))?.ext).toBe('ogg');
		expect(sniff_audio(ogg('\x80theora'))).toBeNull();
	});
	it('accepts webm but not other matroska', () => {
		const ebml = (doctype: string) => pad(Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x82, 0x84]), Buffer.from(doctype, 'latin1')]));
		expect(sniff_audio(ebml('webm'))?.ext).toBe('webm');
		expect(sniff_audio(ebml('matroska'))).toBeNull();
	});
	it('rejects non-audio files and short garbage', () => {
		expect(sniff_audio(pad(Buffer.from('%PDF-1.7', 'latin1')))).toBeNull();
		expect(sniff_audio(pad([0x89, 0x50, 0x4E, 0x47]))).toBeNull();
		expect(sniff_audio(Buffer.from([0xFF]))).toBeNull();
		expect(sniff_audio(Buffer.alloc(0))).toBeNull();
	});
});

describe('parse_range', () => {
	it('serves the full body without a usable header', () => {
		expect(parse_range(undefined, 100)).toEqual({ type: 'full' });
		expect(parse_range('bytes=-', 100)).toEqual({ type: 'full' });
		expect(parse_range('items=0-5', 100)).toEqual({ type: 'full' });
		expect(parse_range('bytes=0-5,10-20', 100)).toEqual({ type: 'full' });
		expect(parse_range('bytes=9-3', 100)).toEqual({ type: 'full' });
	});
	it('parses closed, open and suffix ranges', () => {
		expect(parse_range('bytes=0-9', 100)).toEqual({ type: 'partial', start: 0, end: 9 });
		expect(parse_range('bytes=90-', 100)).toEqual({ type: 'partial', start: 90, end: 99 });
		expect(parse_range('bytes=-10', 100)).toEqual({ type: 'partial', start: 90, end: 99 });
		expect(parse_range('bytes=-500', 100)).toEqual({ type: 'partial', start: 0, end: 99 });
		expect(parse_range('bytes=50-500', 100)).toEqual({ type: 'partial', start: 50, end: 99 });
	});
	it('flags unsatisfiable ranges', () => {
		expect(parse_range('bytes=100-', 100)).toEqual({ type: 'unsatisfiable' });
		expect(parse_range('bytes=100-200', 100)).toEqual({ type: 'unsatisfiable' });
		expect(parse_range('bytes=-0', 100)).toEqual({ type: 'unsatisfiable' });
		expect(parse_range('bytes=0-', 0)).toEqual({ type: 'unsatisfiable' });
	});
});

describe('resource ids', () => {
	const id = '0b7c9a3e-5f1d-4c2a-9e8b-123456789abc';
	it('accepts <uuid>.<audio ext> only', () => {
		expect(resource_ext(`${id}.mp3`)).toBe('mp3');
		expect(is_valid_resource_id(`${id}.opus`)).toBe(true);
		expect(is_valid_resource_id(`${id}.exe`)).toBe(false);
		expect(is_valid_resource_id(`${id.toUpperCase()}.mp3`)).toBe(false);
		expect(is_valid_resource_id(id)).toBe(false);
	});
	it('rejects traversal attempts', () => {
		for (const bad of [`../${id}.mp3`, `..%2F${id}.mp3`, `.incoming/${id}.mp3`, `${id}.mp3/..`, `/etc/passwd`, `${id}.mp3\0`]) {
			expect(is_valid_resource_id(bad)).toBe(false);
			expect(resource_path('/srv/media', bad)).toBeNull();
		}
		expect(resource_path('/srv/media', `${id}.flac`)).toBe(`/srv/media/${id}.flac`);
	});
});

describe('token_target', () => {
	it('uses the requested id only when the token was issued for it', async () => {
		const token = await new SignJWT({ tgt: 'old' }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('k'.repeat(32)));
		expect(token_target(token, 'old', 'new')).toBe('old');
		expect(token_target(token, 'other', 'new')).toBe('new');
		expect(token_target('garbage', 'old', 'new')).toBe('new');
	});
});
