/** Normalization of external IDs before they are written to `service_ids_table`. */

export const SERVICE_ID_COLUMNS = [
	'youtube_id', 'spotify_id', 'soundcloud_id', 'soundcloud_permalink', 'amazonmusic_id', 'applemusic_id',
	'bandlab_id', 'audiomack_id', 'deezer_id', 'pandora_id', 'tidal_id', 'genius_id', 'isrc'
] as const;
export type ServiceIdColumn = typeof SERVICE_ID_COLUMNS[number];
export type ServiceIds = Partial<Record<ServiceIdColumn, string | number | null | undefined>>;
/** Normalized values; bigint columns are numbers, everything else strings. */
export type NormalizedServiceIds = Partial<Record<ServiceIdColumn, string | number>>;

/** Columns that are `unique` in `service_ids_table`. `isrc` is the only non-unique one. */
export const UNIQUE_SERVICE_ID_COLUMNS: readonly ServiceIdColumn[] = SERVICE_ID_COLUMNS.filter(c => c !== 'isrc');
export const NUMERIC_SERVICE_ID_COLUMNS: readonly ServiceIdColumn[] = ['soundcloud_id', 'genius_id'];

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/u;
/** Artists store their channel; tracks store their video */
const YOUTUBE_CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/u;

export function normalize_youtube_id(value: string): string | null {
	const v = value.trim();
	if (YOUTUBE_ID_RE.test(v) || YOUTUBE_CHANNEL_RE.test(v)) return v;
	try {
		const url = new URL(v.includes('://') ? v : `https://${v}`);
		const host = url.hostname.replace(/^www\.|^m\.|^music\./u, '');
		let id: string | null = null;
		if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
		else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
			id = url.searchParams.get('v');
			const channel = /^\/channel\/([^/?#]+)/u.exec(url.pathname)?.[1];
			if (!id && channel && YOUTUBE_CHANNEL_RE.test(channel)) return channel;
			if (!id) {
				const m = /^\/(?:embed|shorts|v|live)\/([^/?#]+)/u.exec(url.pathname);
				id = m?.[1] ?? null;
			}
		}
		return id && YOUTUBE_ID_RE.test(id) ? id : null;
	} catch {
		return null;
	}
}

/** `user/track` path (or `user` for an artist), lowercase, no domain or query. Accepts full URLs or bare paths. */
export function normalize_soundcloud_permalink(value: string): string | null {
	let v = value.trim();
	if (!v) return null;
	if (v.includes('://') || v.startsWith('soundcloud.com') || v.startsWith('www.soundcloud.com') || v.startsWith('m.soundcloud.com')) {
		try {
			const url = new URL(v.includes('://') ? v : `https://${v}`);
			if (!/(^|\.)soundcloud\.com$/u.test(url.hostname)) return null;
			v = url.pathname;
		} catch {
			return null;
		}
	}
	v = v.split(/[?#]/u)[0].replace(/^\/+|\/+$/gu, '').toLowerCase();
	const parts = v.split('/');
	if (parts.some(p => !p)) return null;
	return parts.join('/');
}

export function normalize_applemusic_id(value: string | number): string | null {
	const v = String(value).trim();
	if (/^\d+$/u.test(v)) return v;
	// music.apple.com/us/album/name/123?i=456 → the track id is `i`, otherwise the last numeric segment
	try {
		const url = new URL(v);
		const i = url.searchParams.get('i');
		if (i && /^\d+$/u.test(i)) return i;
		const m = /\/(?:id)?(\d+)\/?$/u.exec(url.pathname);
		return m?.[1] ?? null;
	} catch {
		return null;
	}
}

export function normalize_spotify_id(value: string): string | null {
	const v = value.trim();
	if (/^[0-9A-Za-z]{22}$/u.test(v)) return v;
	const m = /(?:spotify:(?:track|album|artist):|open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:track|album|artist)\/)([0-9A-Za-z]{22})/u.exec(v);
	return m?.[1] ?? null;
}

export function normalize_isrc(value: string): string | null {
	const v = value.replace(/[-\s]/gu, '').toUpperCase();
	return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(v) ? v : null;
}

function normalize_numeric(value: string | number): number | null {
	const n = typeof value === 'number' ? value : Number(value.trim());
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function normalize_service_id(column: ServiceIdColumn, value: string | number): string | number | null {
	switch (column) {
		case 'youtube_id': return normalize_youtube_id(String(value));
		case 'soundcloud_permalink': return normalize_soundcloud_permalink(String(value));
		case 'applemusic_id': return normalize_applemusic_id(value);
		case 'spotify_id': return normalize_spotify_id(String(value));
		case 'isrc': return normalize_isrc(String(value));
		case 'soundcloud_id':
		case 'genius_id': return normalize_numeric(value);
		default: {
			const v = String(value).trim();
			return v ? v : null;
		}
	}
}

/** Normalizes every present value; invalid values are dropped and returned in `rejected`. */
export function normalize_service_ids(ids: ServiceIds): { ids: NormalizedServiceIds; rejected: { column: ServiceIdColumn; value: unknown }[] } {
	const out: NormalizedServiceIds = {};
	const rejected: { column: ServiceIdColumn; value: unknown }[] = [];
	for (const column of SERVICE_ID_COLUMNS) {
		const value = ids[column];
		if (value == null || value === '') continue;
		const normalized = normalize_service_id(column, value);
		if (normalized == null) rejected.push({ column, value });
		else out[column] = normalized;
	}
	return { ids: out, rejected };
}
