-- Musixmatch and GoLyrics are no longer lyrics services: their stored lyrics and lookup records go before the enums lose the values.
DELETE FROM "track_lyrics_table" WHERE "service" IN ('MUSIXMATCH', 'GOLYRICS') OR "format" = 'MXM_RICHSYNC_JSON';--> statement-breakpoint
DELETE FROM "track_lyrics_lookups_table" WHERE "service" IN ('MUSIXMATCH', 'GOLYRICS');--> statement-breakpoint
-- The deletes queue the deferred read_version_catalog trigger; fire it now, since ALTER TABLE refuses a table with pending trigger events.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "track_lyrics_table" ALTER COLUMN "format" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "lyrics_format";--> statement-breakpoint
CREATE TYPE "lyrics_format" AS ENUM('TTML', 'LRC', 'ELRC', 'PLAIN', 'GENIUS_BODY_JSON', 'YTM_JSON', 'QRC', 'KRC', 'UNISON_JSON');--> statement-breakpoint
ALTER TABLE "track_lyrics_table" ALTER COLUMN "format" SET DATA TYPE "lyrics_format" USING "format"::"lyrics_format";--> statement-breakpoint
ALTER TABLE "track_lyrics_lookups_table" ALTER COLUMN "service" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "track_lyrics_table" ALTER COLUMN "service" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "lyrics_services";--> statement-breakpoint
CREATE TYPE "lyrics_services" AS ENUM('BINILYRICS', 'LRCLIB', 'YOUTUBE_MUSIC', 'GENIUS', 'UNISON', 'QQMUSIC', 'KUGOU', 'LRCRED');--> statement-breakpoint
ALTER TABLE "track_lyrics_lookups_table" ALTER COLUMN "service" SET DATA TYPE "lyrics_services" USING "service"::"lyrics_services";--> statement-breakpoint
ALTER TABLE "track_lyrics_table" ALTER COLUMN "service" SET DATA TYPE "lyrics_services" USING "service"::"lyrics_services";