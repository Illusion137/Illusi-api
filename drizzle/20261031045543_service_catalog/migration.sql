CREATE TYPE "catalog_service" AS ENUM('spotify', 'applemusic', 'amazonmusic', 'deezer', 'tidal', 'pandora', 'bandlab', 'audiomack');--> statement-breakpoint
CREATE TABLE "service_albums_table" (
	"service" "catalog_service",
	"external_id" varchar(256),
	"illusi_id" uuid,
	"title" varchar(1024) NOT NULL,
	"artist_names" text[],
	"artist_external_ids" text[],
	"album_type" varchar(32),
	"release_date" timestamp with time zone,
	"explicit" boolean,
	"track_count" integer,
	"artwork_url" varchar(1024),
	"raw" jsonb,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_albums_table_pkey" PRIMARY KEY("service","external_id")
);
--> statement-breakpoint
CREATE TABLE "service_artists_table" (
	"service" "catalog_service",
	"external_id" varchar(256),
	"illusi_id" uuid,
	"name" varchar(1024) NOT NULL,
	"artwork_url" varchar(1024),
	"verified" boolean,
	"description" text,
	"followers_count" bigint,
	"raw" jsonb,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_artists_table_pkey" PRIMARY KEY("service","external_id")
);
--> statement-breakpoint
CREATE TABLE "service_tracks_table" (
	"service" "catalog_service",
	"external_id" varchar(256),
	"illusi_id" uuid,
	"title" varchar(1024) NOT NULL,
	"alt_title" varchar(1024),
	"artist_names" text[],
	"artist_external_ids" text[],
	"album_title" varchar(1024),
	"album_external_id" varchar(256),
	"duration_ms" integer,
	"explicit" boolean,
	"plays" bigint,
	"isrc" varchar(12),
	"artwork_url" varchar(1024),
	"raw" jsonb,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_tracks_table_pkey" PRIMARY KEY("service","external_id")
);
--> statement-breakpoint
CREATE INDEX "service_albums_illusi_id_idx" ON "service_albums_table" ("illusi_id");--> statement-breakpoint
CREATE INDEX "service_artists_illusi_id_idx" ON "service_artists_table" ("illusi_id");--> statement-breakpoint
CREATE INDEX "service_tracks_illusi_id_idx" ON "service_tracks_table" ("illusi_id");--> statement-breakpoint
CREATE INDEX "service_tracks_isrc_idx" ON "service_tracks_table" ("isrc");--> statement-breakpoint
ALTER TABLE "service_albums_table" ADD CONSTRAINT "service_albums_table_illusi_id_albums_table_id_fkey" FOREIGN KEY ("illusi_id") REFERENCES "albums_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "service_artists_table" ADD CONSTRAINT "service_artists_table_illusi_id_artists_table_id_fkey" FOREIGN KEY ("illusi_id") REFERENCES "artists_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "service_tracks_table" ADD CONSTRAINT "service_tracks_table_illusi_id_tracks_table_id_fkey" FOREIGN KEY ("illusi_id") REFERENCES "tracks_table"("id") ON DELETE SET NULL;