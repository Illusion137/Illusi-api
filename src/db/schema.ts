import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, doublePrecision, index, integer, pgEnum, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

const ITUNES_EXPLICITNESS = ['explicit', 'cleaned', 'notExplicit'] as const;
export const itunes_explicitness = pgEnum('itunes_explicitness', ITUNES_EXPLICITNESS);

const LYRICS_SERVICES = ['GOLYRICS', 'BINILYRICS', 'MUSIXMATCH', 'LRCLIB', 'YOUTUBE_MUSIC', 'GENIUS'] as const;
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
}, table => [index('soundcloud_tracks_user_id_idx').on(table.user_id)]);
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
	...timestamps
});

export const thumbnails_table = pgTable('thumbnails_table', {
	id: uuid(),
	url: varchar({ length: 512 }).primaryKey(),
	width: integer(),
	height: integer()
}, table => [index('thumbnails_id_idx').on(table.id)]);

export const artists_table = pgTable('artists_table', {
	id: uuid().primaryKey().references(() => service_ids_table.illusi_id),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	primary_genre_name: varchar({ length: 80 }),
	...timestamps
});
export const albums_table = pgTable('albums_table', {
	id: uuid().primaryKey().references(() => service_ids_table.illusi_id),
	artist_id: uuid().references(() => artists_table.id, { onDelete: 'set null' }),
	name: varchar({ length: 256 }).notNull(),
	album_type: album_type(),
	release_date: timestamptz(),
	track_count: integer(),
	explicit: boolean(),
	...timestamps
}, table => [index('albums_artist_id_idx').on(table.artist_id)]);
export const tracks_table = pgTable('tracks_table', {
	id: uuid().primaryKey().defaultRandom(),
	title: varchar({ length: 256 }).notNull(),
	album_id: uuid().references(() => albums_table.id, { onDelete: 'set null' }),
	duration_ms: bigint({ mode: 'number' }),
	explicit: boolean(),
	imported: boolean().notNull().default(false),
	backpacked: boolean().notNull().default(false),
	...timestamps
}, table => [index('tracks_album_id_idx').on(table.album_id)]);
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
	...timestamps
}, table => [
	uniqueIndex('media_track_id_resource_id_idx').on(table.track_id, table.resource_id),
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
	...timestamps
});

export const track_lyrics_table = pgTable('track_lyrics_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	service: lyrics_services().notNull(),
	sync_type: lyrics_sync_type().notNull(),
	raw_content: text().notNull(),
	...timestamps
}, table => [index('track_lyrics_track_id_idx').on(table.track_id)]);

export const users_table = pgTable('users_table', {
	id: uuid().primaryKey().defaultRandom(),
	username: varchar({ length: 64 }).notNull(),
	email: varchar({ length: 256 }).notNull().unique(),
	password_hash: varchar({ length: 255 }).notNull(),
	...timestamps
}, table => [check('users_email_lowercase_check', sql`${table.email} = lower(${table.email})`)]);
export const user_tracks_table = pgTable('user_tracks_table', {
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	title: varchar({ length: 256 }),
	downloaded_at: timestamptz(),
	start_at: bigint({ mode: 'number' }),
	end_at: bigint({ mode: 'number' }),
	deleted: boolean().notNull().default(false),
	...timestamps
}, table => [
	primaryKey({ columns: [table.user_id, table.track_id] }),
	index('user_tracks_track_id_idx').on(table.track_id)
]);
export const user_recent_searches = pgTable('user_recent_searches', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	user_id: uuid().references(() => users_table.id, { onDelete: 'cascade' }),
	text: varchar({ length: 128 }),
	created_at: timestamptz().notNull().defaultNow()
}, table => [index('user_recent_searches_user_id_idx').on(table.user_id)]);

export const track_plays_table = pgTable('track_plays_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	track_id: uuid().notNull().references(() => tracks_table.id, { onDelete: 'cascade' }),
	created_at: timestamptz().notNull().defaultNow()
}, table => [
	index('track_plays_user_id_idx').on(table.user_id),
	index('track_plays_track_id_idx').on(table.track_id)
]);

export const linked_playlists_table = pgTable('linked_playlists_table', {
	user_id: uuid().notNull().references(() => users_table.id, { onDelete: 'cascade' }),
	service_uri: varchar({ length: 256 }).notNull(),
	deleted: boolean().notNull().default(false),
	...timestamps
}, table => [primaryKey({ columns: [table.user_id, table.service_uri] })]);

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
	...timestamps
}, table => [index('playlists_user_id_idx').on(table.user_id)]);
export const playlist_inherited_searches_table = pgTable('playlist_inherited_searches_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	playlist_id: uuid().notNull().references(() => playlists_table.id, { onDelete: 'cascade' }),
	query: varchar({ length: 256 }),
	mode: inheritance_mode(),
	deleted: boolean().notNull().default(false),
	...timestamps
}, table => [index('playlist_inherited_searches_playlist_id_idx').on(table.playlist_id)]);
export const playlist_inherited_playlists_table = pgTable('playlist_inherited_playlists_table', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	playlist_id: uuid().notNull().references(() => playlists_table.id, { onDelete: 'cascade' }),
	ref_id: uuid().notNull().references(() => playlists_table.id, { onDelete: 'cascade' }),
	mode: inheritance_mode(),
	deleted: boolean().notNull().default(false),
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
	...timestamps
}, table => [
	primaryKey({ columns: [table.playlist_id, table.track_id] }),
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
