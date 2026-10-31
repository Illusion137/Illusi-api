import { z } from 'zod';
import { CATALOG_SERVICES } from '../../db/schema';
import type { CatalogService } from '../../db/schema';
import { normalize_service_id } from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';

export const SERVICE_ID_COLUMN: Record<CatalogService, ServiceIdColumn> = {
	spotify: 'spotify_id', applemusic: 'applemusic_id', amazonmusic: 'amazonmusic_id', deezer: 'deezer_id',
	tidal: 'tidal_id', pandora: 'pandora_id', bandlab: 'bandlab_id', audiomack: 'audiomack_id'
};

/** Cap on a stored raw payload; larger ones are kept without it rather than rejected. */
export const MAX_RAW_BYTES = 64 * 1024;

const id = z.union([z.string(), z.number()]).transform(v => String(v).trim()).pipe(z.string().min(1).max(256));
const text = (max: number) => z.string().max(max).nullish();
const names = z.array(z.string().max(1024)).max(64).nullish();
const ids = z.array(id).max(64).nullish();
const count = z.number().int().min(0).max(2 ** 53).nullish();
const url = z.string().max(1024).nullish();
const date = z.union([z.string().max(64), z.number()]).nullish().transform((v) => {
	if (v == null) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
});

const base = { service: z.enum(CATALOG_SERVICES), id, raw: z.unknown().optional() };

export const artist_item = z.object({
	...base, kind: z.literal('artist'),
	name: z.string().trim().min(1).max(1024), artwork_url: url, verified: z.boolean().nullish(), description: text(100_000), followers_count: count
});
export const album_item = z.object({
	...base, kind: z.literal('album'),
	title: z.string().trim().min(1).max(1024), artist_names: names, artist_ids: ids, album_type: text(32), release_date: date,
	explicit: z.boolean().nullish(), track_count: z.number().int().min(0).max(100_000).nullish(), artwork_url: url
});
export const track_item = z.object({
	...base, kind: z.literal('track'),
	title: z.string().trim().min(1).max(1024), alt_title: text(1024), artist_names: names, artist_ids: ids,
	album_title: text(1024), album_id: id.nullish(), duration_ms: z.number().int().min(0).max(7 * 24 * 3_600_000).nullish(),
	explicit: z.boolean().nullish(), plays: count, isrc: text(12), artwork_url: url
});
export const item_schema = z.discriminatedUnion('kind', [artist_item, album_item, track_item]);
export type CatalogItem = z.infer<typeof item_schema>;

export interface Rejected { index: number; reason: string }

/** Items are checked one by one so a malformed one doesn't sink the batch. Repeats within a batch keep the last. */
export function validate_items(items: readonly unknown[]): { valid: CatalogItem[]; rejected: Rejected[] } {
	const latest = new Map<string, CatalogItem>();
	const rejected: Rejected[] = [];
	items.forEach((raw, index) => {
		const parsed = item_schema.safeParse(raw);
		if (!parsed.success) {
			rejected.push({ index, reason: parsed.error.issues[0]?.message ?? 'invalid' });
			return;
		}
		const item = parsed.data;
		const external_id = normalize_service_id(SERVICE_ID_COLUMN[item.service], item.id);
		// Service ids the global tables can't hold still get a catalog row, keyed by what the service sent
		const key = external_id === null ? item.id : String(external_id);
		latest.set(`${item.kind}:${item.service}:${key}`, { ...item, id: key, raw: bounded(item.raw) });
	});
	return { valid: [...latest.values()], rejected };
}

function bounded(raw: unknown): unknown {
	if (raw === undefined) return null;
	try {
		return JSON.stringify(raw).length <= MAX_RAW_BYTES ? raw : null;
	} catch {
		return null;
	}
}
