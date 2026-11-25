/**
 * Contribution graph shared by `POST /contribute` and the `entities` part of `POST /sync/push`.
 * Validation is pure: every entity and relation is checked on its own, so a malformed one is rejected
 * together with whatever references it, and the rest of the payload still applies.
 */
import { z } from 'zod';
import { SERVICE_ID_COLUMNS } from '../../core/service_ids';
import type { ServiceIds } from '../../core/service_ids';
import type { Thumbnail } from '../../core/thumbnails';
import { album_type } from '../../db/schema';

export type EntityType = 'artist' | 'album' | 'track';
export type RelationKind = 'tracks_artists' | 'album_tracks' | 'artist_albums' | 'similar_artists';

export const MAX_THUMBNAILS_PER_ENTITY = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A ref is either a temp id local to the payload or an existing `illusi_id`. */
export const is_uuid = (value: string) => UUID_RE.test(value);

const ref_schema = z.string().trim().min(1).max(128);
const service_id_value = z.union([z.string().max(512), z.number()]).nullish();
export const service_ids_schema = z.object(Object.fromEntries(SERVICE_ID_COLUMNS.map(c => [c, service_id_value])) as Record<typeof SERVICE_ID_COLUMNS[number], typeof service_id_value>);

/** `NaN`, negatives and non-numbers become `null`. */
const size_schema = z.unknown().transform(v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null));
const thumbnail_schema = z.object({ url: z.string().trim().min(1).max(2048), width: size_schema.optional(), height: size_schema.optional() });

const date_schema = z.union([z.string().max(64), z.number()]).nullish().transform((v, ctx) => {
	if (v == null) return v;
	const date = new Date(v);
	if (Number.isNaN(date.getTime())) {
		ctx.addIssue({ code: 'custom', message: 'invalid date' });
		return z.NEVER;
	}
	return date;
});

const common = {
	ref: ref_schema,
	service_ids: service_ids_schema.optional(),
	thumbnails: z.array(thumbnail_schema).max(MAX_THUMBNAILS_PER_ENTITY).optional()
};

export const artist_schema = z.object({
	...common,
	name: z.string().trim().min(1).max(4096),
	description: z.string().max(100_000).nullish(),
	primary_genre_name: z.string().max(1024).nullish()
});
export const album_schema = z.object({
	...common,
	name: z.string().trim().min(1).max(4096),
	artist_ref: ref_schema.nullish(),
	album_type: z.enum(album_type.enumValues).nullish(),
	release_date: date_schema,
	track_count: z.number().int().min(0).max(100_000).nullish(),
	explicit: z.boolean().nullish()
});
/** The service a contributed track came from (lib-origin's `MusicServiceType`); it decides how much its `explicit` counts. */
export const CONTRIBUTION_SOURCES = [
	'Illusi', 'Musi', 'YouTube', 'YouTube Music', 'Spotify', 'Amazon Music', 'Apple Music', 'SoundCloud', 'BandLab', 'Audiomack', 'Deezer', 'Tidal', 'Pandora', 'API'
] as const;
export type ContributionSource = typeof CONTRIBUTION_SOURCES[number];

export const track_schema = z.object({
	...common,
	title: z.string().trim().min(1).max(4096),
	album_ref: ref_schema.nullish(),
	duration_ms: z.number().int().min(0).max(7 * 24 * 3_600_000).nullish(),
	explicit: z.boolean().nullish(),
	imported: z.boolean().nullish(),
	// A service this server doesn't know yet counts as unknown rather than rejecting the track.
	source: z.enum(CONTRIBUTION_SOURCES).nullish().catch(null)
});

const position_schema = z.number().int().min(0).max(1_000_000).nullish();
export const relation_schemas = {
	tracks_artists: z.object({ track_ref: ref_schema, artist_ref: ref_schema }),
	album_tracks: z.object({ album_ref: ref_schema, track_ref: ref_schema, track_number: position_schema }),
	artist_albums: z.object({ artist_ref: ref_schema, album_ref: ref_schema, position: position_schema }),
	similar_artists: z.object({ artist_ref: ref_schema, similar_artist_ref: ref_schema })
} as const;

export type ArtistInput = z.infer<typeof artist_schema>;
export type AlbumInput = z.infer<typeof album_schema>;
export type TrackInput = z.infer<typeof track_schema>;
export type EntityInput = ArtistInput | AlbumInput | TrackInput;
export interface Relations {
	tracks_artists: z.infer<typeof relation_schemas.tracks_artists>[];
	album_tracks: z.infer<typeof relation_schemas.album_tracks>[];
	artist_albums: z.infer<typeof relation_schemas.artist_albums>[];
	similar_artists: z.infer<typeof relation_schemas.similar_artists>[];
}
export interface Graph { artists: ArtistInput[]; albums: AlbumInput[]; tracks: TrackInput[]; relations: Relations }

/** The graph as received: entities are only checked to be arrays here, each one is validated on its own. */
export const raw_graph_schema = z.object({
	artists: z.array(z.unknown()).optional(),
	albums: z.array(z.unknown()).optional(),
	tracks: z.array(z.unknown()).optional(),
	relations: z.object({
		tracks_artists: z.array(z.unknown()).optional(),
		album_tracks: z.array(z.unknown()).optional(),
		artist_albums: z.array(z.unknown()).optional(),
		similar_artists: z.array(z.unknown()).optional()
	}).optional()
});
export type RawGraph = z.infer<typeof raw_graph_schema>;

export interface Rejection {
	/** `artist` / `album` / `track` or a relation kind. */
	kind: EntityType | RelationKind;
	index: number;
	ref?: string;
	/** For a dropped reference field (`artist_ref`, `album_ref`) on an entity that is otherwise applied. */
	field?: string;
	reason: string;
	issues?: unknown;
}

export function graph_counts(raw: RawGraph): { entities: number; relations: number } {
	const r = raw.relations;
	return {
		entities: (raw.artists?.length ?? 0) + (raw.albums?.length ?? 0) + (raw.tracks?.length ?? 0),
		relations: (r?.tracks_artists?.length ?? 0) + (r?.album_tracks?.length ?? 0) + (r?.artist_albums?.length ?? 0) + (r?.similar_artists?.length ?? 0)
	};
}

const ref_of = (item: unknown) => {
	const ref = (item as { ref?: unknown } | null)?.ref;
	return typeof ref === 'string' ? ref.trim() : undefined;
};

/** Which entity type a relation endpoint must be. */
const RELATION_REFS: Record<RelationKind, [string, EntityType][]> = {
	tracks_artists: [['track_ref', 'track'], ['artist_ref', 'artist']],
	album_tracks: [['album_ref', 'album'], ['track_ref', 'track']],
	artist_albums: [['artist_ref', 'artist'], ['album_ref', 'album']],
	similar_artists: [['artist_ref', 'artist'], ['similar_artist_ref', 'artist']]
};
const RELATION_KINDS = Object.keys(RELATION_REFS) as RelationKind[];

/** `175K`, `1.2M views`, `4,031 plays`: the count YouTube shows beside a channel, which older clients credited as an artist. */
const VIEW_COUNT_RE = /^\d[\d.,]*(?:\s*[KMB]|\s*[KMBkmb]?\s+(?:views?|plays?))$/u;

/** An artist named like a view count with no id anywhere: never a real credit (a real `10K` comes with its ids). */
function is_view_count_artist(artist: ArtistInput): boolean {
	return VIEW_COUNT_RE.test(artist.name) && !Object.values(artist.service_ids ?? {}).some(v => v != null && v !== '');
}

/**
 * Validates every entity and relation separately.
 * - A malformed entity, or a duplicate ref, is rejected.
 * - Relations referencing a rejected ref, a ref of the wrong type, or an unknown temp ref are rejected.
 * - `album.artist_ref` / `track.album_ref` pointing at such a ref are dropped; the entity itself still applies.
 * - A ref that isn't defined in the payload but looks like a UUID is kept: it may be an existing `illusi_id`.
 * - An artist named like a view count without ids is rejected, and with it every credit to it.
 */
export function validate_graph(raw: RawGraph): { graph: Graph; rejected: Rejection[] } {
	const rejected: Rejection[] = [];
	const types = new Map<string, EntityType>();
	const bad = new Set<string>();

	function take<T extends { ref: string }>(kind: EntityType, items: unknown[] | undefined, schema: z.ZodType<T>): T[] {
		const out: T[] = [];
		(items ?? []).forEach((item, index) => {
			const parsed = schema.safeParse(item);
			const ref = ref_of(item);
			if (!parsed.success) {
				rejected.push({ kind, index, ref, reason: 'malformed', issues: parsed.error.issues });
				if (ref && !types.has(ref)) bad.add(ref);
				return;
			}
			if (types.has(parsed.data.ref)) {
				rejected.push({ kind, index, ref, reason: 'duplicate ref' });
				return;
			}
			types.set(parsed.data.ref, kind);
			out.push(parsed.data);
		});
		return out;
	}

	const artists = take('artist', raw.artists, artist_schema).filter((artist, index) => {
		if (!is_view_count_artist(artist)) return true;
		rejected.push({ kind: 'artist', index, ref: artist.ref, reason: 'a view count, not an artist' });
		types.delete(artist.ref);
		bad.add(artist.ref);
		return false;
	});
	const albums = take('album', raw.albums, album_schema);
	const tracks = take('track', raw.tracks, track_schema);
	// A ref rejected once but defined validly elsewhere is still usable.
	for (const ref of types.keys()) bad.delete(ref);

	/** Why a ref can't be used as an endpoint of `expected` type, or null if it can. */
	const ref_problem = (ref: string, expected: EntityType): string | null => {
		if (bad.has(ref)) return 'references a rejected entity';
		const type = types.get(ref);
		if (type) return type === expected ? null : `references a ${type}, expected ${expected}`;
		return is_uuid(ref) ? null : 'unknown ref';
	};

	albums.forEach((album, index) => {
		if (album.artist_ref == null) return;
		const problem = ref_problem(album.artist_ref, 'artist');
		if (problem) {
			rejected.push({ kind: 'album', index, ref: album.ref, field: 'artist_ref', reason: problem });
			album.artist_ref = undefined;
		}
	});
	tracks.forEach((track, index) => {
		if (track.album_ref == null) return;
		const problem = ref_problem(track.album_ref, 'album');
		if (problem) {
			rejected.push({ kind: 'track', index, ref: track.ref, field: 'album_ref', reason: problem });
			track.album_ref = undefined;
		}
	});

	const relations: Relations = { tracks_artists: [], album_tracks: [], artist_albums: [], similar_artists: [] };
	for (const kind of RELATION_KINDS) {
		const seen = new Set<string>();
		(raw.relations?.[kind] ?? []).forEach((item, index) => {
			const parsed = relation_schemas[kind].safeParse(item);
			if (!parsed.success) {
				rejected.push({ kind, index, reason: 'malformed', issues: parsed.error.issues });
				return;
			}
			const value = parsed.data as Record<string, string | number | null | undefined>;
			const endpoints = RELATION_REFS[kind].map(([field]) => value[field] as string);
			const problem = RELATION_REFS[kind].map(([field, type]) => {
				const p = ref_problem(value[field] as string, type);
				return p ? `${field} ${p}` : null;
			}).find(p => p != null);
			if (problem) {
				rejected.push({ kind, index, reason: problem });
				return;
			}
			if (kind === 'similar_artists' && endpoints[0] === endpoints[1]) {
				rejected.push({ kind, index, reason: 'artist cannot be similar to itself' });
				return;
			}
			const key = endpoints.join('\u0000');
			if (seen.has(key)) return;
			seen.add(key);
			(relations[kind] as unknown[]).push(parsed.data);
		});
	}

	return { graph: { artists, albums, tracks, relations }, rejected };
}

/** Service ids as the core helpers take them. */
export const service_ids_of = (entity: { service_ids?: ServiceIds }): ServiceIds => entity.service_ids ?? {};
export const thumbnails_of = (entity: { thumbnails?: { url: string; width?: number | null; height?: number | null }[] }): Thumbnail[] => entity.thumbnails ?? [];
