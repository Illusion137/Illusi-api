import type { genius_annotations_table, genius_artists_table, genius_referents_table, genius_songs_table, genius_users_table } from '../../db/schema';
import { DEFAULT_SIMILARITY_THRESHOLD, durations_match, name_similarity, primary_artist_name } from '../../core/normalize';
import { normalize_service_id } from '../../core/service_ids';
import type { ServiceIdColumn } from '../../core/service_ids';
import { genius_version } from './formats';
import type { LyricsVersion } from './types';

/**
 * Pure extraction of a Genius `LyricsPreloadedState`. Entity maps are treated as generic
 * `Record<string, T>` (the lib-origin types came from one sample page), and every field is read
 * defensively; unknown keys are ignored.
 */

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
function int(v: unknown): number | null {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
	return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
}
const id_of = (v: unknown): number | null => {
	const n = int(v) ?? int(obj(v)?.id);
	return n != null && n > 0 ? n : null;
};
const values_of = (v: unknown): Obj[] => Object.values(obj(v) ?? {}).map(obj).filter((o): o is Obj => o !== null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Genius timestamps are epoch seconds; tolerate milliseconds too. */
export function epoch_to_date(v: unknown): Date | null {
	const n = typeof v === 'number' ? v : null;
	if (n == null || !Number.isFinite(n) || n <= 0) return null;
	return new Date(n > 1e11 ? n : n * 1000);
}

/** `releaseDate` (`YYYY-MM-DD`) for the `date` column. */
export function release_date(v: unknown): string | null {
	const s = str(v);
	return s && /^\d{4}-\d{2}-\d{2}$/u.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

export type GeniusUserInsert = typeof genius_users_table.$inferInsert;
export type GeniusArtistInsert = typeof genius_artists_table.$inferInsert;
export type GeniusSongInsert = typeof genius_songs_table.$inferInsert;
export type GeniusReferentInsert = typeof genius_referents_table.$inferInsert;
export type GeniusAnnotationInsert = typeof genius_annotations_table.$inferInsert;
export type GeniusRole = 'PRIMARY' | 'FEATURED' | 'PRODUCER' | 'WRITER';

export interface ServiceIdCandidate { column: ServiceIdColumn; value: string | number; from: string }

export interface GeniusFacts {
	title: string;
	primary_artist: string | null;
	album: string | null;
	duration_ms: number | null;
}

export interface GeniusArtistRef { id: number; name: string; image_urls: string[] }

export interface GeniusExtraction {
	song_id: number;
	users: GeniusUserInsert[];
	artists: GeniusArtistInsert[];
	song: GeniusSongInsert;
	song_artists: { artist_id: number; role: GeniusRole }[];
	referents: GeniusReferentInsert[];
	annotations: GeniusAnnotationInsert[];
	/** Raw `songPage.lyricsData.body`; null for instrumentals or when there is none. */
	lyrics: LyricsVersion | null;
	instrumental: boolean;
	producer_ids: number[];
	/** Normalized cross-service ids for the track, in priority order (explicit fields before `media[]`). */
	ids: ServiceIdCandidate[];
	unknown_providers: { provider: string; url: string | null }[];
	/** `primaryArtist` + `featuredArtists`, for enriching the track's Illusi artists by name. */
	credited_artists: GeniusArtistRef[];
	song_thumbnails: string[];
	facts: GeniusFacts;
}

function user_row(u: Obj): GeniusUserInsert | null {
	const id = id_of(u.id);
	const login = str(u.login);
	if (id == null || login == null) return null;
	return {
		id,
		login,
		name: str(u.name),
		url: str(u.url),
		avatar_url: str(obj(obj(u.avatar)?.medium)?.url),
		header_image_url: str(u.headerImageUrl),
		about_me_summary: str(u.aboutMeSummary),
		role_for_display: str(u.roleForDisplay),
		is_verified: bool(u.isVerified),
		is_meme_verified: bool(u.isMemeVerified),
		iq: int(u.iq)
	};
}

function artist_row(a: Obj): GeniusArtistInsert | null {
	const id = id_of(a.id);
	const name = str(a.name);
	if (id == null || name == null) return null;
	return {
		id,
		name,
		slug: str(a.slug),
		url: str(a.url),
		image_url: str(a.imageUrl),
		header_image_url: str(a.headerImageUrl),
		index_character: str(a.indexCharacter),
		is_verified: bool(a.isVerified),
		is_meme_verified: bool(a.isMemeVerified),
		iq: int(a.iq)
	};
}

/** Merges duplicates of one id, keeping the first non-null value of each field (an entity can appear stubbed and full). */
function merge_by_id<T extends { id: number }>(rows: readonly T[]): T[] {
	const out = new Map<number, T>();
	for (const row of rows) {
		const prev = out.get(row.id);
		if (!prev) {
			out.set(row.id, { ...row });
			continue;
		}
		for (const [k, v] of Object.entries(row)) {
			if ((prev as Obj)[k] == null && v != null) (prev as Obj)[k] = v;
		}
	}
	return [...out.values()];
}

const PROVIDER_COLUMNS: Record<string, ServiceIdColumn> = {
	youtube: 'youtube_id',
	spotify: 'spotify_id',
	soundcloud: 'soundcloud_permalink',
	apple_music: 'applemusic_id',
	applemusic: 'applemusic_id',
	deezer: 'deezer_id',
	tidal: 'tidal_id'
};

/** Pulls the provider's id out of a link where the column expects a bare id. */
function provider_value(column: ServiceIdColumn, url: string): string | null {
	switch (column) {
		case 'deezer_id': return /deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/u.exec(url)?.[1] ?? (/^\d+$/u.test(url) ? url : null);
		case 'tidal_id': return /tidal\.com\/(?:browse\/)?track\/(\d+)/u.exec(url)?.[1] ?? (/^\d+$/u.test(url) ? url : null);
		default: return url;
	}
}

function find_duration_ms(song: Obj, media: Obj[]): number | null {
	for (const source of [song, ...media]) {
		const ms = int(source.durationMs) ?? int(source.duration_ms);
		if (ms != null && ms > 0) return ms;
		const s = typeof source.duration === 'number' ? source.duration : null;
		if (s != null && s > 0) return Math.round(s * 1000);
	}
	return null;
}

function album_name(song: Obj, entities: Obj): string | null {
	const album = song.album;
	const direct = str(obj(album)?.name);
	if (direct) return direct;
	const album_id = id_of(album);
	if (album_id != null) {
		const from_entities = str(obj(obj(entities.albums)?.[String(album_id)])?.name);
		if (from_entities) return from_entities;
	}
	for (const a of list(song.albums)) {
		const name = str(obj(a)?.name) ?? str(obj(obj(entities.albums)?.[String(id_of(a))])?.name);
		if (name) return name;
	}
	return null;
}

export function extract_genius_payload(state: unknown): GeniusExtraction | { error: string } {
	const root = obj(state);
	const song_page = obj(root?.songPage);
	const entities = obj(root?.entities);
	const song_id = id_of(song_page?.song);
	if (!root || !song_page || !entities || song_id == null) return { error: 'preloaded_state.songPage.song is missing' };
	const song = obj(obj(entities.songs)?.[String(song_id)]);
	if (!song) return { error: 'preloaded_state.songPage.song is not in entities.songs' };
	const title = str(song.title);
	if (!title) return { error: 'Genius song has no title' };

	const users = merge_by_id(values_of(entities.users).map(user_row).filter((u): u is GeniusUserInsert => u !== null));

	const primary_artist = obj(song.primaryArtist);
	const featured = list(song.featuredArtists).map(obj).filter((a): a is Obj => a !== null);
	const writers = list(song.writerArtists).map(obj).filter((a): a is Obj => a !== null);
	const producers = list(song.producerArtists).map(obj).filter((a): a is Obj => a !== null);
	const primaries = list(song.primaryArtists);
	const artist_objects = [
		...values_of(entities.artists),
		...(primary_artist ? [primary_artist] : []),
		...primaries.map(obj).filter((a): a is Obj => a !== null),
		...featured, ...writers, ...producers
	];
	const artists = merge_by_id(artist_objects.map(artist_row).filter((a): a is GeniusArtistInsert => a !== null));
	const artist_ids = new Set(artists.map(a => a.id));

	const role_rows: { artist_id: number; role: GeniusRole }[] = [];
	const add_role = (items: unknown[], role: GeniusRole) => {
		for (const item of items) {
			const id = id_of(item);
			if (id != null && artist_ids.has(id) && !role_rows.some(r => r.artist_id === id && r.role === role)) role_rows.push({ artist_id: id, role });
		}
	};
	add_role(primaries.length > 0 ? primaries : primary_artist ? [primary_artist] : [], 'PRIMARY');
	add_role(featured, 'FEATURED');
	add_role(producers, 'PRODUCER');
	add_role(writers, 'WRITER');

	const stats = obj(song.stats);
	const primary_artist_id = id_of(primary_artist);
	const lyrics_owner_id = id_of(song.lyricsOwnerId);
	const song_row: GeniusSongInsert = {
		id: song_id,
		primary_artist_id: primary_artist_id != null && artist_ids.has(primary_artist_id) ? primary_artist_id : null,
		lyrics_owner_id,
		title,
		title_with_featured: str(song.titleWithFeatured),
		full_title: str(song.fullTitle),
		artist_names: str(song.artistNames),
		primary_artist_names: str(song.primaryArtistNames),
		url: str(song.url),
		song_art_image_url: str(song.songArtImageUrl),
		header_image_url: str(song.headerImageUrl),
		description: str(obj(song.description)?.markdown),
		language: str(song.language),
		lyrics_state: str(song.lyricsState),
		instrumental: bool(song.instrumental),
		explicit: bool(song.explicit),
		hot: bool(stats?.hot),
		annotation_count: int(song.annotationCount),
		pageviews: int(stats?.pageviews),
		apple_music_id: str(song.appleMusicId) ?? (int(song.appleMusicId) == null ? null : String(int(song.appleMusicId))),
		spotify_uuid: str(song.spotifyUuid),
		youtube_url: str(song.youtubeUrl),
		soundcloud_url: str(song.soundcloudUrl),
		release_date: release_date(song.releaseDate),
		lyrics_updated_at: epoch_to_date(song.lyricsUpdatedAt),
		updated_by_human_at: epoch_to_date(song.updatedByHumanAt)
	};

	// Stub referents (only id / classification / fragmentId) belong to this page's song.
	const referents = merge_by_id(values_of(entities.referents).flatMap((r): GeniusReferentInsert[] => {
		const id = id_of(r.id);
		const referent_song = id_of(r.songId);
		if (id == null || (referent_song != null && referent_song !== song_id)) return [];
		return [{
			id,
			song_id,
			annotator_id: id_of(r.annotatorId),
			fragment: str(r.fragment),
			classification: str(r.classification),
			path: str(r.path),
			is_image: bool(r.isImage),
			is_description: bool(r.isDescription)
		}];
	}));
	const referent_ids = new Set(referents.map(r => r.id));

	const annotations = merge_by_id(values_of(entities.annotations).flatMap((a): GeniusAnnotationInsert[] => {
		const id = id_of(a.id);
		const referent_id = id_of(a.referentId);
		if (id == null || referent_id == null || !referent_ids.has(referent_id)) return [];
		return [{
			id,
			referent_id,
			created_by_id: id_of(a.createdBy),
			body_markdown: str(obj(a.body)?.markdown),
			state: str(a.state),
			verified: bool(a.verified),
			community: bool(a.community),
			pinned: bool(a.pinned),
			votes_total: int(a.votesTotal),
			comment_count: int(a.commentCount),
			genius_created_at: epoch_to_date(a.createdAt)
		}];
	}));

	const instrumental = song.instrumental === true;
	const lyrics = instrumental ? null : genius_version(obj(song_page.lyricsData)?.body);

	const ids: ServiceIdCandidate[] = [];
	const unknown_providers: { provider: string; url: string | null }[] = [];
	const add_id = (column: ServiceIdColumn, raw: unknown, from: string) => {
		if (typeof raw !== 'number' && (typeof raw !== 'string' || raw === '')) return;
		const value = normalize_service_id(column, raw);
		if (value == null) return;
		if (!ids.some(c => c.column === column && String(c.value) === String(value))) ids.push({ column, value, from });
	};
	add_id('genius_id', song_id, 'id');
	add_id('applemusic_id', song.appleMusicId, 'appleMusicId');
	const player_url = str(song.appleMusicPlayerUrl);
	if (player_url && /^https?:\/\/(?:[a-z]+\.)?music\.apple\.com\//u.test(player_url)) add_id('applemusic_id', player_url, 'appleMusicPlayerUrl');
	add_id('spotify_id', song.spotifyUuid, 'spotifyUuid');
	add_id('youtube_id', song.youtubeUrl, 'youtubeUrl');
	add_id('soundcloud_permalink', song.soundcloudUrl, 'soundcloudUrl');
	const media = list(song.media).map(obj).filter((m): m is Obj => m !== null);
	for (const m of media) {
		const provider = str(m.provider)?.toLowerCase() ?? '';
		const url = str(m.url) ?? str(m.nativeUri);
		const column = PROVIDER_COLUMNS[provider] as ServiceIdColumn | undefined;
		if (!column) {
			unknown_providers.push({ provider, url });
			continue;
		}
		if (url) add_id(column, provider_value(column, url), `media.${provider}`);
	}

	const credited_artists: GeniusArtistRef[] = [...(primary_artist ? [primary_artist] : []), ...featured].flatMap((a) => {
		const id = id_of(a.id);
		const name = str(a.name);
		if (id == null || name == null) return [];
		return [{ id, name, image_urls: [str(a.imageUrl), str(a.headerImageUrl)].filter((u): u is string => u !== null) }];
	}).filter((a, i, all) => all.findIndex(b => b.id === a.id) === i);

	return {
		song_id,
		users,
		artists,
		song: song_row,
		song_artists: role_rows,
		referents,
		annotations,
		lyrics,
		instrumental,
		producer_ids: [...new Set(producers.map(p => id_of(p.id)).filter((id): id is number => id != null && artist_ids.has(id)))],
		ids,
		unknown_providers,
		credited_artists,
		song_thumbnails: [str(song.songArtImageUrl), str(song.headerImageUrl)].filter((u): u is string => u !== null),
		facts: {
			title,
			primary_artist: str(primary_artist?.name) ?? str(song.primaryArtistNames),
			album: album_name(song, entities),
			duration_ms: find_duration_ms(song, media)
		}
	};
}

/** What the match needs to know about the Illusi track. */
export interface TrackFacts {
	service_ids: Partial<Record<ServiceIdColumn, string | number | null>>;
	title: string;
	/** The track's artist names, primary first. */
	artists: string[];
	album: string | null;
	duration_ms: number | null;
}

export type GeniusMatch
	= | { matched: true; method: 'id'; column: ServiceIdColumn }
		| { matched: true; method: 'metadata' }
		| { matched: false; reason: string };

/**
 * Any shared cross-service id is a strong match; otherwise title and primary artist must each
 * be ≥ 0.9 similar, the album must match when both have one, and the duration must be within ±3 s
 * when Genius provides one.
 */
export function match_genius_song(track: TrackFacts, genius: Pick<GeniusExtraction, 'ids' | 'facts'>): GeniusMatch {
	for (const candidate of genius.ids) {
		const own = track.service_ids[candidate.column];
		if (own != null && String(own) === String(candidate.value)) return { matched: true, method: 'id', column: candidate.column };
	}
	const t = DEFAULT_SIMILARITY_THRESHOLD;
	if (name_similarity(genius.facts.title, track.title) < t) return { matched: false, reason: 'title' };
	const genius_artist = genius.facts.primary_artist;
	if (!genius_artist || track.artists.length === 0) return { matched: false, reason: 'artist' };
	const genius_primary = primary_artist_name(genius_artist);
	const artist_ok = track.artists.some(a => name_similarity(genius_primary, primary_artist_name(a)) >= t || name_similarity(genius_artist, a) >= t);
	if (!artist_ok) return { matched: false, reason: 'artist' };
	if (genius.facts.album && track.album && name_similarity(genius.facts.album, track.album) < t) return { matched: false, reason: 'album' };
	if (genius.facts.duration_ms != null && track.duration_ms != null && !durations_match(genius.facts.duration_ms, track.duration_ms)) return { matched: false, reason: 'duration' };
	return { matched: true, method: 'metadata' };
}
