import type { LyricsVersion, SyncType } from './types';

/**
 * Format / sync-type detection per service. Works on the raw text only, never on a parse
 * result, so storing doesn't depend on parsing.
 */

const TIMING_TO_SYNC: Record<string, SyncType> = { syllable: 'SYLLABLE', word: 'WORD', line: 'LINE', none: 'NONE' };

/** TTML sync type: a service hint (Bini `timing_type`) wins, then the `*:timing` attribute, then the structure. */
export function detect_ttml_sync(ttml: string, hint?: string | null): SyncType {
	const from_hint = hint ? TIMING_TO_SYNC[hint.toLowerCase()] : undefined;
	if (from_hint) return from_hint;
	const attribute = /\w+:timing=["'](\w+)["']/u.exec(ttml)?.[1]?.toLowerCase();
	const from_attribute = attribute ? TIMING_TO_SYNC[attribute] : undefined;
	if (from_attribute) return from_attribute;
	if (/<span\s[^>]*\bbegin=/u.test(ttml)) return 'WORD';
	if (/<p\s[^>]*\bbegin=/u.test(ttml)) return 'LINE';
	return 'NONE';
}

export function ttml_version(ttml: string, hint?: string | null): LyricsVersion {
	return { format: 'TTML', sync_type: detect_ttml_sync(ttml, hint), raw_content: ttml };
}

const LRC_LINE_RE = /^\s*\[\d+:\d{1,2}(?:[.:]\d+)?\]/mu;
const ELRC_WORD_RE = /<\d+:\d{1,2}(?:[.:]\d+)?>/u;

export function is_lrc(text: string): boolean {
	return LRC_LINE_RE.test(text);
}

/** LRCLib `syncedLyrics`: enhanced LRC (inline `<mm:ss.xx>` word stamps) → `ELRC`/`WORD`, otherwise `LRC`/`LINE`. */
export function lrc_version(text: string): LyricsVersion {
	return ELRC_WORD_RE.test(text)
		? { format: 'ELRC', sync_type: 'WORD', raw_content: text }
		: { format: 'LRC', sync_type: 'LINE', raw_content: text };
}

const non_empty = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim().length > 0;

export interface LrclibResultLike {
	instrumental?: boolean;
	plainLyrics?: string | null;
	syncedLyrics?: string | null;
}

export function lrclib_versions(result: LrclibResultLike): LyricsVersion[] {
	const out: LyricsVersion[] = [];
	if (non_empty(result.syncedLyrics)) out.push(lrc_version(result.syncedLyrics));
	if (non_empty(result.plainLyrics)) out.push({ format: 'PLAIN', sync_type: 'NONE', raw_content: result.plainLyrics });
	return out;
}

/** QQ Music lyrics as lib-origin returns them: decrypted QRC (word-synced) or plain LRC. */
export function qqmusic_version(lyrics: { format: 'QRC' | 'LRC'; text: string }): LyricsVersion | null {
	if (!non_empty(lyrics.text)) return null;
	if (lyrics.format === 'QRC') return { format: 'QRC', sync_type: 'WORD', raw_content: lyrics.text };
	return is_lrc(lyrics.text) ? lrc_version(lyrics.text) : null;
}

/** KuGou lyrics as lib-origin returns them: decrypted KRC (word-synced), LRC or plain text. */
export function kugou_version(lyrics: { format: 'KRC' | 'LRC' | 'PLAIN'; text: string }): LyricsVersion | null {
	if (!non_empty(lyrics.text)) return null;
	if (lyrics.format === 'KRC') return { format: 'KRC', sync_type: 'WORD', raw_content: lyrics.text };
	if (lyrics.format === 'LRC') return is_lrc(lyrics.text) ? lrc_version(lyrics.text) : null;
	return { format: 'PLAIN', sync_type: 'NONE', raw_content: lyrics.text };
}

export interface UnisonLyricsLike {
	id: number;
	videoId: string;
	lyrics: string;
	format: string;
	syncType: string;
	submitter?: { keyId: string; displayName?: string } | null;
}

/**
 * Unison lyrics, stored with what its terms require showing: the song page (`videoId`) and the submitter.
 * Votes and scores are left out, so a recheck of the same lyrics stores nothing new.
 */
export function unison_version(data: UnisonLyricsLike): LyricsVersion | null {
	if (!non_empty(data.lyrics) || !['ttml', 'lrc', 'plain'].includes(data.format)) return null;
	let sync_type: SyncType = 'NONE';
	if (data.format === 'ttml') sync_type = detect_ttml_sync(data.lyrics);
	else if (data.format === 'lrc') sync_type = lrc_version(data.lyrics).sync_type;
	const submitter = data.submitter ? { keyId: data.submitter.keyId, displayName: data.submitter.displayName ?? null } : null;
	const raw = { id: data.id, videoId: data.videoId, format: data.format, syncType: data.syncType, submitter, lyrics: data.lyrics };
	return { format: 'UNISON_JSON', sync_type, raw_content: JSON.stringify(raw) };
}

/** Genius `songPage.lyricsData.body`, stored as its JSON text. */
export function genius_version(body: unknown): LyricsVersion | null {
	if (body == null) return null;
	return { format: 'GENIUS_BODY_JSON', sync_type: 'NONE', raw_content: JSON.stringify(body) };
}

function has_ytm_timing(value: unknown, depth = 0): boolean {
	if (depth > 8 || typeof value !== 'object' || value === null) return false;
	if (!Array.isArray(value) && 'cueRange' in value) return true;
	return Object.values(value).some(v => has_ytm_timing(v, depth + 1));
}

/**
 * YouTube Music payload as the client received it: a string is `PLAIN` (`LINE` LRC if it is
 * timed LRC text), anything else is `YTM_JSON` with `LINE` when it carries cue ranges.
 */
export function ytm_version(lyrics: unknown): LyricsVersion | null {
	if (typeof lyrics === 'string') {
		if (!non_empty(lyrics)) return null;
		return is_lrc(lyrics) ? lrc_version(lyrics) : { format: 'PLAIN', sync_type: 'NONE', raw_content: lyrics };
	}
	if (typeof lyrics !== 'object' || lyrics === null) return null;
	return { format: 'YTM_JSON', sync_type: has_ytm_timing(lyrics) ? 'LINE' : 'NONE', raw_content: JSON.stringify(lyrics) };
}
