export type AudioExt = 'mp3' | 'aac' | 'm4a' | 'flac' | 'ogg' | 'opus' | 'wav' | 'webm';

export interface AudioKind { ext: AudioExt; mime: string }

/** How many leading bytes `sniff_audio` wants to see (fewer is fine for short files). */
export const SNIFF_BYTES = 64;

export const MIME_BY_EXT: Record<AudioExt, string> = {
	mp3: 'audio/mpeg',
	aac: 'audio/aac',
	m4a: 'audio/mp4',
	flac: 'audio/flac',
	ogg: 'audio/ogg',
	opus: 'audio/ogg',
	wav: 'audio/wav',
	webm: 'audio/webm'
};

/** ISO-BMFF major/compatible brands we accept as audio containers. */
const MP4_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'mp41', 'mp42', 'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'dash', 'MSNV', 'f4a ']);

function ascii(buf: Buffer, start: number, length: number): string {
	return buf.length < start + length ? '' : buf.toString('latin1', start, start + length);
}

function kind(ext: AudioExt): AudioKind {
	return { ext, mime: MIME_BY_EXT[ext] };
}

/** MPEG audio frame header (layer I-III): sync, valid version/layer, bitrate and sample-rate indexes. */
function is_mpeg_frame(buf: Buffer, i = 0): boolean {
	if (buf.length < i + 3 || buf[i] !== 0xFF || (buf[i + 1] & 0xE0) !== 0xE0) return false;
	const version = (buf[i + 1] >> 3) & 0x03;
	const layer = (buf[i + 1] >> 1) & 0x03;
	const bitrate = buf[i + 2] >> 4;
	const sample_rate = (buf[i + 2] >> 2) & 0x03;
	return version !== 1 && layer !== 0 && bitrate !== 0x0F && sample_rate !== 0x03;
}

/** ADTS (raw AAC) header: 12-bit sync, layer 00, valid sampling index. */
function is_adts(buf: Buffer): boolean {
	if (buf.length < 3 || buf[0] !== 0xFF || (buf[1] & 0xF6) !== 0xF0) return false;
	return ((buf[2] >> 2) & 0x0F) < 13;
}

/**
 * Identifies an audio container from its leading bytes; never trusts the client's Content-Type.
 * Returns null for anything that isn't one of the accepted audio formats.
 */
export function sniff_audio(buf: Buffer): AudioKind | null {
	if (ascii(buf, 0, 3) === 'ID3') return kind('mp3');
	if (ascii(buf, 0, 4) === 'fLaC') return kind('flac');
	if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WAVE') return kind('wav');
	if (ascii(buf, 0, 4) === 'OggS') {
		// The first page's packet starts after the 27-byte header and the segment table.
		const segments = buf.length > 26 ? buf[26] : 0;
		const packet = 27 + segments;
		if (ascii(buf, packet, 8) === 'OpusHead') return kind('opus');
		if (ascii(buf, packet, 7) === '\x01vorbis' || ascii(buf, packet, 5) === '\x7FFLAC') return kind('ogg');
		return null;
	}
	if (ascii(buf, 4, 4) === 'ftyp') {
		const box_size = buf.readUInt32BE(0);
		if (MP4_BRANDS.has(ascii(buf, 8, 4))) return kind('m4a');
		for (let i = 16; i + 4 <= Math.min(box_size, buf.length); i += 4) if (MP4_BRANDS.has(ascii(buf, i, 4))) return kind('m4a');
		return null;
	}
	if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1A45DFA3) {
		// EBML: accept only the `webm` doctype (Matroska video is rejected).
		return buf.subarray(0, Math.min(buf.length, SNIFF_BYTES)).includes('webm', 0, 'latin1') ? kind('webm') : null;
	}
	if (is_adts(buf)) return kind('aac');
	if (is_mpeg_frame(buf)) return kind('mp3');
	return null;
}
