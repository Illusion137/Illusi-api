ALTER TYPE "lyrics_services" ADD VALUE 'USER';--> statement-breakpoint
ALTER TABLE "user_tracks_table" ADD COLUMN "artist_ids" uuid[];--> statement-breakpoint
ALTER TABLE "user_tracks_table" ADD COLUMN "album_id" uuid;--> statement-breakpoint
ALTER TABLE "user_tracks_table" ADD CONSTRAINT "user_tracks_table_album_id_albums_table_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums_table"("id") ON DELETE SET NULL;