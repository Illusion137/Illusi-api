CREATE TABLE "service_links_locks_table" (
	"illusi_id" uuid PRIMARY KEY,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_links_locks_table" ADD CONSTRAINT "service_links_locks_table_vYPjwPbSFsQl_fkey" FOREIGN KEY ("illusi_id") REFERENCES "service_ids_table"("illusi_id") ON DELETE CASCADE;--> statement-breakpoint
-- The artist "Sudo" shares its name with unrelated artists on YouTube and Apple Music, whose ids kept landing on it.
-- Unlink it everywhere and lock it. A database without that artist is left alone.
INSERT INTO "service_links_locks_table" ("illusi_id", "reason")
SELECT "id", 'name shared with unrelated artists on other services' FROM "artists_table" WHERE "id" = 'ac1eb96d-002c-475c-b700-898751ba72c7';
--> statement-breakpoint
UPDATE "service_ids_table" SET
	"youtube_id" = NULL, "spotify_id" = NULL, "soundcloud_id" = NULL, "soundcloud_permalink" = NULL, "amazonmusic_id" = NULL,
	"applemusic_id" = NULL, "bandlab_id" = NULL, "audiomack_id" = NULL, "deezer_id" = NULL, "pandora_id" = NULL,
	"tidal_id" = NULL, "genius_id" = NULL, "isrc" = NULL, "modified_at" = now()
WHERE "illusi_id" IN (SELECT "illusi_id" FROM "service_links_locks_table");
--> statement-breakpoint
UPDATE "service_artists_table" SET "illusi_id" = NULL WHERE "illusi_id" IN (SELECT "illusi_id" FROM "service_links_locks_table");
--> statement-breakpoint
DELETE FROM "artist_release_checks_table" WHERE "artist_id" IN (SELECT "illusi_id" FROM "service_links_locks_table");
--> statement-breakpoint
UPDATE "service_id_conflicts_table" SET "status" = 'dismissed', "modified_at" = now()
WHERE "status" IN ('open', 'deferred') AND ("illusi_id" IN (SELECT "illusi_id" FROM "service_links_locks_table") OR "other_illusi_id" IN (SELECT "illusi_id" FROM "service_links_locks_table"));
--> statement-breakpoint
UPDATE "artists_table" SET "modified_at" = now() WHERE "id" IN (SELECT "illusi_id" FROM "service_links_locks_table");
