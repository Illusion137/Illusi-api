import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { bigint, boolean, bytea, check, date, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid, varchar, vector } from 'drizzle-orm/pg-core';

const ITUNES_EXPLICITNESS = ['explicit', 'cleaned', 'notExplicit'] as const;
export const itunes_explicitness = pgEnum('itunes_explicitness', ITUNES_EXPLICITNESS);

const LYRICS_SERVICES = ['BINILYRICS', 'LRCLIB', 'YOUTUBE_MUSIC', 'GENIUS', 'UNISON', 'QQMUSIC', 'KUGOU', 'LRCRED', 'USER'] as const;
export const lyrics_services = pgEnum('lyrics_services', LYRICS_SERVICES);

const ALBUM_TYPES = ['SINGLE', 'ALBUM', 'EP'] as const;
export const album_type = pgEnum('album_type', ALBUM_TYPES);

const LYRICS_SYNC_TYPES = ['NONE', 'LINE', 'WORD', 'SYLLABLE'] as const;
export const lyrics_sync_type = pgEnum('sync_type', LYRICS_SYNC_TYPES);

const GENIUS_ARTIST_ROLES = ['PRIMARY', 'FEATURED', 'PRODUCER', 'WRITER'] as const;
export const genius_artist_role = pgEnum('genius_artist_role', GENIUS_ARTIST_ROLES);

const SORT_TYPES = [
	'ALPHABETICAL', 'ALPHABETICAL_REVERSE',
	'NEWEST', 'OLDEST',
	'DURATION_HILOW', 'DURATION_LOWHI',
	'PLAYS_HILOW', 'PLAYS_LOWHI',
	'VIEWS_HILOW', 'VIEWS_LOWHI',
	'ADDED_DATE_HILOW', 'ADDED_DATE_LOWHI',
	'DOWNLOAD_DATE_HILOW', 'DOWNLOAD_DATE_LOWHI',
	'LAST_PLAYED_DATE_HILOW', 'LAST_PLAYED_DATE_LOWHI',
	'LAST_SAMPLED_DATE_HILOW', 'LAST_SAMPLED_DATE_LOWHI',
	'LONGEST_PLAYED_HILOW', 'LONGEST_PLAYED_LOWHI'
] as const;
export const sort_type = pgEnum('sort_type', SORT_TYPES);

const INHERITANCE_MODES = ['INCLUDE', 'EXCLUDE', 'MASK', 'INTERSECTION'] as const;
export const inheritance_mode = pgEnum('inheritance_mode', INHERITANCE_MODES);

export const LYRICS_FORMATS = ['TTML', 'LRC', 'ELRC', 'PLAIN', 'GENIUS_BODY_JSON', 'YTM_JSON', 'QRC', 'KRC', 'UNISON_JSON'] as const;
export const lyrics_format = pgEnum('lyrics_format', LYRICS_FORMATS);

export const LYRICS_LOOKUP_STATUSES = ['FOUND', 'NOT_FOUND', 'INSTRUMENTAL', 'ERROR', 'SKIPPED'] as const;
export const lyrics_lookup_status = pgEnum('lyrics_lookup_status', LYRICS_LOOKUP_STATUSES);

export const ITUNES_ENTITY_TYPES = ['track', 'album', 'artist'] as const;
export const itunes_entity_type = pgEnum('itunes_entity_type', ITUNES_ENTITY_TYPES);

export const ITUNES_LOOKUP_STATUSES = ['FOUND', 'NOT_FOUND', 'ERROR'] as const;
export const itunes_lookup_status = pgEnum('itunes_lookup_status', ITUNES_LOOKUP_STATUSES);

export const SAMPLE_SOURCES = ['itunes_preview', 'media'] as const;
export const sample_source = pgEnum('sample_source', SAMPLE_SOURCES);

export const SAMPLE_LOOKUP_STATUSES = ['DONE', 'BAD_FILE', 'NOT_FOUND', 'ERROR'] as const;
export const sample_lookup_status = pgEnum('sample_lookup_status', SAMPLE_LOOKUP_STATUSES);

export const CONFLICT_STATUSES = ['open', 'deferred', 'merged', 'split', 'dismissed'] as const;
export const conflict_status = pgEnum('conflict_status', CONFLICT_STATUSES);

export const USER_ROLES = ['USER', 'ADMIN'] as const;
export const user_role = pgEnum('user_role', USER_ROLES);

export const REVIEW_KINDS = ['FIELD_CONFLICT', 'SERVICE_ID_CONFLICT', 'LYRICS_PARSE_FAILURE', 'GENIUS_MATCH_REJECTED', 'AUTO_MERGE', 'AUTO_SPLIT'] as const;
export const review_kind = pgEnum('review_kind', REVIEW_KINDS);

export const REVIEW_STATUSES = ['OPEN', 'APPLIED', 'DISMISSED'] as const;
export const review_status = pgEnum('review_status', REVIEW_STATUSES);

export const PROVENANCE_SOURCES = ['contribute', 'sync_push', 'soundcloud', 'genius', 'youtube_music', 'media', 'research', 'itunes'] as const;
export const provenance_source = pgEnum('provenance_source', PROVENANCE_SOURCES);

const timestamptz = () => timestamp({ withTimezone: true });

const timestamps = {
	created_at: timestamptz().notNull().defaultNow(),
	modified_at: timestamptz().notNull().defaultNow().$onUpdate(() => new Date())
};

export const itunes_artists_table = pgTable('itunes_artists_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	name: varchar({ length: 200 }).notNull(),
	link_url: varchar({ length: 500 }).unique(),
	artist_type: varchar({ length: 64 }),
	amg_artist_id: bigint({ mode: 'number' }),
	primary_genre_name: varchar({ length: 80 }),
	primary_genre_id: bigint({ mode: 'number' }),
	...timestamps
});

export const itunes_collections_table = pgTable('itunes_collections_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	artist_id: bigint({ mode: 'number' }).references(() => itunes_artists_table.id, { onDelete: 'set null' }),
	name: varchar({ length: 200 }).notNull(),
	censored_name: varchar({ length: 200 }),
	kind: varchar({ length: 32 }),
	view_url: varchar({ length: 500 }).unique(),
	artwork_url_30: varchar({ length: 200 }),
	artwork_url_60: varchar({ length: 200 }),
	artwork_url_100: varchar({ length: 200 }),
	artwork_url_600: varchar({ length: 200 }),
	price: doublePrecision(),
	explicitness: itunes_explicitness(),
	track_count: integer(),
	copyright: varchar({ length: 500 }),
	content_advisory_rating: varchar({ length: 20 }),
	country: varchar({ length: 10 }),
	currency: varchar({ length: 10 }),
	release_date: timestamptz(),
	primary_genre_name: varchar({ length: 80 }),
	primary_genre_id: bigint({ mode: 'number' }),
	genres: text().array(),
	genre_ids: text().array(),
	...timestamps
}, table => [index('itunes_collections_artist_id_idx').on(table.artist_id)]);

export const itunes_tracks_table = pgTable('itunes_tracks_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	artist_id: bigint({ mode: 'number' }).references(() => itunes_artists_table.id, { onDelete: 'set null' }),
	collection_id: bigint({ mode: 'number' }).references(() => itunes_collections_table.id, { onDelete: 'set null' }),
	name: varchar({ length: 200 }).notNull(),
	censored_name: varchar({ length: 200 }),
	kind: varchar({ length: 32 }),
	view_url: varchar({ length: 500 }).unique(),
	preview_url: varchar({ length: 500 }),
	artwork_url_30: varchar({ length: 200 }),
	artwork_url_60: varchar({ length: 200 }),
	artwork_url_100: varchar({ length: 200 }),
	artwork_url_600: varchar({ length: 200 }),
	price: doublePrecision(),
	explicitness: itunes_explicitness(),
	disc_count: integer(),
	disc_number: integer(),
	track_count: integer(),
	track_number: integer(),
	track_time_millis: bigint({ mode: 'number' }),
	is_streamable: boolean(),
	country: varchar({ length: 10 }),
	currency: varchar({ length: 10 }),
	release_date: timestamptz(),
	primary_genre_name: varchar({ length: 80 }),
	primary_genre_id: bigint({ mode: 'number' }),
	genres: text().array(),
	genre_ids: text().array(),
	...timestamps
}, table => [
	index('itunes_tracks_artist_id_idx').on(table.artist_id),
	index('itunes_tracks_collection_id_idx').on(table.collection_id)
]);

export const soundcloud_users_table = pgTable('soundcloud_users_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	permalink: varchar({ length: 128 }).notNull().unique(),
	username: varchar({ length: 256 }).notNull(),
	first_name: varchar({ length: 128 }),
	last_name: varchar({ length: 128 }),
	full_name: varchar({ length: 256 }),
	avatar_url: varchar({ length: 512 }),
	city: varchar({ length: 128 }),
	country_code: varchar({ length: 8 }),
	description: text(),
	verified: boolean(),
	badge_pro: boolean(),
	badge_creator_mid_tier: boolean(),
	badge_pro_unlimited: boolean(),
	followers_count: integer(),
	followings_count: integer(),
	track_count: integer(),
	playlist_count: integer(),
	likes_count: integer(),
	playlist_likes_count: integer(),
	comments_count: integer(),
	groups_count: integer(),
	reposts_count: integer(),
	soundcloud_created_at: timestamptz(),
	soundcloud_last_modified: timestamptz(),
	...timestamps
});
export const soundcloud_tracks_table = pgTable('soundcloud_tracks_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	user_id: bigint({ mode: 'number' }).references(() => soundcloud_users_table.id, { onDelete: 'set null' }),
	permalink: varchar({ length: 256 }),
	title: varchar({ length: 512 }).notNull(),
	description: text(),
	caption: text(),
	genre: varchar({ length: 128 }),
	tag_list: text(),
	license: varchar({ length: 64 }),
	label_name: varchar({ length: 256 }),
	artwork_url: varchar({ length: 512 }),
	waveform_url: varchar({ length: 512 }),
	duration: integer(),
	full_duration: integer(),
	state: varchar({ length: 32 }),
	sharing: varchar({ length: 16 }),
	embeddable_by: varchar({ length: 16 }),
	policy: varchar({ length: 32 }),
	monetization_model: varchar({ length: 64 }),
	public: boolean(),
	streamable: boolean(),
	commentable: boolean(),
	downloadable: boolean(),
	playback_count: bigint({ mode: 'number' }),
	likes_count: integer(),
	reposts_count: integer(),
	comment_count: integer(),
	download_count: integer(),
	publisher_artist: varchar({ length: 256 }),
	album_title: varchar({ length: 256 }),
	release_title: varchar({ length: 256 }),
	isrc: varchar({ length: 16 }),
	upc_or_ean: varchar({ length: 32 }),
	explicit: boolean(),
	contains_music: boolean(),
	writer_composer: text(),
	p_line: varchar({ length: 512 }),
	c_line: varchar({ length: 512 }),
	release_date: timestamptz(),
	display_date: timestamptz(),
	soundcloud_created_at: timestamptz(),
	soundcloud_last_modified: timestamptz(),
	...timestamps
}, table => [
	index('soundcloud_tracks_user_id_idx').on(table.user_id),
	index('soundcloud_tracks_released_at_idx').on(sql`coalesce(${table.release_date}, ${table.display_date}, ${table.soundcloud_created_at})`)
]);
export const soundcloud_transcodings_table = pgTable('soundcloud_transcodings_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	track_id: bigint({ mode: 'number' }).notNull().references(() => soundcloud_tracks_table.id, { onDelete: 'cascade' }),
	url: varchar({ length: 512 }).notNull(),
	preset: varchar({ length: 32 }),
	protocol: varchar({ length: 32 }),
	mime_type: varchar({ length: 64 }),
	quality: varchar({ length: 8 }),
	duration: integer(),
	snipped: boolean(),
	last_seen_at: timestamptz(),
	...timestamps
}, table => [
	uniqueIndex('soundcloud_transcodings_url_idx').on(table.url),
	index('soundcloud_transcodings_track_id_idx').on(table.track_id)
]);
export const soundcloud_playlist_table = pgTable('soundcloud_playlist_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	user_id: bigint({ mode: 'number' }).references(() => soundcloud_users_table.id, { onDelete: 'set null' }),
	permalink: varchar({ length: 256 }),
	title: varchar({ length: 512 }).notNull(),
	description: text(),
	genre: varchar({ length: 128 }),
	tag_list: text(),
	license: varchar({ length: 64 }),
	label_name: varchar({ length: 256 }),
	artwork_url: varchar({ length: 512 }),
	set_type: varchar({ length: 32 }),
	sharing: varchar({ length: 16 }),
	embeddable_by: varchar({ length: 16 }),
	is_album: boolean(),
	public: boolean(),
	duration: integer(),
	track_count: integer(),
	likes_count: integer(),
	reposts_count: integer(),
	release_date: timestamptz(),
	published_at: timestamptz(),
	display_date: timestamptz(),
	soundcloud_created_at: timestamptz(),
	soundcloud_last_modified: timestamptz(),
	...timestamps
}, table => [index('soundcloud_playlist_user_id_idx').on(table.user_id)]);
export const soundcloud_playlist_tracks_table = pgTable('soundcloud_playlist_tracks_table', {
	playlist_id: bigint({ mode: 'number' }).notNull().references(() => soundcloud_playlist_table.id, { onDelete: 'cascade' }),
	track_id: bigint({ mode: 'number' }).notNull().references(() => soundcloud_tracks_table.id, { onDelete: 'cascade' }),
	position: integer(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.playlist_id, table.track_id] }),
	index('soundcloud_playlist_tracks_track_id_idx').on(table.track_id)
]);

export const genius_artists_table = pgTable('genius_artists_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	name: varchar({ length: 256 }).notNull(),
	slug: varchar({ length: 256 }),
	url: varchar({ length: 512 }),
	image_url: varchar({ length: 512 }),
	header_image_url: varchar({ length: 512 }),
	index_character: varchar({ length: 4 }),
	is_verified: boolean(),
	is_meme_verified: boolean(),
	iq: integer(),
	...timestamps
});
export const genius_users_table = pgTable('genius_users_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	login: varchar({ length: 128 }).notNull(),
	name: varchar({ length: 256 }),
	url: varchar({ length: 512 }),
	avatar_url: varchar({ length: 512 }),
	header_image_url: varchar({ length: 512 }),
	about_me_summary: text(),
	role_for_display: varchar({ length: 64 }),
	is_verified: boolean(),
	is_meme_verified: boolean(),
	iq: integer(),
	...timestamps
});
export const genius_songs_table = pgTable('genius_songs_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	primary_artist_id: bigint({ mode: 'number' }).references(() => genius_artists_table.id, { onDelete: 'set null' }),
	lyrics_owner_id: bigint({ mode: 'number' }).references(() => genius_users_table.id, { onDelete: 'set null' }),
	title: varchar({ length: 512 }).notNull(),
	title_with_featured: varchar({ length: 512 }),
	full_title: varchar({ length: 512 }),
	artist_names: varchar({ length: 512 }),
	primary_artist_names: varchar({ length: 512 }),
	url: varchar({ length: 512 }),
	song_art_image_url: varchar({ length: 512 }),
	header_image_url: varchar({ length: 512 }),
	description: text(),
	language: varchar({ length: 16 }),
	lyrics_state: varchar({ length: 32 }),
	instrumental: boolean(),
	explicit: boolean(),
	hot: boolean(),
	annotation_count: integer(),
	pageviews: bigint({ mode: 'number' }),
	apple_music_id: varchar({ length: 32 }),
	spotify_uuid: varchar({ length: 64 }),
	youtube_url: varchar({ length: 512 }),
	soundcloud_url: varchar({ length: 512 }),
	release_date: date(),
	lyrics_updated_at: timestamptz(),
	updated_by_human_at: timestamptz(),
	...timestamps
}, table => [
	index('genius_songs_primary_artist_id_idx').on(table.primary_artist_id),
	index('genius_songs_lyrics_owner_id_idx').on(table.lyrics_owner_id)
]);
export const genius_song_artists_table = pgTable('genius_song_artists_table', {
	song_id: bigint({ mode: 'number' }).notNull().references(() => genius_songs_table.id, { onDelete: 'cascade' }),
	artist_id: bigint({ mode: 'number' }).notNull().references(() => genius_artists_table.id, { onDelete: 'cascade' }),
	role: genius_artist_role().notNull(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.song_id, table.artist_id, table.role] }),
	index('genius_song_artists_artist_id_idx').on(table.artist_id)
]);
export const genius_referents_table = pgTable('genius_referents_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	song_id: bigint({ mode: 'number' }).notNull().references(() => genius_songs_table.id, { onDelete: 'cascade' }),
	annotator_id: bigint({ mode: 'number' }).references(() => genius_users_table.id, { onDelete: 'set null' }),
	fragment: text(),
	classification: varchar({ length: 32 }),
	path: varchar({ length: 256 }),
	is_image: boolean(),
	is_description: boolean(),
	...timestamps
}, table => [
	index('genius_referents_song_id_idx').on(table.song_id),
	index('genius_referents_annotator_id_idx').on(table.annotator_id)
]);
export const genius_annotations_table = pgTable('genius_annotations_table', {
	id: bigint({ mode: 'number' }).primaryKey(),
	referent_id: bigint({ mode: 'number' }).notNull().references(() => genius_referents_table.id, { onDelete: 'cascade' }),
	created_by_id: bigint({ mode: 'number' }).references(() => genius_users_table.id, { onDelete: 'set null' }),
	body_markdown: text(),
	state: varchar({ length: 32 }),
	verified: boolean(),
	community: boolean(),
	pinned: boolean(),
	votes_total: integer(),
	comment_count: integer(),
	genius_created_at: timestamptz(),
	...timestamps
}, table => [
	index('genius_annotations_referent_id_idx').on(table.referent_id),
	index('genius_annotations_created_by_id_idx').on(table.created_by_id)
]);

export const service_ids_table = pgTable('service_ids_table', {
	illusi_id: uuid().primaryKey().defaultRandom(),
	youtube_id: varchar({ length: 64 }).unique(),
	spotify_id: varchar({ length: 64 }).unique(),
	soundcloud_id: bigint({ mode: 'number' }).unique(),
	soundcloud_permalink: varchar({ length: 256 }).unique(),
	amazonmusic_id: varchar({ length: 32 }).unique(),
	applemusic_id: varchar({ length: 32 }).unique(),
	bandlab_id: varchar({ length: 64 }).unique(),
	audiomack_id: varchar({ length: 64 }).unique(),
	deezer_id: varchar({ length: 64 }).unique(),
	pandora_id: varchar({ length: 64 }).unique(),
	tidal_id: varchar({ length: 64 }).unique(),
	genius_id: bigint({ mode: 'number' }).unique(),
	isrc: varchar({ length: 12 }),
	...timestamps
}, table => [
	index('service_ids_isrc_idx').on(table.isrc),
	index('service_ids_modified_at_idx').on(table.modified_at)
]);

/**
 * Entities kept off every other service: enrichment never fills their ids, and reconcile neither fills them in a merge,
 * moves ids onto them, nor merges them into an unlocked entity. Set by hand; an artist whose name collides with others'
 * is the usual reason.
 */
export const service_links_locks_table = pgTable('service_links_locks_table', {
	illusi_id: uuid().primaryKey().references(() => service_ids_table.illusi_id, { onDelete: 'cascade' }),
	reason: text(),
	created_at: timestamptz().notNull().defaultNow()
});

export const illusi_id_redirects_table = pgTable('illusi_id_redirects_table', {
	old_id: uuid().primaryKey(),
	new_id: uuid().notNull().references(() => service_ids_table.illusi_id, { onDelete: 'cascade' }),
	created_at: timestamptz().notNull().defaultNow()
}, table => [
	index('illusi_id_redirects_new_id_idx').on(table.new_id),
	index('illusi_id_redirects_created_at_idx').on(table.created_at)
]);

export const service_id_conflicts_table = pgTable('service_id_conflicts_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	illusi_id: uuid().notNull().references(() => service_ids_table.illusi_id, { onDelete: 'cascade' }),
	column: varchar({ length: 64 }).notNull(),
	existing_value: varchar({ length: 512 }),
	incoming_value: varchar({ length: 512 }).notNull(),
	other_illusi_id: uuid().references(() => service_ids_table.illusi_id, { onDelete: 'cascade' }),
	source: varchar({ length: 32 }).notNull(),
	source_user_id: uuid(),
	source_token_jti: varchar({ length: 64 }),
	status: conflict_status().notNull().default('open'),
	...timestamps
}, table => [
	index('service_id_conflicts_illusi_id_idx').on(table.illusi_id),
	index('service_id_conflicts_other_illusi_id_idx').on(table.other_illusi_id),
	index('service_id_conflicts_status_idx').on(table.status)
]);

export const audit_log_table = pgTable('audit_log_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	action: varchar({ length: 32 }).notNull(),
	actor: varchar({ length: 32 }).notNull(),
	actor_user_id: uuid(),
	entity_table: varchar({ length: 64 }),
	entity_id: varchar({ length: 64 }),
	details: jsonb().notNull(),
	undo: jsonb(),
	created_at: timestamptz().notNull().defaultNow()
}, table => [index('audit_log_entity_idx').on(table.entity_table, table.entity_id)]);

export const thumbnails_table = pgTable('thumbnails_table', {
	id: uuid(),
	url: varchar({ length: 512 }).primaryKey(),
	width: integer(),
	height: integer()
}, table => [index('thumbnails_id_idx').on(table.id)]);

export const artists_table = pgTable('artists_table', {
	id: uuid().primaryKey().references(() => service_ids_table.illusi_id),
	name: varchar({ length: 256 }).notNull(),
	/** `name` folded for search (lowercase, no accents); stored so lookups don't re-fold every row. */
	search_name: text().notNull().generatedAlwaysAs((): SQL => sql`illusi_search_text(${artists_table.name})`),
	description: text(),
	primary_genre_name: varchar({ length: 80 }),
	...timestamps
}, table => [
	index('artists_modified_at_idx').on(table.modified_at),
	index('artists_name_key_idx').on(sql`illusi_name_key(${table.name})`),
	index('artists_search_name_trgm_idx').using('gin', table.search_name.op('gin_trgm_ops'))
]);
export const albums_table = pgTable('albums_table', {
	id: uuid().primaryKey().references(() => service_ids_table.illusi_id),
	artist_id: uuid().references(() => artists_table.id, { onDelete: 'set null' }),
	name: varchar({ length: 256 }).notNull(),
	search_name: text().notNull().generatedAlwaysAs((): SQL => sql`illusi_search_text(${albums_table.name})`),
	album_type: album_type(),
	release_date: timestamptz(),
	track_count: integer(),
	explicit: boolean(),
	...timestamps
}, table => [
	index('albums_artist_id_idx').on(table.artist_id),
	index('albums_modified_at_idx').on(table.modified_at),
	index('albums_release_date_idx').on(table.release_date),
	index('albums_name_key_idx').on(sql`illusi_name_key(${table.name})`),
	index('albums_search_name_trgm_idx').using('gin', table.search_name.op('gin_trgm_ops'))
]);
export const tracks_table = pgTable('tracks_table', {
	id: uuid().primaryKey().references(() => service_ids_table.illusi_id),
	title: varchar({ length: 256 }).notNull(),
	search_title: text().notNull().generatedAlwaysAs((): SQL => sql`illusi_search_text(${tracks_table.title})`),
	album_id: uuid().references(() => albums_table.id, { onDelete: 'set null' }),
	duration_ms: bigint({ mode: 'number' }),
	explicit: boolean(),
	imported: boolean().notNull().default(false),
	/** `<uuid>.jpg` under `MEDIA_DIR/artwork/`: an imported track's custom artwork, public at `GET /track_artwork/:artwork_id`. */
	artwork_id: varchar({ length: 64 }),
	/** Last-write-wins clock for `artwork_id`, separate from the track's other fields. */
	artwork_edited_at: timestamptz(),
	/** No client could play or download it; set by an unavailable report, cleared by media or a research result. */
	backpacked: boolean().notNull().default(false),
	backpacked_at: timestamptz(),
	...timestamps
}, table => [
	index('tracks_album_id_idx').on(table.album_id),
	index('tracks_modified_at_idx').on(table.modified_at),
	index('tracks_backpacked_at_idx').on(table.backpacked_at).where(sql`${table.backpacked}`),
	index('tracks_artwork_id_idx').on(table.artwork_id).where(sql`${table.artwork_id} is not null`),
	index('tracks_search_title_trgm_idx').using('gin', table.search_title.op('gin_trgm_ops'))
]);
export const tracks_artists_table = pgTable('tracks_artists_table', {
	artist_id: uuid().notNull().references(() => artists_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	...timestamps
}, table => [
	primaryKey({ columns: [table.artist_id, table.track_id] }),
	index('tracks_artists_track_id_idx').on(table.track_id)
]);
export const tracks_producers_table = pgTable('tracks_producers_table', {
	producer_id: bigint({ mode: 'number' }).notNull().references(() => genius_artists_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	...timestamps
}, table => [
	primaryKey({ columns: [table.producer_id, table.track_id] }),
	index('tracks_producers_track_id_idx').on(table.track_id)
]);

export const media_table = pgTable('media_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	resource_id: varchar({ length: 256 }).notNull(),
	quality: varchar({ length: 32 }),
	content_hash: varchar({ length: 64 }).notNull(),
	uploaded_by: uuid(),
	...timestamps
}, table => [
	uniqueIndex('media_track_id_resource_id_idx').on(table.track_id, table.resource_id),
	uniqueIndex('media_track_id_content_hash_idx').on(table.track_id, table.content_hash),
	index('media_resource_id_idx').on(table.resource_id)
]);

export const track_sample_data_table = pgTable('track_sample_data_table', {
	id: uuid().primaryKey().references(() => tracks_table.id, { onDelete: 'cascade' }),
	mood: varchar({ length: 50 }).notNull(),
	tempo: real().notNull(),
	brightness: real().notNull(),
	key: varchar({ length: 5 }).notNull(),
	acousticness: real().notNull(),
	instrumentalness: real().notNull(),
	liveness: real().notNull(),
	danceability: real().notNull(),
	arousal: real().notNull(),
	valence: real().notNull(),
	speechiness: real().notNull(),
	/** What the analyzer returned when this row was written (`SAMPLE_VERSION`); older rows are analyzed again. */
	version: integer().notNull().default(1),
	// The rest of Mood-Detector's features, on its 30 s excerpt; null on rows from before they were kept
	tempo_confidence: real(),
	rms_energy: real(),
	/** Hz */
	spectral_rolloff: real(),
	zero_crossing_rate: real(),
	/** 13 mean MFCCs */
	mfccs: real().array(),
	/** 12 mean chroma bins, C to B */
	chroma: real().array(),
	/** Similarity (0-1) to Mood-Detector's reference styles */
	mood_scores: jsonb().$type<Record<string, number>>(),
	/** Length of the analyzed file (an iTunes preview is ~30 s) */
	source_duration_ms: integer(),
	...timestamps
}, table => [index('track_sample_data_modified_at_idx').on(table.modified_at)]);

export const track_sample_lookups_table = pgTable('track_sample_lookups_table', {
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	source: sample_source().notNull(),
	status: sample_lookup_status().notNull(),
	attempts: integer().notNull().default(0),
	attempted_at: timestamptz().notNull().defaultNow(),
	retry_after: timestamptz(),
	/** What the source was when it failed (preview_url / media resource_id), so a changed source resets BAD_FILE / NOT_FOUND. */
	source_ref: varchar({ length: 512 })
}, table => [primaryKey({ columns: [table.track_id, table.source] })]);

/**
 * Vocal activity of a track's newest media file (the analyzer's `/vocals`; never run on iTunes previews). The row is
 * also the lookup record: only DONE rows carry results, and a newer upload makes the track eligible again.
 */
export const track_vocals_table = pgTable('track_vocals_table', {
	track_id: uuid().primaryKey().references(() => tracks_table.id, { onDelete: 'cascade' }),
	/** The media file that was analyzed (or failed). */
	resource_id: varchar({ length: 256 }).notNull(),
	status: sample_lookup_status().notNull(),
	attempts: integer().notNull().default(0),
	attempted_at: timestamptz().notNull().defaultNow(),
	retry_after: timestamptz(),
	model: varchar({ length: 128 }),
	hop_ms: integer(),
	window_ms: integer(),
	duration_ms: integer(),
	/** Voice probability (0-1) of window i, `[i * hop_ms, i * hop_ms + window_ms)`. */
	voice: real().array(),
	/** Voiced spans, flat: `[start_ms, end_ms, start_ms, end_ms, ...]`. */
	segments: integer().array(),
	/** Beat tracking over the same file; null on rows from before it ran, empty when no beat was found. */
	rhythm_model: varchar({ length: 128 }),
	rhythm_bpm: real(),
	/** Essentia's multifeature confidence, 0 to ~5.32 */
	rhythm_confidence: real(),
	beats: integer().array(),
	bpm_estimates: real().array(),
	/** Whisper's words over the same file, for lining up lyrics; null on rows from before it ran, empty when none was heard. */
	words_model: varchar({ length: 128 }),
	words: text().array(),
	/** Flat `[start_ms, end_ms, start_ms, end_ms, ...]`, one pair per word. */
	word_times: integer().array(),
	word_probabilities: real().array(),
	/** Silero's voice probability (0-1) of frame i, `[i * speech_hop_ms, (i + 1) * speech_hop_ms)`. */
	speech_model: varchar({ length: 128 }),
	speech_hop_ms: integer(),
	speech: real().array(),
	/** Beat This! beats and downbeats, which follow tempo changes (unlike `beats`). */
	beat_grid_model: varchar({ length: 128 }),
	grid_beats: integer().array(),
	downbeats: integer().array(),
	...timestamps
});

/**
 * What the app aligns a track's plain lyrics against (`POST /alignment` on its media file): the separated vocals'
 * letter probabilities, loudness, words, beat grid and repeats. Never a synced version; the app builds that and keeps
 * it to itself. Only analyzed for tracks users play whose lyrics are all unsynced.
 */
export const track_alignment_table = pgTable('track_alignment_table', {
	track_id: uuid().primaryKey().references(() => tracks_table.id, { onDelete: 'cascade' }),
	/** The media file that was analyzed (or failed). */
	resource_id: varchar({ length: 256 }).notNull(),
	status: sample_lookup_status().notNull(),
	attempts: integer().notNull().default(0),
	attempted_at: timestamptz().notNull().defaultNow(),
	retry_after: timestamptz(),
	model: varchar({ length: 128 }),
	duration_ms: integer(),
	frame_ms: doublePrecision(),
	/** CTC labels, blank first; each frame of `letters` has one byte per label. */
	alphabet: varchar({ length: 64 }),
	letter_scale: real(),
	/** Frame-major bytes, `round(-log p * letter_scale)` capped at 255. */
	letters: bytea(),
	/** One byte per frame: `round(127.5 * sqrt(min(4, rms / p90)))` of the vocals stem. */
	loudness: bytea(),
	/** Whisper's words on the vocals stem. */
	words_model: varchar({ length: 128 }),
	words: text().array(),
	/** Flat `[start_ms, end_ms, start_ms, end_ms, ...]`, one pair per word. */
	word_times: integer().array(),
	word_probabilities: real().array(),
	/** Beat This! on the drums stem. */
	beat_grid_model: varchar({ length: 128 }),
	grid_beats: integer().array(),
	downbeats: integer().array(),
	/** Vocal passages sung again, flat `[start_ms, end_ms, lag_ms, ...]`. */
	repeats: integer().array(),
	repeat_strengths: real().array(),
	...timestamps
});

/** Dimensions of `track_vectors_table.embedding`. Must match the encoding in the vector service. */
export const TRACK_VECTOR_DIMENSIONS = 40;

export const track_vectors_table = pgTable('track_vectors_table', {
	track_id: uuid().primaryKey().references(() => tracks_table.id, { onDelete: 'cascade' }),
	embedding: vector({ dimensions: TRACK_VECTOR_DIMENSIONS }).notNull(),
	version: integer().notNull(),
	...timestamps
}, table => [index('track_vectors_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops'))]);

export const itunes_lookups_table = pgTable('itunes_lookups_table', {
	illusi_id: uuid().primaryKey().references(() => service_ids_table.illusi_id, { onDelete: 'cascade' }),
	entity_type: itunes_entity_type().notNull(),
	status: itunes_lookup_status().notNull(),
	attempts: integer().notNull().default(0),
	attempted_at: timestamptz().notNull().defaultNow(),
	retry_after: timestamptz()
});

export const track_lyrics_table = pgTable('track_lyrics_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	service: lyrics_services().notNull(),
	sync_type: lyrics_sync_type().notNull(),
	format: lyrics_format().notNull(),
	raw_content: text().notNull(),
	/** SHA-256 hex of the exact `raw_content`. */
	content_hash: varchar({ length: 64 }).notNull(),
	/** Disposable parse result; cleared whenever `parser_version` no longer matches the current parser. */
	parsed_cache: jsonb(),
	parser_version: integer(),
	source_user_id: uuid(),
	source_token_jti: varchar({ length: 64 }),
	...timestamps
}, table => [
	index('track_lyrics_track_id_idx').on(table.track_id),
	uniqueIndex('track_lyrics_track_id_content_hash_idx').on(table.track_id, table.content_hash),
	index('track_lyrics_modified_at_idx').on(table.modified_at)
]);

export const track_lyrics_lookups_table = pgTable('track_lyrics_lookups_table', {
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	service: lyrics_services().notNull(),
	status: lyrics_lookup_status().notNull(),
	attempts: integer().notNull().default(1),
	attempted_at: timestamptz().notNull().defaultNow(),
	retry_after: timestamptz(),
	source_user_id: uuid()
}, table => [primaryKey({ columns: [table.track_id, table.service] })]);

export const users_table = pgTable('users_table', {
	id: uuid().primaryKey().defaultRandom(),
	username: varchar({ length: 64 }).notNull(),
	email: varchar({ length: 256 }).notNull().unique(),
	password_hash: varchar({ length: 255 }).notNull(),
	role: user_role().notNull().default('USER'),
	/** Null until the user follows the link emailed to them; unverified users can sign in but only reach `/auth`. */
	email_verified_at: timestamptz(),
	edited_at: timestamptz(),
	/** `<uuid>.webp` in MEDIA_DIR/avatars, set with `PUT /me/avatar`. Null for none. */
	avatar_id: varchar({ length: 64 }),
	/** Whether other users can list the tracks this user imported (`GET /users/:id/imports`). */
	public_imports: boolean().notNull().default(false),
	/** The /24 (IPv4) or /48 (IPv6) the account signed up from; consensus counts one vote per prefix. Null for older accounts. */
	signup_ip_prefix: varchar({ length: 64 }),
	/** When `user_inherited_tracks_table` was last recomputed for this user. */
	inherited_scope_at: timestamptz(),
	...timestamps
}, table => [check('users_email_lowercase_check', sql`${table.email} = lower(${table.email})`)]);

/** Password reset codes (6 digits, emailed); only an HMAC of the code is stored. */
export const password_resets_table = pgTable('password_resets_table', {
	id: uuid().primaryKey().defaultRandom(),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	code_hash: varchar({ length: 64 }).notNull(),
	attempts: integer().notNull().default(0),
	expires_at: timestamptz().notNull(),
	used_at: timestamptz(),
	created_at: timestamptz().notNull().defaultNow()
}, table => [index('password_resets_user_id_idx').on(table.user_id)]);

/**
 * Tracks a user reaches only through playlist inheritance, as of `users_table.inherited_scope_at`. `created_at` is when
 * a track entered that set, so a pull can send tracks that became part of the user's scope without changing themselves.
 */
export const user_inherited_tracks_table = pgTable('user_inherited_tracks_table', {
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	created_at: timestamptz().notNull().defaultNow()
}, table => [
	primaryKey({ columns: [table.user_id, table.track_id] }),
	index('user_inherited_tracks_created_at_idx').on(table.user_id, table.created_at)
]);

/** Fixed-window request counters shared by every API process (the migration makes the table UNLOGGED). */
export const rate_limit_counters_table = pgTable('rate_limit_counters_table', {
	key: varchar({ length: 256 }).notNull(),
	window_start: timestamptz().notNull(),
	count: integer().notNull().default(0)
}, table => [
	primaryKey({ columns: [table.key, table.window_start] }),
	index('rate_limit_counters_window_start_idx').on(table.window_start)
]);

/** One-time email confirmation links; only the sha256 of the token is stored. */
export const email_verifications_table = pgTable('email_verifications_table', {
	id: uuid().primaryKey().defaultRandom(),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	/** The address the link was sent to; verification only counts while it still equals the account email. */
	email: varchar({ length: 256 }).notNull(),
	token_hash: varchar({ length: 64 }).notNull().unique(),
	expires_at: timestamptz().notNull(),
	used_at: timestamptz(),
	created_at: timestamptz().notNull().defaultNow()
}, table => [index('email_verifications_user_id_idx').on(table.user_id)]);

export const sessions_table = pgTable('sessions_table', {
	id: uuid().primaryKey().defaultRandom(),
	/** The login this session row descends from. Access/action tokens carry it as `sid`, so it survives rotation. */
	family_id: uuid().notNull(),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	token_hash: varchar({ length: 64 }).notNull().unique(),
	device_name: varchar({ length: 128 }),
	created_at: timestamptz().notNull().defaultNow(),
	last_used_at: timestamptz(),
	expires_at: timestamptz().notNull(),
	revoked_at: timestamptz(),
	replaced_by: uuid()
}, table => [
	index('sessions_user_id_idx').on(table.user_id),
	index('sessions_family_id_idx').on(table.family_id)
]);

/** Single-use `jti`s of action tokens. Rows can be purged after `expires_at`. */
export const action_token_uses_table = pgTable('action_token_uses_table', {
	jti: varchar({ length: 64 }).primaryKey(),
	user_id: uuid().notNull(),
	type: varchar({ length: 32 }).notNull(),
	target: varchar({ length: 64 }).notNull(),
	used_at: timestamptz().notNull().defaultNow(),
	expires_at: timestamptz().notNull()
}, table => [index('action_token_uses_expires_at_idx').on(table.expires_at)]);
export const user_tracks_table = pgTable('user_tracks_table', {
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	title: varchar({ length: 256 }),
	/** The user's own credits for the track in place of the catalog's; null keeps the catalog's */
	artist_ids: uuid().array(),
	album_id: uuid().references(() => albums_table.id, { onDelete: 'set null' }),
	downloaded_at: timestamptz(),
	start_at: bigint({ mode: 'number' }),
	end_at: bigint({ mode: 'number' }),
	deleted: boolean().notNull().default(false),
	edited_at: timestamptz(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.user_id, table.track_id] }),
	index('user_tracks_track_id_idx').on(table.track_id),
	index('user_tracks_user_id_modified_at_idx').on(table.user_id, table.modified_at)
]);
/**
 * Which device has which track downloaded. A device is a login (the session family, `sid` on its tokens), so only it
 * is asked to upload the file; logging out forgets its rows. `user_tracks_table.downloaded_at` stays the user-wide
 * "downloaded on some device" date the library shows.
 */
export const track_downloads_table = pgTable('track_downloads_table', {
	session_family_id: uuid().notNull(),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	downloaded_at: timestamptz().notNull(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.session_family_id, table.track_id] }),
	index('track_downloads_track_id_idx').on(table.track_id),
	index('track_downloads_user_id_idx').on(table.user_id)
]);
export const user_recent_searches = pgTable('user_recent_searches', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	user_id: uuid().references(() => users_table.id, { onDelete: 'cascade' }),
	text: varchar({ length: 128 }),
	/** Unique per user: two users' devices may derive the same id (e.g. from the search text) */
	client_id: uuid(),
	created_at: timestamptz().notNull().defaultNow()
}, table => [index('user_recent_searches_user_id_idx').on(table.user_id), uniqueIndex('user_recent_searches_user_id_client_id_idx').on(table.user_id, table.client_id)]);

export const track_plays_table = pgTable('track_plays_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	/** Unique per user, like user_recent_searches.client_id */
	client_id: uuid(),
	created_at: timestamptz().notNull().defaultNow()
}, table => [
	uniqueIndex('track_plays_user_id_client_id_idx').on(table.user_id, table.client_id),
	index('track_plays_user_id_track_id_idx').on(table.user_id, table.track_id),
	index('track_plays_user_id_created_at_idx').on(table.user_id, table.created_at.desc().nullsFirst(), table.id.desc().nullsFirst()),
	index('track_plays_track_id_idx').on(table.track_id)
]);

/** Total plays per track over every user, kept by triggers on `track_plays_table` (inserts, deletes and merges). */
export const track_play_counts_table = pgTable('track_play_counts_table', {
	track_id: uuid().primaryKey().references(() => tracks_table.id, { onDelete: 'cascade' }),
	plays: bigint({ mode: 'number' }).notNull().default(0)
}, table => [check('track_play_counts_plays_check', sql`${table.plays} >= 0`)]);

/**
 * Change counters for read-API validators (ETags). `catalog` moves when any catalog row a view is built from
 * changes, `plays` when play totals change; bumped by deferred triggers at commit.
 */
export const read_versions_table = pgTable('read_versions_table', {
	key: varchar({ length: 32 }).primaryKey(),
	version: bigint({ mode: 'number' }).notNull().default(0)
});

/** Per-user change counter for the library overlay in read-API views (library rows and plays). */
export const user_read_versions_table = pgTable('user_read_versions_table', {
	user_id: uuid().primaryKey().references(() => users_table.id, { onDelete: 'cascade' }),
	version: bigint({ mode: 'number' }).notNull().default(0)
});

export const linked_playlists_table = pgTable('linked_playlists_table', {
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	service_uri: varchar({ length: 256 }).notNull(),
	deleted: boolean().notNull().default(false),
	edited_at: timestamptz(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.user_id, table.service_uri] }),
	index('linked_playlists_user_id_modified_at_idx').on(table.user_id, table.modified_at)
]);

export const playlists_table = pgTable('playlists_table', {
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	id: uuid().primaryKey().defaultRandom(),
	title: varchar({ length: 64 }).notNull(),
	description: varchar({ length: 512 }),
	pinned: boolean().notNull().default(false),
	archived: boolean().notNull().default(false),
	public: boolean().notNull().default(false),
	sort_mode: sort_type().notNull().default('OLDEST'),
	deleted: boolean().notNull().default(false),
	edited_at: timestamptz(),
	/** `<uuid>.jpg` under `MEDIA_DIR/artwork/`; set only by the artwork endpoints, never by sync push. */
	artwork_id: varchar({ length: 64 }),
	/** Last-write-wins clock for `artwork_id`, separate from `edited_at` so artwork and row edits don't overwrite each other. */
	artwork_edited_at: timestamptz(),
	...timestamps
}, table => [
	index('playlists_user_id_idx').on(table.user_id),
	index('playlists_user_id_modified_at_idx').on(table.user_id, table.modified_at),
	index('playlists_artwork_id_idx').on(table.artwork_id).where(sql`${table.artwork_id} is not null`),
	index('playlists_search_trgm_idx').using('gin', sql`illusi_search_text(${table.title}) gin_trgm_ops`)
]);
export const playlist_inherited_searches_table = pgTable('playlist_inherited_searches_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	playlist_id: uuid().notNull().references(() => playlists_table.id, { onDelete: 'cascade' }),
	query: varchar({ length: 256 }),
	mode: inheritance_mode(),
	deleted: boolean().notNull().default(false),
	edited_at: timestamptz(),
	...timestamps
}, table => [index('playlist_inherited_searches_playlist_id_idx').on(table.playlist_id)]);
export const playlist_inherited_playlists_table = pgTable('playlist_inherited_playlists_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	playlist_id: uuid().notNull().references(() => playlists_table.id, { onDelete: 'cascade' }),
	ref_id: uuid().notNull().references(() => playlists_table.id, { onDelete: 'cascade' }),
	mode: inheritance_mode(),
	deleted: boolean().notNull().default(false),
	edited_at: timestamptz(),
	...timestamps
}, table => [
	index('playlist_inherited_playlists_playlist_id_idx').on(table.playlist_id),
	index('playlist_inherited_playlists_ref_id_idx').on(table.ref_id),
	check('playlist_inherited_playlists_distinct_check', sql`${table.playlist_id} <> ${table.ref_id}`)
]);
export const playlist_tracks_table = pgTable('playlist_tracks_table', {
	playlist_id: uuid().notNull().references(() => playlists_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	deleted: boolean().notNull().default(false),
	edited_at: timestamptz(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.playlist_id, table.track_id] }),
	index('playlist_tracks_modified_at_idx').on(table.modified_at),
	index('playlist_tracks_track_id_idx').on(table.track_id)
]);

export const album_tracks_table = pgTable('album_tracks_table', {
	album_id: uuid().notNull().references(() => albums_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	track_number: integer(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.album_id, table.track_id] }),
	index('album_tracks_track_id_idx').on(table.track_id)
]);
export const artist_albums_table = pgTable('artist_albums_table', {
	artist_id: uuid().notNull().references(() => artists_table.id, { onDelete: 'cascade' }),
	album_id: uuid().notNull().references(() => albums_table.id, { onDelete: 'cascade' }),
	position: integer(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.artist_id, table.album_id] }),
	index('artist_albums_album_id_idx').on(table.album_id)
]);
export const similar_artists_table = pgTable('similar_artists_table', {
	artist_id: uuid().notNull().references(() => artists_table.id, { onDelete: 'cascade' }),
	similar_artist_id: uuid().notNull().references(() => artists_table.id, { onDelete: 'cascade' }),
	...timestamps
}, table => [
	primaryKey({ columns: [table.artist_id, table.similar_artist_id] }),
	index('similar_artists_similar_artist_id_idx').on(table.similar_artist_id),
	check('similar_artists_distinct_check', sql`${table.artist_id} <> ${table.similar_artist_id}`)
]);

export const contributions_log_table = pgTable('contributions_log_table', {
	id: uuid().primaryKey().defaultRandom(),
	/** Client UUID for `/contribute` (idempotency key). Null for ingests that have none. */
	contribution_id: uuid().unique(),
	/** Null once the contributor deleted their account: what they contributed stays in the catalog. */
	user_id: uuid().references(() => users_table.id, { onDelete: 'set null' }),
	source: provenance_source().notNull(),
	token_jti: varchar({ length: 64 }),
	/** `[{ table, id, filled: string[] }]`: every entity touched and the fields it filled. */
	entities: jsonb().notNull().default([]),
	/** The response that was returned, replayed if the same `contribution_id` is retried. */
	response: jsonb(),
	received_at: timestamptz().notNull().defaultNow()
}, table => [index('contributions_log_user_id_idx').on(table.user_id, table.received_at)]);

export const EXPORT_STATUSES = ['PENDING', 'RUNNING', 'READY', 'FAILED', 'EXPIRED'] as const;
export const export_status = pgEnum('export_status', EXPORT_STATUSES);

/** Data export jobs (`POST /me/export`): generated in the background, the file lives until `expires_at`. */
export const export_jobs_table = pgTable('export_jobs_table', {
	id: uuid().primaryKey().defaultRandom(),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	status: export_status().notNull().default('PENDING'),
	/** File name under `MEDIA_DIR/.exports/` once ready. */
	file_name: varchar({ length: 64 }),
	size: bigint({ mode: 'number' }),
	error: varchar({ length: 256 }),
	created_at: timestamptz().notNull().defaultNow(),
	started_at: timestamptz(),
	finished_at: timestamptz(),
	expires_at: timestamptz()
}, table => [
	index('export_jobs_user_id_created_at_idx').on(table.user_id, table.created_at),
	index('export_jobs_status_idx').on(table.status)
]);

/** Idempotency for `/sync/push`: a retried `push_id` replays the stored response. */
export const sync_pushes_table = pgTable('sync_pushes_table', {
	push_id: uuid().primaryKey(),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	response: jsonb().notNull(),
	created_at: timestamptz().notNull().defaultNow()
}, table => [index('sync_pushes_user_id_idx').on(table.user_id)]);

export const review_items_table = pgTable('review_items_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	kind: review_kind().notNull(),
	entity_table: varchar({ length: 64 }).notNull(),
	entity_id: varchar({ length: 64 }).notNull(),
	field: varchar({ length: 64 }),
	current_value: jsonb(),
	/** `[{ value, source_user_ids, occurrences, plan?, evidence? }]` */
	proposed_values: jsonb().notNull().default([]),
	source_user_ids: uuid().array().notNull().default(sql`'{}'::uuid[]`),
	occurrences: integer().notNull().default(1),
	/** Free-form context (plan, evidence, error message) for the reviewer. */
	details: jsonb(),
	/** Dedup key: hash of (kind, entity_table, entity_id, field, proposed value). */
	dedupe_key: varchar({ length: 64 }).notNull(),
	status: review_status().notNull().default('OPEN'),
	resolved_by: uuid().references(() => users_table.id, { onDelete: 'set null' }),
	resolved_at: timestamptz(),
	...timestamps
}, table => [
	uniqueIndex('review_items_dedupe_key_open_idx').on(table.dedupe_key).where(sql`${table.status} = 'OPEN'`),
	index('review_items_status_kind_idx').on(table.status, table.kind),
	index('review_items_entity_idx').on(table.entity_table, table.entity_id)
]);

/** When each library artist was last checked for new releases on a client-side service. */
export const artist_release_checks_table = pgTable('artist_release_checks_table', {
	artist_id: uuid().notNull().references(() => artists_table.id, { onDelete: 'cascade' }),
	service: varchar({ length: 32 }).notNull(),
	/** Last time a FETCH_NEW_RELEASES action was handed out, so the same check isn't requested on every load. */
	requested_at: timestamptz(),
	checked_at: timestamptz(),
	checked_by: uuid().references(() => users_table.id, { onDelete: 'set null' }),
	...timestamps
}, table => [primaryKey({ columns: [table.artist_id, table.service] })]);

/** Services a backpacked track can be researched on: the ones clients download from. */
export const RESEARCH_SERVICES = ['youtube', 'soundcloud', 'bandlab', 'audiomack'] as const;
export const RESEARCH_STATUSES = ['PENDING', 'FOUND', 'NOT_FOUND'] as const;
export const research_status = pgEnum('research_status', RESEARCH_STATUSES);

/** One row per user and service that reported a track unplayable. */
export const track_unavailable_reports_table = pgTable('track_unavailable_reports_table', {
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	service: varchar({ length: 32 }).notNull(),
	reason: varchar({ length: 256 }),
	...timestamps
}, table => [primaryKey({ columns: [table.track_id, table.user_id, table.service] })]);

export const DURATION_REPORT_SOURCES = ['download', 'service'] as const;
/** A user's measured length of a track: the audio file they downloaded, or what a streaming service reported. One per user and track. */
export const track_duration_reports_table = pgTable('track_duration_reports_table', {
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	duration_ms: integer().notNull(),
	source: varchar({ length: 16 }).notNull(),
	/** Where the file or metadata came from (youtube, soundcloud, ...). */
	service: varchar({ length: 32 }),
	...timestamps
}, table => [primaryKey({ columns: [table.track_id, table.user_id] })]);

/** RESEARCH_TRACK progress for a backpacked track on one service. */
export const track_research_table = pgTable('track_research_table', {
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	service: varchar({ length: 32 }).notNull(),
	status: research_status().notNull().default('PENDING'),
	/** Last time a RESEARCH_TRACK action was handed out for this pair. */
	requested_at: timestamptz(),
	checked_at: timestamptz(),
	checked_by: uuid().references(() => users_table.id, { onDelete: 'set null' }),
	/** The id a client found, kept even when it couldn't be applied (conflict). */
	found_value: varchar({ length: 512 }),
	...timestamps
}, table => [primaryKey({ columns: [table.track_id, table.service] })]);

/** Streaming services whose catalog objects clients ingest as-is (YouTube and YouTube Music are too irregular to store). */
export const CATALOG_SERVICES = ['spotify', 'applemusic', 'amazonmusic', 'deezer', 'tidal', 'pandora', 'bandlab', 'audiomack'] as const;
export type CatalogService = typeof CATALOG_SERVICES[number];
export const catalog_service = pgEnum('catalog_service', CATALOG_SERVICES);

/** Artists as a service shows them; `illusi_id` is set once a global artist carries the same service id. */
export const service_artists_table = pgTable('service_artists_table', {
	service: catalog_service().notNull(),
	external_id: varchar({ length: 256 }).notNull(),
	illusi_id: uuid().references(() => artists_table.id, { onDelete: 'set null' }),
	name: varchar({ length: 1024 }).notNull(),
	artwork_url: varchar({ length: 1024 }),
	verified: boolean(),
	description: text(),
	followers_count: bigint({ mode: 'number' }),
	raw: jsonb(),
	last_seen_at: timestamptz().notNull().defaultNow(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.service, table.external_id] }),
	index('service_artists_illusi_id_idx').on(table.illusi_id)
]);

export const service_albums_table = pgTable('service_albums_table', {
	service: catalog_service().notNull(),
	external_id: varchar({ length: 256 }).notNull(),
	illusi_id: uuid().references(() => albums_table.id, { onDelete: 'set null' }),
	title: varchar({ length: 1024 }).notNull(),
	artist_names: text().array(),
	artist_external_ids: text().array(),
	album_type: varchar({ length: 32 }),
	release_date: timestamptz(),
	explicit: boolean(),
	track_count: integer(),
	artwork_url: varchar({ length: 1024 }),
	raw: jsonb(),
	last_seen_at: timestamptz().notNull().defaultNow(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.service, table.external_id] }),
	index('service_albums_illusi_id_idx').on(table.illusi_id)
]);

export const service_tracks_table = pgTable('service_tracks_table', {
	service: catalog_service().notNull(),
	external_id: varchar({ length: 256 }).notNull(),
	illusi_id: uuid().references(() => tracks_table.id, { onDelete: 'set null' }),
	title: varchar({ length: 1024 }).notNull(),
	alt_title: varchar({ length: 1024 }),
	artist_names: text().array(),
	artist_external_ids: text().array(),
	album_title: varchar({ length: 1024 }),
	album_external_id: varchar({ length: 256 }),
	duration_ms: integer(),
	explicit: boolean(),
	plays: bigint({ mode: 'number' }),
	isrc: varchar({ length: 12 }),
	artwork_url: varchar({ length: 1024 }),
	raw: jsonb(),
	last_seen_at: timestamptz().notNull().defaultNow(),
	...timestamps
}, table => [
	primaryKey({ columns: [table.service, table.external_id] }),
	index('service_tracks_illusi_id_idx').on(table.illusi_id),
	index('service_tracks_isrc_idx').on(table.isrc)
]);
