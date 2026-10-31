ALTER TABLE "albums_table" ADD COLUMN "search_name" text GENERATED ALWAYS AS (illusi_search_text("albums_table"."name")) STORED;--> statement-breakpoint
ALTER TABLE "artists_table" ADD COLUMN "search_name" text GENERATED ALWAYS AS (illusi_search_text("artists_table"."name")) STORED;--> statement-breakpoint
ALTER TABLE "tracks_table" ADD COLUMN "search_title" text GENERATED ALWAYS AS (illusi_search_text("tracks_table"."title")) STORED;--> statement-breakpoint
CREATE INDEX "albums_search_name_trgm_idx" ON "albums_table" USING gin ("search_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "artists_search_name_trgm_idx" ON "artists_table" USING gin ("search_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tracks_search_title_trgm_idx" ON "tracks_table" USING gin ("search_title" gin_trgm_ops);--> statement-breakpoint
DROP INDEX "albums_search_trgm_idx";--> statement-breakpoint
DROP INDEX "artists_search_trgm_idx";--> statement-breakpoint
DROP INDEX "tracks_search_trgm_idx";
