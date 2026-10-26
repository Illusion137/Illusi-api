import { Genius } from '@origin/genius/genius';
import { parse_ttml } from '@common/utils/ttml_util';
import type { LyricsFormat, LyricsLine, LyricsSegment, ParsedLyrics, SyncType } from './types';

/** Bump whenever any parser's output changes; stale `parsed_cache` rows are re-parsed. */
export const PARSER_VERSION = 1;

export class LyricsParseError extends Error {}

const seconds_to_ms = (s: number) => Math.round(s * 1000);

function fail(message: string): never {
	throw new LyricsParseError(message);
}

function plain_lines(text: string): LyricsLine[] {
	const lines = text.replace(/\r\n?/gu, '\n').split('\n').map(l => l.trimEnd());
	while (lines.length > 0 && lines[0].trim() === '') lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
	return lines.map(text => ({ text, start_ms: null, end_ms: null }));
}

/** Fills each line's missing `end_ms` with the next line's start. */
function close_line_ends(lines: LyricsLine[]): LyricsLine[] {
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].end_ms == null && lines[i + 1]?.start_ms != null) lines[i].end_ms = lines[i + 1].start_ms;
	}
	return lines;
}

function strip_xml(text: string): string {
	return text.replace(/<[^>]+>/gu, '')
		.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, '\'').replace(/&amp;/gu, '&')
		.trim();
}

export function parse_ttml_lyrics(raw: string, sync_type: SyncType): ParsedLyrics {
	const ttml = parse_ttml(raw);
	if (ttml) {
		const timed = sync_type === 'WORD' || sync_type === 'SYLLABLE';
		return {
			sync_type,
			songwriters: ttml.songwriters.length > 0 ? ttml.songwriters : undefined,
			lines: ttml.lines.map(line => ({
				text: line.text,
				start_ms: sync_type === 'NONE' ? null : seconds_to_ms(line.begin),
				end_ms: sync_type === 'NONE' ? null : seconds_to_ms(line.end),
				...(timed && line.words.length > 0 ? { segments: line.words.map(w => ({ text: w.text, start_ms: seconds_to_ms(w.begin), end_ms: seconds_to_ms(w.end) })) } : {}),
				...(line.agent ? { agent: line.agent } : {})
			}))
		};
	}
	// Unsynced TTML (`timing="None"`) has `<p>` without `begin`, which parse_ttml skips.
	const lines = [...raw.matchAll(/<p(?:\s[^>]*)?>(.*?)<\/p>/gsu)].map(m => strip_xml(m[1].replace(/<br\s*\/?>/gu, '\n')));
	if (lines.length === 0) fail('TTML has no <p> lines');
	return { sync_type: 'NONE', lines: lines.map(text => ({ text, start_ms: null, end_ms: null })) };
}

const ELRC_WORD_RE = /<(\d+):(\d{1,2}(?:[.:]\d+)?)>/gu;

function lrc_time_ms(minutes: string, seconds: string): number {
	return Math.round((Number(minutes) * 60 + Number(seconds.replace(':', '.'))) * 1000);
}

/** LRC and enhanced LRC (`<mm:ss.xx>` word stamps). Lines without a timestamp (metadata tags) are dropped. */
export function parse_lrc(raw: string, sync_type: SyncType): ParsedLyrics {
	let offset_ms = 0;
	const lines: LyricsLine[] = [];
	for (const source of raw.replace(/\r\n?/gu, '\n').split('\n')) {
		const offset = /^\s*\[offset:\s*([+-]?\d+)\s*\]/iu.exec(source);
		if (offset) {
			offset_ms = Number(offset[1]);
			continue;
		}
		const stamps: number[] = [];
		let rest = source.trimStart();
		for (;;) {
			const m = /^\[(\d+):(\d{1,2}(?:[.:]\d+)?)\]/u.exec(rest);
			if (!m) break;
			stamps.push(lrc_time_ms(m[1], m[2]));
			rest = rest.slice(m[0].length);
		}
		if (stamps.length === 0) continue;
		const segments: LyricsSegment[] = [];
		const words = [...rest.matchAll(ELRC_WORD_RE)];
		if (words.length > 0) {
			for (let i = 0; i < words.length; i++) {
				const start = words[i].index + words[i][0].length;
				const end = i + 1 < words.length ? words[i + 1].index : rest.length;
				const text = rest.slice(start, end);
				if (text.length === 0 && i + 1 === words.length) {
					// A trailing stamp closes the previous word.
					if (segments.length > 0) segments[segments.length - 1].end_ms = lrc_time_ms(words[i][1], words[i][2]);
					continue;
				}
				segments.push({ text, start_ms: lrc_time_ms(words[i][1], words[i][2]), end_ms: null });
			}
			for (let i = 0; i < segments.length - 1; i++) segments[i].end_ms ??= segments[i + 1].start_ms;
		}
		const text = (words.length > 0 ? rest.replace(ELRC_WORD_RE, '') : rest).trim();
		for (const stamp of stamps) {
			lines.push({
				text,
				start_ms: stamp,
				end_ms: null,
				...(segments.length > 0 ? { segments: segments.map(s => ({ ...s, start_ms: s.start_ms + stamp - stamps[0], end_ms: s.end_ms == null ? null : s.end_ms + stamp - stamps[0] })) } : {})
			});
		}
	}
	if (lines.length === 0) fail('LRC has no timed lines');
	lines.sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
	if (offset_ms !== 0) {
		// LRC `offset`: positive values make lyrics appear sooner.
		for (const line of lines) {
			line.start_ms = Math.max(0, (line.start_ms ?? 0) - offset_ms);
			for (const s of line.segments ?? []) {
				s.start_ms = Math.max(0, s.start_ms - offset_ms);
				if (s.end_ms != null) s.end_ms = Math.max(0, s.end_ms - offset_ms);
			}
		}
	}
	for (const line of lines) {
		const last = line.segments?.at(-1);
		if (last?.end_ms != null) line.end_ms = last.end_ms;
	}
	return { sync_type, lines: close_line_ends(lines) };
}

interface RichsyncLine { ts: number; te: number; x?: string; l: { c: string; o: number }[] }

function is_richsync(value: unknown): value is RichsyncLine[] {
	return Array.isArray(value) && value.every(l => typeof l === 'object' && l !== null
		&& typeof (l as RichsyncLine).ts === 'number' && typeof (l as RichsyncLine).te === 'number' && Array.isArray((l as RichsyncLine).l));
}

/** Musixmatch richsync body: `[{ ts, te, x, l: [{ c, o }] }]`, seconds; `o` is relative to `ts`. */
export function parse_richsync(raw: string): ParsedLyrics {
	const data = JSON.parse(raw) as unknown;
	if (!is_richsync(data) || data.length === 0) fail('not a richsync body');
	const lines = data.map((line): LyricsLine => {
		const segments: LyricsSegment[] = [];
		for (const part of line.l) {
			if (typeof part.c !== 'string' || typeof part.o !== 'number') continue;
			// Whitespace entries belong to the previous word.
			if (part.c.trim() === '' && segments.length > 0) {
				segments[segments.length - 1].text += part.c;
				continue;
			}
			segments.push({ text: part.c, start_ms: seconds_to_ms(line.ts + part.o), end_ms: null });
		}
		for (let i = 0; i < segments.length; i++) segments[i].end_ms = segments[i + 1]?.start_ms ?? seconds_to_ms(line.te);
		return {
			text: (line.x ?? segments.map(s => s.text).join('')).trim(),
			start_ms: seconds_to_ms(line.ts),
			end_ms: seconds_to_ms(line.te),
			segments
		};
	});
	return { sync_type: 'WORD', lines };
}

export function parse_plain(raw: string): ParsedLyrics {
	const lines = plain_lines(raw);
	if (lines.length === 0) fail('empty lyrics');
	return { sync_type: 'NONE', lines };
}

export function parse_genius_body(raw: string): ParsedLyrics {
	const text = Genius.parse_lyrics_body(raw);
	if (typeof text !== 'string') fail(`genius body: ${text.error.message.split('\n')[0]}`);
	return parse_plain(text);
}

interface YtmTimedLine { lyricLine?: unknown; cueRange?: { startTimeMilliseconds?: unknown; endTimeMilliseconds?: unknown } }

function as_ms(value: unknown): number | null {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Finds YouTube Music timed lines (`[{ lyricLine, cueRange: { startTimeMilliseconds, ... } }]`) anywhere in the payload. */
export function find_ytm_timed_lines(value: unknown, depth = 0): YtmTimedLine[] | null {
	if (depth > 8 || typeof value !== 'object' || value === null) return null;
	if (Array.isArray(value)) {
		if (value.length > 0 && value.every(v => typeof v === 'object' && v !== null && 'cueRange' in v)) return value as YtmTimedLine[];
		for (const v of value) {
			const found = find_ytm_timed_lines(v, depth + 1);
			if (found) return found;
		}
		return null;
	}
	for (const v of Object.values(value)) {
		const found = find_ytm_timed_lines(v, depth + 1);
		if (found) return found;
	}
	return null;
}

/** Plain lyrics text in a YouTube Music payload: a string, or `lyrics` / `description` / `text` (possibly as `runs`). */
export function find_ytm_plain_text(value: unknown, depth = 0): string | null {
	if (typeof value === 'string') return value.trim() ? value : null;
	if (depth > 8 || typeof value !== 'object' || value === null) return null;
	if (Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;
	if (Array.isArray(obj.runs)) {
		const text = (obj.runs as { text?: unknown }[]).map(r => (typeof r.text === 'string' ? r.text : '')).join('');
		return text.trim() ? text : null;
	}
	for (const key of ['lyrics', 'description', 'text', 'content']) {
		if (key in obj) {
			const found = find_ytm_plain_text(obj[key], depth + 1);
			if (found) return found;
		}
	}
	return null;
}

export function parse_ytm_json(raw: string): ParsedLyrics {
	const data = JSON.parse(raw) as unknown;
	const timed = find_ytm_timed_lines(data);
	if (timed) {
		const lines = timed.map((l): LyricsLine => ({
			text: typeof l.lyricLine === 'string' ? l.lyricLine : '',
			start_ms: as_ms(l.cueRange?.startTimeMilliseconds) ?? fail('timed line without start'),
			end_ms: as_ms(l.cueRange?.endTimeMilliseconds)
		}));
		return { sync_type: 'LINE', lines: close_line_ends(lines) };
	}
	const text = find_ytm_plain_text(data);
	if (text == null) fail('no lyrics in YouTube Music payload');
	return parse_plain(text);
}

/** Parses one stored row. Throws on failure; the caller logs it and falls back. */
export function parse_lyrics(format: LyricsFormat, sync_type: SyncType, raw: string): ParsedLyrics {
	switch (format) {
		case 'TTML': return parse_ttml_lyrics(raw, sync_type);
		case 'LRC':
		case 'ELRC': return parse_lrc(raw, sync_type);
		case 'MXM_RICHSYNC_JSON': return parse_richsync(raw);
		case 'PLAIN': return parse_plain(raw);
		case 'GENIUS_BODY_JSON': return parse_genius_body(raw);
		case 'YTM_JSON': return parse_ytm_json(raw);
	}
}

export function try_parse_lyrics(format: LyricsFormat, sync_type: SyncType, raw: string): { ok: true; parsed: ParsedLyrics } | { ok: false; error: string } {
	try {
		const parsed = parse_lyrics(format, sync_type, raw);
		if (parsed.lines.length === 0) return { ok: false, error: 'no lines' };
		return { ok: true, parsed };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
