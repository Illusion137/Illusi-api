CREATE TYPE "album_type" AS ENUM('SINGLE', 'ALBUM', 'EP');--> statement-breakpoint
CREATE TYPE "conflict_status" AS ENUM('open', 'deferred', 'merged', 'split', 'dismissed');--> statement-breakpoint
CREATE TYPE "genius_artist_role" AS ENUM('PRIMARY', 'FEATURED', 'PRODUCER', 'WRITER');--> statement-breakpoint
CREATE TYPE "inheritance_mode" AS ENUM('INCLUDE', 'EXCLUDE', 'MASK', 'INTERSECTION');--> statement-breakpoint
CREATE TYPE "itunes_entity_type" AS ENUM('track', 'album', 'artist');--> statement-breakpoint
CREATE TYPE "itunes_explicitness" AS ENUM('explicit', 'cleaned', 'notExplicit');--> statement-breakpoint
CREATE TYPE "itunes_lookup_status" AS ENUM('FOUND', 'NOT_FOUND', 'ERROR');--> statement-breakpoint
CREATE TYPE "lyrics_format" AS ENUM('TTML', 'MXM_RICHSYNC_JSON', 'LRC', 'ELRC', 'PLAIN', 'GENIUS_BODY_JSON', 'YTM_JSON');--> statement-breakpoint
CREATE TYPE "lyrics_lookup_status" AS ENUM('FOUND', 'NOT_FOUND', 'INSTRUMENTAL', 'ERROR', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "lyrics_services" AS ENUM('GOLYRICS', 'BINILYRICS', 'MUSIXMATCH', 'LRCLIB', 'YOUTUBE_MUSIC', 'GENIUS');--> statement-breakpoint
CREATE TYPE "sync_type" AS ENUM('NONE', 'LINE', 'WORD', 'SYLLABLE');--> statement-breakpoint
CREATE TYPE "provenance_source" AS ENUM('contribute', 'sync_push', 'soundcloud', 'genius', 'youtube_music', 'media');--> statement-breakpoint
CREATE TYPE "review_kind" AS ENUM('FIELD_CONFLICT', 'SERVICE_ID_CONFLICT', 'LYRICS_PARSE_FAILURE', 'GENIUS_MATCH_REJECTED', 'AUTO_MERGE', 'AUTO_SPLIT');--> statement-breakpoint
CREATE TYPE "review_status" AS ENUM('OPEN', 'APPLIED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "sample_lookup_status" AS ENUM('DONE', 'BAD_FILE', 'NOT_FOUND', 'ERROR');--> statement-breakpoint
CREATE TYPE "sample_source" AS ENUM('itunes_preview', 'media');--> statement-breakpoint
CREATE TYPE "sort_type" AS ENUM('ALPHABETICAL', 'ALPHABETICAL_REVERSE', 'NEWEST', 'OLDEST', 'DURATION_HILOW', 'DURATION_LOWHI', 'PLAYS_HILOW', 'PLAYS_LOWHI', 'VIEWS_HILOW', 'VIEWS_LOWHI', 'ADDED_DATE_HILOW', 'ADDED_DATE_LOWHI', 'DOWNLOAD_DATE_HILOW', 'DOWNLOAD_DATE_LOWHI', 'LAST_PLAYED_DATE_HILOW', 'LAST_PLAYED_DATE_LOWHI', 'LAST_SAMPLED_DATE_HILOW', 'LAST_SAMPLED_DATE_LOWHI', 'LONGEST_PLAYED_HILOW', 'LONGEST_PLAYED_LOWHI');--> statement-breakpoint
CREATE TYPE "user_role" AS ENUM('USER', 'ADMIN');--> statement-breakpoint
CREATE TABLE "action_token_uses_table" (
	"jti" varchar(64) PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"type" varchar(32) NOT NULL,
	"target" varchar(64) NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "album_tracks_table" (
	"album_id" uuid,
	"track_id" uuid,
	"track_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "album_tracks_table_pkey" PRIMARY KEY("album_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "albums_table" (
	"id" uuid PRIMARY KEY,
	"artist_id" uuid,
	"name" varchar(256) NOT NULL,
	"album_type" "album_type",
	"release_date" timestamp with time zone,
	"track_count" integer,
	"explicit" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artist_albums_table" (
	"artist_id" uuid,
	"album_id" uuid,
	"position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_albums_table_pkey" PRIMARY KEY("artist_id","album_id")
);
--> statement-breakpoint
CREATE TABLE "artist_release_checks_table" (
	"artist_id" uuid,
	"service" varchar(32),
	"requested_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"checked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_release_checks_table_pkey" PRIMARY KEY("artist_id","service")
);
--> statement-breakpoint
CREATE TABLE "artists_table" (
	"id" uuid PRIMARY KEY,
	"name" varchar(256) NOT NULL,
	"description" text,
	"primary_genre_name" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"action" varchar(32) NOT NULL,
	"actor" varchar(32) NOT NULL,
	"actor_user_id" uuid,
	"entity_table" varchar(64),
	"entity_id" varchar(64),
	"details" jsonb NOT NULL,
	"undo" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributions_log_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"contribution_id" uuid UNIQUE,
	"user_id" uuid NOT NULL,
	"source" "provenance_source" NOT NULL,
	"token_jti" varchar(64),
	"entities" jsonb DEFAULT '[]' NOT NULL,
	"response" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "genius_annotations_table" (
	"id" bigint PRIMARY KEY,
	"referent_id" bigint NOT NULL,
	"created_by_id" bigint,
	"body_markdown" text,
	"state" varchar(32),
	"verified" boolean,
	"community" boolean,
	"pinned" boolean,
	"votes_total" integer,
	"comment_count" integer,
	"genius_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "genius_artists_table" (
	"id" bigint PRIMARY KEY,
	"name" varchar(256) NOT NULL,
	"slug" varchar(256),
	"url" varchar(512),
	"image_url" varchar(512),
	"header_image_url" varchar(512),
	"index_character" varchar(4),
	"is_verified" boolean,
	"is_meme_verified" boolean,
	"iq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "genius_referents_table" (
	"id" bigint PRIMARY KEY,
	"song_id" bigint NOT NULL,
	"annotator_id" bigint,
	"fragment" text,
	"classification" varchar(32),
	"path" varchar(256),
	"is_image" boolean,
	"is_description" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "genius_song_artists_table" (
	"song_id" bigint,
	"artist_id" bigint,
	"role" "genius_artist_role",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "genius_song_artists_table_pkey" PRIMARY KEY("song_id","artist_id","role")
);
--> statement-breakpoint
CREATE TABLE "genius_songs_table" (
	"id" bigint PRIMARY KEY,
	"primary_artist_id" bigint,
	"lyrics_owner_id" bigint,
	"title" varchar(512) NOT NULL,
	"title_with_featured" varchar(512),
	"full_title" varchar(512),
	"artist_names" varchar(512),
	"primary_artist_names" varchar(512),
	"url" varchar(512),
	"song_art_image_url" varchar(512),
	"header_image_url" varchar(512),
	"description" text,
	"language" varchar(16),
	"lyrics_state" varchar(32),
	"instrumental" boolean,
	"explicit" boolean,
	"hot" boolean,
	"annotation_count" integer,
	"pageviews" bigint,
	"apple_music_id" varchar(32),
	"spotify_uuid" varchar(64),
	"youtube_url" varchar(512),
	"soundcloud_url" varchar(512),
	"release_date" date,
	"lyrics_updated_at" timestamp with time zone,
	"updated_by_human_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "genius_users_table" (
	"id" bigint PRIMARY KEY,
	"login" varchar(128) NOT NULL,
	"name" varchar(256),
	"url" varchar(512),
	"avatar_url" varchar(512),
	"header_image_url" varchar(512),
	"about_me_summary" text,
	"role_for_display" varchar(64),
	"is_verified" boolean,
	"is_meme_verified" boolean,
	"iq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "illusi_id_redirects_table" (
	"old_id" uuid PRIMARY KEY,
	"new_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_artists_table" (
	"id" bigint PRIMARY KEY,
	"name" varchar(200) NOT NULL,
	"link_url" varchar(500) UNIQUE,
	"artist_type" varchar(64),
	"amg_artist_id" bigint,
	"primary_genre_name" varchar(80),
	"primary_genre_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_collections_table" (
	"id" bigint PRIMARY KEY,
	"artist_id" bigint,
	"name" varchar(200) NOT NULL,
	"censored_name" varchar(200),
	"kind" varchar(32),
	"view_url" varchar(500) UNIQUE,
	"artwork_url_30" varchar(200),
	"artwork_url_60" varchar(200),
	"artwork_url_100" varchar(200),
	"artwork_url_600" varchar(200),
	"price" double precision,
	"explicitness" "itunes_explicitness",
	"track_count" integer,
	"copyright" varchar(500),
	"content_advisory_rating" varchar(20),
	"country" varchar(10),
	"currency" varchar(10),
	"release_date" timestamp with time zone,
	"primary_genre_name" varchar(80),
	"primary_genre_id" bigint,
	"genres" text[],
	"genre_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_lookups_table" (
	"illusi_id" uuid PRIMARY KEY,
	"entity_type" "itunes_entity_type" NOT NULL,
	"status" "itunes_lookup_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "itunes_tracks_table" (
	"id" bigint PRIMARY KEY,
	"artist_id" bigint,
	"collection_id" bigint,
	"name" varchar(200) NOT NULL,
	"censored_name" varchar(200),
	"kind" varchar(32),
	"view_url" varchar(500) UNIQUE,
	"preview_url" varchar(500),
	"artwork_url_30" varchar(200),
	"artwork_url_60" varchar(200),
	"artwork_url_100" varchar(200),
	"artwork_url_600" varchar(200),
	"price" double precision,
	"explicitness" "itunes_explicitness",
	"disc_count" integer,
	"disc_number" integer,
	"track_count" integer,
	"track_number" integer,
	"track_time_millis" bigint,
	"is_streamable" boolean,
	"country" varchar(10),
	"currency" varchar(10),
	"release_date" timestamp with time zone,
	"primary_genre_name" varchar(80),
	"primary_genre_id" bigint,
	"genres" text[],
	"genre_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linked_playlists_table" (
	"user_id" uuid,
	"service_uri" varchar(256),
	"deleted" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_playlists_table_pkey" PRIMARY KEY("user_id","service_uri")
);
--> statement-breakpoint
CREATE TABLE "media_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "media_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"track_id" uuid NOT NULL,
	"resource_id" varchar(256) NOT NULL,
	"quality" varchar(32),
	"content_hash" varchar(64) NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_inherited_playlists_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "playlist_inherited_playlists_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"playlist_id" uuid NOT NULL,
	"ref_id" uuid NOT NULL,
	"mode" "inheritance_mode",
	"deleted" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_inherited_playlists_distinct_check" CHECK ("playlist_id" <> "ref_id")
);
--> statement-breakpoint
CREATE TABLE "playlist_inherited_searches_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "playlist_inherited_searches_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"playlist_id" uuid NOT NULL,
	"query" varchar(256),
	"mode" "inheritance_mode",
	"deleted" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_tracks_table" (
	"playlist_id" uuid,
	"track_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_tracks_table_pkey" PRIMARY KEY("playlist_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "playlists_table" (
	"user_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"title" varchar(64) NOT NULL,
	"description" varchar(512),
	"pinned" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"sort_mode" "sort_type" DEFAULT 'OLDEST'::"sort_type" NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_items_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_items_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" "review_kind" NOT NULL,
	"entity_table" varchar(64) NOT NULL,
	"entity_id" varchar(64) NOT NULL,
	"field" varchar(64),
	"current_value" jsonb,
	"proposed_values" jsonb DEFAULT '[]' NOT NULL,
	"source_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"details" jsonb,
	"dedupe_key" varchar(64) NOT NULL,
	"status" "review_status" DEFAULT 'OPEN'::"review_status" NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_id_conflicts_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_id_conflicts_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"illusi_id" uuid NOT NULL,
	"column" varchar(64) NOT NULL,
	"existing_value" varchar(512),
	"incoming_value" varchar(512) NOT NULL,
	"other_illusi_id" uuid,
	"source" varchar(32) NOT NULL,
	"source_user_id" uuid,
	"source_token_jti" varchar(64),
	"status" "conflict_status" DEFAULT 'open'::"conflict_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_ids_table" (
	"illusi_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"youtube_id" varchar(64) UNIQUE,
	"spotify_id" varchar(64) UNIQUE,
	"soundcloud_id" bigint UNIQUE,
	"soundcloud_permalink" varchar(256) UNIQUE,
	"amazonmusic_id" varchar(32) UNIQUE,
	"applemusic_id" varchar(32) UNIQUE,
	"bandlab_id" varchar(64) UNIQUE,
	"audiomack_id" varchar(64) UNIQUE,
	"deezer_id" varchar(64) UNIQUE,
	"pandora_id" varchar(64) UNIQUE,
	"tidal_id" varchar(64) UNIQUE,
	"genius_id" bigint UNIQUE,
	"isrc" varchar(12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"family_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL UNIQUE,
	"device_name" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid
);
--> statement-breakpoint
CREATE TABLE "similar_artists_table" (
	"artist_id" uuid,
	"similar_artist_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "similar_artists_table_pkey" PRIMARY KEY("artist_id","similar_artist_id"),
	CONSTRAINT "similar_artists_distinct_check" CHECK ("artist_id" <> "similar_artist_id")
);
--> statement-breakpoint
CREATE TABLE "soundcloud_playlist_table" (
	"id" bigint PRIMARY KEY,
	"user_id" bigint,
	"permalink" varchar(256),
	"title" varchar(512) NOT NULL,
	"description" text,
	"genre" varchar(128),
	"tag_list" text,
	"license" varchar(64),
	"label_name" varchar(256),
	"artwork_url" varchar(512),
	"set_type" varchar(32),
	"sharing" varchar(16),
	"embeddable_by" varchar(16),
	"is_album" boolean,
	"public" boolean,
	"duration" integer,
	"track_count" integer,
	"likes_count" integer,
	"reposts_count" integer,
	"release_date" timestamp with time zone,
	"published_at" timestamp with time zone,
	"display_date" timestamp with time zone,
	"soundcloud_created_at" timestamp with time zone,
	"soundcloud_last_modified" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "soundcloud_playlist_tracks_table" (
	"playlist_id" bigint,
	"track_id" bigint,
	"position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "soundcloud_playlist_tracks_table_pkey" PRIMARY KEY("playlist_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "soundcloud_tracks_table" (
	"id" bigint PRIMARY KEY,
	"user_id" bigint,
	"permalink" varchar(256),
	"title" varchar(512) NOT NULL,
	"description" text,
	"caption" text,
	"genre" varchar(128),
	"tag_list" text,
	"license" varchar(64),
	"label_name" varchar(256),
	"artwork_url" varchar(512),
	"waveform_url" varchar(512),
	"duration" integer,
	"full_duration" integer,
	"state" varchar(32),
	"sharing" varchar(16),
	"embeddable_by" varchar(16),
	"policy" varchar(32),
	"monetization_model" varchar(64),
	"public" boolean,
	"streamable" boolean,
	"commentable" boolean,
	"downloadable" boolean,
	"playback_count" bigint,
	"likes_count" integer,
	"reposts_count" integer,
	"comment_count" integer,
	"download_count" integer,
	"publisher_artist" varchar(256),
	"album_title" varchar(256),
	"release_title" varchar(256),
	"isrc" varchar(16),
	"upc_or_ean" varchar(32),
	"explicit" boolean,
	"contains_music" boolean,
	"writer_composer" text,
	"p_line" varchar(512),
	"c_line" varchar(512),
	"release_date" timestamp with time zone,
	"display_date" timestamp with time zone,
	"soundcloud_created_at" timestamp with time zone,
	"soundcloud_last_modified" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "soundcloud_transcodings_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "soundcloud_transcodings_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"track_id" bigint NOT NULL,
	"url" varchar(512) NOT NULL,
	"preset" varchar(32),
	"protocol" varchar(32),
	"mime_type" varchar(64),
	"quality" varchar(8),
	"duration" integer,
	"snipped" boolean,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "soundcloud_users_table" (
	"id" bigint PRIMARY KEY,
	"permalink" varchar(128) NOT NULL UNIQUE,
	"username" varchar(256) NOT NULL,
	"first_name" varchar(128),
	"last_name" varchar(128),
	"full_name" varchar(256),
	"avatar_url" varchar(512),
	"city" varchar(128),
	"country_code" varchar(8),
	"description" text,
	"verified" boolean,
	"badge_pro" boolean,
	"badge_creator_mid_tier" boolean,
	"badge_pro_unlimited" boolean,
	"followers_count" integer,
	"followings_count" integer,
	"track_count" integer,
	"playlist_count" integer,
	"likes_count" integer,
	"playlist_likes_count" integer,
	"comments_count" integer,
	"groups_count" integer,
	"reposts_count" integer,
	"soundcloud_created_at" timestamp with time zone,
	"soundcloud_last_modified" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_pushes_table" (
	"push_id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thumbnails_table" (
	"id" uuid,
	"url" varchar(512) PRIMARY KEY,
	"width" integer,
	"height" integer
);
--> statement-breakpoint
CREATE TABLE "track_lyrics_lookups_table" (
	"track_id" uuid,
	"service" "lyrics_services",
	"status" "lyrics_lookup_status" NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_after" timestamp with time zone,
	"source_user_id" uuid,
	CONSTRAINT "track_lyrics_lookups_table_pkey" PRIMARY KEY("track_id","service")
);
--> statement-breakpoint
CREATE TABLE "track_lyrics_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "track_lyrics_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"track_id" uuid NOT NULL,
	"service" "lyrics_services" NOT NULL,
	"sync_type" "sync_type" NOT NULL,
	"format" "lyrics_format" NOT NULL,
	"raw_content" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"parsed_cache" jsonb,
	"parser_version" integer,
	"source_user_id" uuid,
	"source_token_jti" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_plays_table" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "track_plays_table_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"client_id" uuid UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_sample_data_table" (
	"id" uuid PRIMARY KEY,
	"mood" varchar(50) NOT NULL,
	"tempo" real NOT NULL,
	"brightness" real NOT NULL,
	"key" varchar(5) NOT NULL,
	"acousticness" real NOT NULL,
	"instrumentalness" real NOT NULL,
	"liveness" real NOT NULL,
	"danceability" real NOT NULL,
	"arousal" real NOT NULL,
	"valence" real NOT NULL,
	"speechiness" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_sample_lookups_table" (
	"track_id" uuid,
	"source" "sample_source",
	"status" "sample_lookup_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_after" timestamp with time zone,
	"source_ref" varchar(512),
	CONSTRAINT "track_sample_lookups_table_pkey" PRIMARY KEY("track_id","source")
);
--> statement-breakpoint
CREATE TABLE "track_vectors_table" (
	"track_id" uuid PRIMARY KEY,
	"embedding" vector(40) NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks_artists_table" (
	"artist_id" uuid,
	"track_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracks_artists_table_pkey" PRIMARY KEY("artist_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "tracks_producers_table" (
	"producer_id" bigint,
	"track_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracks_producers_table_pkey" PRIMARY KEY("producer_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "tracks_table" (
	"id" uuid PRIMARY KEY,
	"title" varchar(256) NOT NULL,
	"album_id" uuid,
	"duration_ms" bigint,
	"explicit" boolean,
	"imported" boolean DEFAULT false NOT NULL,
	"backpacked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_recent_searches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_recent_searches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid,
	"text" varchar(128),
	"client_id" uuid UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tracks_table" (
	"user_id" uuid,
	"track_id" uuid,
	"title" varchar(256),
	"downloaded_at" timestamp with time zone,
	"start_at" bigint,
	"end_at" bigint,
	"deleted" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tracks_table_pkey" PRIMARY KEY("user_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "users_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"username" varchar(64) NOT NULL,
	"email" varchar(256) NOT NULL UNIQUE,
	"password_hash" varchar(255) NOT NULL,
	"role" "user_role" DEFAULT 'USER'::"user_role" NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase_check" CHECK ("email" = lower("email"))
);
--> statement-breakpoint
CREATE INDEX "action_token_uses_expires_at_idx" ON "action_token_uses_table" ("expires_at");--> statement-breakpoint
CREATE INDEX "album_tracks_track_id_idx" ON "album_tracks_table" ("track_id");--> statement-breakpoint
CREATE INDEX "albums_artist_id_idx" ON "albums_table" ("artist_id");--> statement-breakpoint
CREATE INDEX "albums_modified_at_idx" ON "albums_table" ("modified_at");--> statement-breakpoint
CREATE INDEX "albums_release_date_idx" ON "albums_table" ("release_date");--> statement-breakpoint
CREATE INDEX "artist_albums_album_id_idx" ON "artist_albums_table" ("album_id");--> statement-breakpoint
CREATE INDEX "artists_modified_at_idx" ON "artists_table" ("modified_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log_table" ("entity_table","entity_id");--> statement-breakpoint
CREATE INDEX "contributions_log_user_id_idx" ON "contributions_log_table" ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "genius_annotations_referent_id_idx" ON "genius_annotations_table" ("referent_id");--> statement-breakpoint
CREATE INDEX "genius_annotations_created_by_id_idx" ON "genius_annotations_table" ("created_by_id");--> statement-breakpoint
CREATE INDEX "genius_referents_song_id_idx" ON "genius_referents_table" ("song_id");--> statement-breakpoint
CREATE INDEX "genius_referents_annotator_id_idx" ON "genius_referents_table" ("annotator_id");--> statement-breakpoint
CREATE INDEX "genius_song_artists_artist_id_idx" ON "genius_song_artists_table" ("artist_id");--> statement-breakpoint
CREATE INDEX "genius_songs_primary_artist_id_idx" ON "genius_songs_table" ("primary_artist_id");--> statement-breakpoint
CREATE INDEX "genius_songs_lyrics_owner_id_idx" ON "genius_songs_table" ("lyrics_owner_id");--> statement-breakpoint
CREATE INDEX "illusi_id_redirects_new_id_idx" ON "illusi_id_redirects_table" ("new_id");--> statement-breakpoint
CREATE INDEX "illusi_id_redirects_created_at_idx" ON "illusi_id_redirects_table" ("created_at");--> statement-breakpoint
CREATE INDEX "itunes_collections_artist_id_idx" ON "itunes_collections_table" ("artist_id");--> statement-breakpoint
CREATE INDEX "itunes_tracks_artist_id_idx" ON "itunes_tracks_table" ("artist_id");--> statement-breakpoint
CREATE INDEX "itunes_tracks_collection_id_idx" ON "itunes_tracks_table" ("collection_id");--> statement-breakpoint
CREATE INDEX "linked_playlists_user_id_modified_at_idx" ON "linked_playlists_table" ("user_id","modified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_track_id_resource_id_idx" ON "media_table" ("track_id","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_track_id_content_hash_idx" ON "media_table" ("track_id","content_hash");--> statement-breakpoint
CREATE INDEX "media_resource_id_idx" ON "media_table" ("resource_id");--> statement-breakpoint
CREATE INDEX "playlist_inherited_playlists_playlist_id_idx" ON "playlist_inherited_playlists_table" ("playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_inherited_playlists_ref_id_idx" ON "playlist_inherited_playlists_table" ("ref_id");--> statement-breakpoint
CREATE INDEX "playlist_inherited_searches_playlist_id_idx" ON "playlist_inherited_searches_table" ("playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_tracks_modified_at_idx" ON "playlist_tracks_table" ("modified_at");--> statement-breakpoint
CREATE INDEX "playlist_tracks_track_id_idx" ON "playlist_tracks_table" ("track_id");--> statement-breakpoint
CREATE INDEX "playlists_user_id_idx" ON "playlists_table" ("user_id");--> statement-breakpoint
CREATE INDEX "playlists_user_id_modified_at_idx" ON "playlists_table" ("user_id","modified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_items_dedupe_key_open_idx" ON "review_items_table" ("dedupe_key") WHERE "status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "review_items_status_kind_idx" ON "review_items_table" ("status","kind");--> statement-breakpoint
CREATE INDEX "review_items_entity_idx" ON "review_items_table" ("entity_table","entity_id");--> statement-breakpoint
CREATE INDEX "service_id_conflicts_illusi_id_idx" ON "service_id_conflicts_table" ("illusi_id");--> statement-breakpoint
CREATE INDEX "service_id_conflicts_other_illusi_id_idx" ON "service_id_conflicts_table" ("other_illusi_id");--> statement-breakpoint
CREATE INDEX "service_id_conflicts_status_idx" ON "service_id_conflicts_table" ("status");--> statement-breakpoint
CREATE INDEX "service_ids_isrc_idx" ON "service_ids_table" ("isrc");--> statement-breakpoint
CREATE INDEX "service_ids_modified_at_idx" ON "service_ids_table" ("modified_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions_table" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "sessions_table" ("family_id");--> statement-breakpoint
CREATE INDEX "similar_artists_similar_artist_id_idx" ON "similar_artists_table" ("similar_artist_id");--> statement-breakpoint
CREATE INDEX "soundcloud_playlist_user_id_idx" ON "soundcloud_playlist_table" ("user_id");--> statement-breakpoint
CREATE INDEX "soundcloud_playlist_tracks_track_id_idx" ON "soundcloud_playlist_tracks_table" ("track_id");--> statement-breakpoint
CREATE INDEX "soundcloud_tracks_user_id_idx" ON "soundcloud_tracks_table" ("user_id");--> statement-breakpoint
CREATE INDEX "soundcloud_tracks_released_at_idx" ON "soundcloud_tracks_table" (coalesce("release_date", "display_date", "soundcloud_created_at"));--> statement-breakpoint
CREATE UNIQUE INDEX "soundcloud_transcodings_url_idx" ON "soundcloud_transcodings_table" ("url");--> statement-breakpoint
CREATE INDEX "soundcloud_transcodings_track_id_idx" ON "soundcloud_transcodings_table" ("track_id");--> statement-breakpoint
CREATE INDEX "sync_pushes_user_id_idx" ON "sync_pushes_table" ("user_id");--> statement-breakpoint
CREATE INDEX "thumbnails_id_idx" ON "thumbnails_table" ("id");--> statement-breakpoint
CREATE INDEX "track_lyrics_track_id_idx" ON "track_lyrics_table" ("track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "track_lyrics_track_id_content_hash_idx" ON "track_lyrics_table" ("track_id","content_hash");--> statement-breakpoint
CREATE INDEX "track_lyrics_modified_at_idx" ON "track_lyrics_table" ("modified_at");--> statement-breakpoint
CREATE INDEX "track_plays_user_id_idx" ON "track_plays_table" ("user_id");--> statement-breakpoint
CREATE INDEX "track_plays_track_id_idx" ON "track_plays_table" ("track_id");--> statement-breakpoint
CREATE INDEX "track_sample_data_modified_at_idx" ON "track_sample_data_table" ("modified_at");--> statement-breakpoint
CREATE INDEX "track_vectors_embedding_idx" ON "track_vectors_table" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "tracks_artists_track_id_idx" ON "tracks_artists_table" ("track_id");--> statement-breakpoint
CREATE INDEX "tracks_producers_track_id_idx" ON "tracks_producers_table" ("track_id");--> statement-breakpoint
CREATE INDEX "tracks_album_id_idx" ON "tracks_table" ("album_id");--> statement-breakpoint
CREATE INDEX "tracks_modified_at_idx" ON "tracks_table" ("modified_at");--> statement-breakpoint
CREATE INDEX "user_recent_searches_user_id_idx" ON "user_recent_searches" ("user_id");--> statement-breakpoint
CREATE INDEX "user_tracks_track_id_idx" ON "user_tracks_table" ("track_id");--> statement-breakpoint
CREATE INDEX "user_tracks_user_id_modified_at_idx" ON "user_tracks_table" ("user_id","modified_at");--> statement-breakpoint
ALTER TABLE "album_tracks_table" ADD CONSTRAINT "album_tracks_table_album_id_albums_table_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "album_tracks_table" ADD CONSTRAINT "album_tracks_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "albums_table" ADD CONSTRAINT "albums_table_id_service_ids_table_illusi_id_fkey" FOREIGN KEY ("id") REFERENCES "service_ids_table"("illusi_id");--> statement-breakpoint
ALTER TABLE "albums_table" ADD CONSTRAINT "albums_table_artist_id_artists_table_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artist_albums_table" ADD CONSTRAINT "artist_albums_table_artist_id_artists_table_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artist_albums_table" ADD CONSTRAINT "artist_albums_table_album_id_albums_table_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artist_release_checks_table" ADD CONSTRAINT "artist_release_checks_table_artist_id_artists_table_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artist_release_checks_table" ADD CONSTRAINT "artist_release_checks_table_checked_by_users_table_id_fkey" FOREIGN KEY ("checked_by") REFERENCES "users_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artists_table" ADD CONSTRAINT "artists_table_id_service_ids_table_illusi_id_fkey" FOREIGN KEY ("id") REFERENCES "service_ids_table"("illusi_id");--> statement-breakpoint
ALTER TABLE "contributions_log_table" ADD CONSTRAINT "contributions_log_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "genius_annotations_table" ADD CONSTRAINT "genius_annotations_table_MWd1Cj60arch_fkey" FOREIGN KEY ("referent_id") REFERENCES "genius_referents_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "genius_annotations_table" ADD CONSTRAINT "genius_annotations_table_avIDatPvQtEQ_fkey" FOREIGN KEY ("created_by_id") REFERENCES "genius_users_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "genius_referents_table" ADD CONSTRAINT "genius_referents_table_song_id_genius_songs_table_id_fkey" FOREIGN KEY ("song_id") REFERENCES "genius_songs_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "genius_referents_table" ADD CONSTRAINT "genius_referents_table_annotator_id_genius_users_table_id_fkey" FOREIGN KEY ("annotator_id") REFERENCES "genius_users_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "genius_song_artists_table" ADD CONSTRAINT "genius_song_artists_table_song_id_genius_songs_table_id_fkey" FOREIGN KEY ("song_id") REFERENCES "genius_songs_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "genius_song_artists_table" ADD CONSTRAINT "genius_song_artists_table_BWvdYKPCpxIf_fkey" FOREIGN KEY ("artist_id") REFERENCES "genius_artists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "genius_songs_table" ADD CONSTRAINT "genius_songs_table_8UgQmP9UA2Dy_fkey" FOREIGN KEY ("primary_artist_id") REFERENCES "genius_artists_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "genius_songs_table" ADD CONSTRAINT "genius_songs_table_lyrics_owner_id_genius_users_table_id_fkey" FOREIGN KEY ("lyrics_owner_id") REFERENCES "genius_users_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "illusi_id_redirects_table" ADD CONSTRAINT "illusi_id_redirects_table_W0eGVwrwLXCv_fkey" FOREIGN KEY ("new_id") REFERENCES "service_ids_table"("illusi_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "itunes_collections_table" ADD CONSTRAINT "itunes_collections_table_artist_id_itunes_artists_table_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "itunes_artists_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "itunes_lookups_table" ADD CONSTRAINT "itunes_lookups_table_illusi_id_service_ids_table_illusi_id_fkey" FOREIGN KEY ("illusi_id") REFERENCES "service_ids_table"("illusi_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "itunes_tracks_table" ADD CONSTRAINT "itunes_tracks_table_artist_id_itunes_artists_table_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "itunes_artists_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "itunes_tracks_table" ADD CONSTRAINT "itunes_tracks_table_NzNIl5ggvdbV_fkey" FOREIGN KEY ("collection_id") REFERENCES "itunes_collections_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "linked_playlists_table" ADD CONSTRAINT "linked_playlists_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "media_table" ADD CONSTRAINT "media_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_inherited_playlists_table" ADD CONSTRAINT "playlist_inherited_playlists_table_Oxn6NPrHooFY_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_inherited_playlists_table" ADD CONSTRAINT "playlist_inherited_playlists_table_NMheooPitjZv_fkey" FOREIGN KEY ("ref_id") REFERENCES "playlists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_inherited_searches_table" ADD CONSTRAINT "playlist_inherited_searches_table_RzwRzVbNbmQz_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_tracks_table" ADD CONSTRAINT "playlist_tracks_table_playlist_id_playlists_table_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_tracks_table" ADD CONSTRAINT "playlist_tracks_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlists_table" ADD CONSTRAINT "playlists_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "review_items_table" ADD CONSTRAINT "review_items_table_resolved_by_users_table_id_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "service_id_conflicts_table" ADD CONSTRAINT "service_id_conflicts_table_CFusBCZbNWtM_fkey" FOREIGN KEY ("illusi_id") REFERENCES "service_ids_table"("illusi_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "service_id_conflicts_table" ADD CONSTRAINT "service_id_conflicts_table_30nZ7012012P_fkey" FOREIGN KEY ("other_illusi_id") REFERENCES "service_ids_table"("illusi_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions_table" ADD CONSTRAINT "sessions_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "similar_artists_table" ADD CONSTRAINT "similar_artists_table_artist_id_artists_table_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "similar_artists_table" ADD CONSTRAINT "similar_artists_table_similar_artist_id_artists_table_id_fkey" FOREIGN KEY ("similar_artist_id") REFERENCES "artists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "soundcloud_playlist_table" ADD CONSTRAINT "soundcloud_playlist_table_GwharqeSy2y7_fkey" FOREIGN KEY ("user_id") REFERENCES "soundcloud_users_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "soundcloud_playlist_tracks_table" ADD CONSTRAINT "soundcloud_playlist_tracks_table_I9gl8o00TWUN_fkey" FOREIGN KEY ("playlist_id") REFERENCES "soundcloud_playlist_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "soundcloud_playlist_tracks_table" ADD CONSTRAINT "soundcloud_playlist_tracks_table_bYadtMDDvxzE_fkey" FOREIGN KEY ("track_id") REFERENCES "soundcloud_tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "soundcloud_tracks_table" ADD CONSTRAINT "soundcloud_tracks_table_user_id_soundcloud_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "soundcloud_users_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "soundcloud_transcodings_table" ADD CONSTRAINT "soundcloud_transcodings_table_kwhYmSCcS2K8_fkey" FOREIGN KEY ("track_id") REFERENCES "soundcloud_tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sync_pushes_table" ADD CONSTRAINT "sync_pushes_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_lyrics_lookups_table" ADD CONSTRAINT "track_lyrics_lookups_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_lyrics_table" ADD CONSTRAINT "track_lyrics_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_plays_table" ADD CONSTRAINT "track_plays_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_plays_table" ADD CONSTRAINT "track_plays_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD CONSTRAINT "track_sample_data_table_id_tracks_table_id_fkey" FOREIGN KEY ("id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_sample_lookups_table" ADD CONSTRAINT "track_sample_lookups_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_vectors_table" ADD CONSTRAINT "track_vectors_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tracks_artists_table" ADD CONSTRAINT "tracks_artists_table_artist_id_artists_table_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tracks_artists_table" ADD CONSTRAINT "tracks_artists_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tracks_producers_table" ADD CONSTRAINT "tracks_producers_table_producer_id_genius_artists_table_id_fkey" FOREIGN KEY ("producer_id") REFERENCES "genius_artists_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tracks_producers_table" ADD CONSTRAINT "tracks_producers_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tracks_table" ADD CONSTRAINT "tracks_table_id_service_ids_table_illusi_id_fkey" FOREIGN KEY ("id") REFERENCES "service_ids_table"("illusi_id");--> statement-breakpoint
ALTER TABLE "tracks_table" ADD CONSTRAINT "tracks_table_album_id_albums_table_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "user_recent_searches" ADD CONSTRAINT "user_recent_searches_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_tracks_table" ADD CONSTRAINT "user_tracks_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_tracks_table" ADD CONSTRAINT "user_tracks_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;