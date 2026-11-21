import type { LYRICS_FORMATS, LYRICS_LOOKUP_STATUSES, lyrics_services, lyrics_sync_type } from '../../db/schema';

export type LyricsService = typeof lyrics_services.enumValues[number];
export type SyncType = typeof lyrics_sync_type.enumValues[number];
export type LyricsFormat = typeof LYRICS_FORMATS[number];
export type LookupStatus = typeof LYRICS_LOOKUP_STATUSES[number];

export const SERVER_SERVICES = ['BINILYRICS', 'GOLYRICS', 'MUSIXMATCH', 'LRCLIB'] as const satisfies readonly LyricsService[];
export type ServerService = typeof SERVER_SERVICES[number];
export const CLIENT_SERVICES = ['GENIUS', 'YOUTUBE_MUSIC'] as const satisfies readonly LyricsService[];
export type ClientService = typeof CLIENT_SERVICES[number];

/** One stored version, exactly as the service returned it. */
export interface LyricsVersion {
	format: LyricsFormat;
	sync_type: SyncType;
	raw_content: string;
}

/**
 * A timed piece of a line: a word for `WORD` sync, a syllable for `SYLLABLE` sync. `text` keeps its
 * trailing whitespace, so joining a line's segments gives the line back.
 */
export interface LyricsSegment {
	text: string;
	start_ms: number;
	end_ms: number | null;
}

export interface LyricsLine {
	text: string;
	/** Null for unsynced (`NONE`) lyrics. */
	start_ms: number | null;
	end_ms: number | null;
	/** Present for `WORD` / `SYLLABLE` sync. */
	segments?: LyricsSegment[];
	/** Singer/agent id when the source has one (TTML `ttm:agent`). */
	agent?: string;
	/** Background vocals sung over the line (TTML `ttm:role="x-bg"`). */
	background?: Pick<LyricsLine, 'text' | 'start_ms' | 'end_ms' | 'segments'>;
}

/** The one shared structure every format is parsed into and served to clients. */
export interface ParsedLyrics {
	sync_type: SyncType;
	lines: LyricsLine[];
	songwriters?: string[];
}

/** A lookup record as far as the decision rules care. */
export interface LookupLike {
	status: LookupStatus;
	attempts: number;
	attempted_at: Date;
	retry_after: Date | null;
}
