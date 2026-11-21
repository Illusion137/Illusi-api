import { Genius } from '@origin/genius/genius';
import { parse_ttml, type TtmlWord } from '@common/utils/ttml_util';
import type { LyricsFormat, LyricsLine, LyricsSegment, ParsedLyrics, SyncType } from './types';

/** Bump whenever any parser's output changes; stale `parsed_cache` rows are re-parsed. */
export const PARSER_VERSION = 2;

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

function ttml_segments(words: TtmlWord[], timed: boolean): { segments?: LyricsSegment[] } {
	return timed && words.length > 0 ? { segments: words.map(w => ({ text: w.text, start_ms: seconds_to_ms(w.begin), end_ms: seconds_to_ms(w.end) })) } : {};
}

export function parse_ttml_lyrics(raw: string, sync_type: SyncType): ParsedLyrics {
	const ttml = parse_ttml(raw);
	if (ttml) {
		const timed = sync_type === 'WORD' || sync_type === 'SYLLABLE';
		const synced = sync_type !== 'NONE';
		return {
			sync_type,
			songwriters: ttml.songwriters.length > 0 ? ttml.songwriters : undefined,
			lines: ttml.lines.map(line => ({
				text: line.text,
				start_ms: synced ? seconds_to_ms(line.begin) : null,
				end_ms: synced ? seconds_to_ms(line.end) : null,
				...ttml_segments(line.words, timed),
				...(line.agent ? { agent: line.agent } : {}),
				...(line.background
					? {
							background: {
								text: line.background.text,
								start_ms: synced ? seconds_to_ms(line.background.begin) : null,
								end_ms: synced ? seconds_to_ms(line.background.end) : null,
								...ttml_segments(line.background.words, timed)
							}
						}
					: {})
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

function unescape_xml(text: string): string {
	return text.replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, '\'').replace(/&amp;/gu, '&');
}

/** Whitespace-only segments (QRC times its spaces) belong to the previous word. */
function push_segment(segments: LyricsSegment[], segment: LyricsSegment) {
	if (segment.text.trim() === '' && segments.length > 0) segments[segments.length - 1].text += segment.text;
	else if (segment.text.length > 0) segments.push(segment);
}

/** Within this many lines of either end, QQ Music and KuGou put credits (`作词：…`, `Lyrics by：…`). */
const CREDIT_ZONE = 30;
const CREDIT_RE = /^[^：]{1,40}：/u;

/**
 * Drops the credit lines QQ Music and KuGou add around the lyrics, and their opening `Title - Artist` line.
 * Credits always use the full-width colon, which lyrics rarely do.
 */
function strip_credits(lines: LyricsLine[]): LyricsLine[] {
	const kept = lines.filter((line, i) => !((i < CREDIT_ZONE || i >= lines.length - CREDIT_ZONE) && CREDIT_RE.test(line.text)));
	if (kept.length > 1 && kept[0].start_ms !== null && kept[0].start_ms < 1000 && kept[0].text.includes(' - ')) kept.shift();
	return kept;
}

function word_lyrics(lines: LyricsLine[], what: string): ParsedLyrics {
	const kept = strip_credits(lines.filter(line => line.text.length > 0));
	if (kept.length === 0) fail(`${what} has no timed lines`);
	return { sync_type: kept.some(line => line.segments?.length) ? 'WORD' : 'LINE', lines: kept };
}

/**
 * QQ Music QRC, as decrypted: `<QrcInfos>` XML whose `LyricContent` holds lines like
 * `[lineStartMs,durationMs]word(startMs,durationMs)word(startMs,durationMs)`; word times are absolute.
 */
export function parse_qrc(raw: string): ParsedLyrics {
	const content = /LyricContent="([^"]*)"/u.exec(raw)?.[1];
	if (content === undefined) fail('QRC has no LyricContent');
	const lines: LyricsLine[] = [];
	for (const source of unescape_xml(content).replace(/\r\n?/gu, '\n').split('\n')) {
		const m = /^\s*\[(\d+),(\d+)\](.*)$/u.exec(source);
		if (!m) continue;
		const start_ms = Number(m[1]);
		const segments: LyricsSegment[] = [];
		for (const w of m[3].matchAll(/(.*?)\((\d+),(\d+)\)/gu)) {
			push_segment(segments, { text: w[1], start_ms: Number(w[2]), end_ms: Number(w[2]) + Number(w[3]) });
		}
		const text = (segments.length > 0 ? segments.map(seg => seg.text).join('') : m[3]).trim();
		lines.push({ text, start_ms, end_ms: start_ms + Number(m[2]), ...(segments.length > 0 ? { segments } : {}) });
	}
	return word_lyrics(lines, 'QRC');
}

/**
 * KuGou KRC, as decrypted: lines like `[lineStartMs,durationMs]<offsetMs,durationMs,0>word<…>word`; word offsets
 * are relative to the line. Tag lines (`[ti:…]`, `[language:…]`) are skipped.
 */
export function parse_krc(raw: string): ParsedLyrics {
	const lines: LyricsLine[] = [];
	for (const source of raw.replace(/\r\n?/gu, '\n').split('\n')) {
		const m = /^\s*\[(\d+),(\d+)\](.*)$/u.exec(source);
		if (!m) continue;
		const start_ms = Number(m[1]);
		const segments: LyricsSegment[] = [];
		for (const w of m[3].matchAll(/<(\d+),(\d+),\d+>([^<]*)/gu)) {
			const word_start = start_ms + Number(w[1]);
			push_segment(segments, { text: w[3], start_ms: word_start, end_ms: word_start + Number(w[2]) });
		}
		const text = (segments.length > 0 ? segments.map(seg => seg.text).join('') : m[3].replace(/<[^>]*>/gu, '')).trim();
		lines.push({ text, start_ms, end_ms: start_ms + Number(m[2]), ...(segments.length > 0 ? { segments } : {}) });
	}
	return word_lyrics(lines, 'KRC');
}

/** Unison lyrics stored with their attribution (`unison_version`): the inner TTML, LRC or plain text. */
export function parse_unison_json(raw: string, sync_type: SyncType): ParsedLyrics {
	const data = JSON.parse(raw) as { format?: unknown; lyrics?: unknown };
	if (typeof data.lyrics !== 'string') fail('Unison row has no lyrics');
	switch (data.format) {
		case 'ttml': return parse_ttml_lyrics(data.lyrics, sync_type);
		case 'lrc': return parse_lrc(data.lyrics, sync_type);
		case 'plain': return parse_plain(data.lyrics);
		default: fail(`unknown Unison format ${String(data.format)}`);
	}
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
		case 'QRC': return parse_qrc(raw);
		case 'KRC': return parse_krc(raw);
		case 'UNISON_JSON': return parse_unison_json(raw, sync_type);
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
