import { sql } from 'drizzle-orm';
import type { Tx } from '../db';
import { thumbnails_table } from '../db/schema';

/** Same shape as lib-origin's `IllusiveThumbnail`. */
export interface Thumbnail { url: string; width?: number | null; height?: number | null }

const YT_SIZES: Record<string, [number, number]> = {
	default: [120, 90], mqdefault: [320, 180], hqdefault: [480, 360], sddefault: [640, 480], maxresdefault: [1280, 720]
};

const clean_size = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n <= 0 ? null : Math.round(n));

/** Reads a size out of known URL patterns. */
export function parse_thumbnail_size(url: string): { width: number; height: number } | null {
	let m = /(\d+)x(\d+)bb/u.exec(url);
	if (m) return { width: Number(m[1]), height: Number(m[2]) };
	m = /[=-]w(\d+)-h(\d+)/u.exec(url);
	if (m) return { width: Number(m[1]), height: Number(m[2]) };
	m = /-t(\d+)x(\d+)\./u.exec(url);
	if (m) return { width: Number(m[1]), height: Number(m[2]) };
	if (url.includes('-large.') && url.includes('sndcdn.com')) return { width: 100, height: 100 };
	m = /i\.ytimg\.com\/vi\/[^/]+\/([a-z]+)\.jpg/u.exec(url);
	if (m && YT_SIZES[m[1]]) return { width: YT_SIZES[m[1]][0], height: YT_SIZES[m[1]][1] };
	return null;
}

export function youtube_thumbnails(youtube_id: string): Thumbnail[] {
	return Object.entries(YT_SIZES).map(([name, [width, height]]) => ({ url: `https://i.ytimg.com/vi/${youtube_id}/${name}.jpg`, width, height }));
}

/** iTunes `artworkUrl30/60/100/600`. */
export function itunes_thumbnails(row: { artwork_url_30?: string | null; artwork_url_60?: string | null; artwork_url_100?: string | null; artwork_url_600?: string | null }): Thumbnail[] {
	return [row.artwork_url_30, row.artwork_url_60, row.artwork_url_100, row.artwork_url_600]
		.filter((u): u is string => !!u)
		.map(url => ({ url, ...parse_thumbnail_size(url) }));
}

/** SoundCloud `artwork_url` (`-large` = 100x100) plus the derived `-t500x500` variant. */
export function soundcloud_thumbnails(artwork_url: string | null | undefined): Thumbnail[] {
	if (!artwork_url) return [];
	const out: Thumbnail[] = [{ url: artwork_url, ...parse_thumbnail_size(artwork_url) }];
	if (artwork_url.includes('-large.')) out.push({ url: artwork_url.replace('-large.', '-t500x500.'), width: 500, height: 500 });
	return out;
}

/** Largest width × height; unknown sizes rank lowest (lib-origin `best_thumbnail`). */
export function best_thumbnail<T extends Thumbnail>(thumbnails: readonly T[]): T | null {
	let best: T | null = null;
	let best_area = -1;
	for (const t of thumbnails) {
		const area = t.width && t.height ? t.width * t.height : 0;
		if (best === null || area > best_area) {
			best = t;
			best_area = area;
		}
	}
	return best;
}

/** YouTube serves channel avatars protocol-relative (`//yt3.googleusercontent.com/...`); clients would read them as file paths. */
export function absolute_url(url: string): string {
	return url.startsWith('//') ? `https:${url}` : url;
}

/**
 * Upserts by `url` for an owner whose `illusi_id` is known. Width/height are only filled when
 * empty, and parsed from the URL when missing. An existing URL keeps its owner unless it had none.
 */
export async function upsert_thumbnails(tx: Tx, owner_id: string, thumbnails: readonly Thumbnail[]) {
	const rows = new Map<string, { id: string; url: string; width: number | null; height: number | null }>();
	for (const t of thumbnails) {
		const url = absolute_url(t.url);
		if (!url || url.length > 512) continue;
		const parsed = parse_thumbnail_size(url);
		rows.set(url, { id: owner_id, url, width: clean_size(t.width) ?? parsed?.width ?? null, height: clean_size(t.height) ?? parsed?.height ?? null });
	}
	if (rows.size === 0) return;
	await tx.insert(thumbnails_table).values([...rows.values()]).onConflictDoUpdate({
		target: thumbnails_table.url,
		set: {
			id: sql`coalesce(${thumbnails_table.id}, excluded.id)`,
			width: sql`coalesce(${thumbnails_table.width}, excluded.width)`,
			height: sql`coalesce(${thumbnails_table.height}, excluded.height)`
		}
	});
}
