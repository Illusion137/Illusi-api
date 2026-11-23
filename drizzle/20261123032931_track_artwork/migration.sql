ALTER TABLE "tracks_table" ADD COLUMN "artwork_id" varchar(64);--> statement-breakpoint
ALTER TABLE "tracks_table" ADD COLUMN "artwork_edited_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tracks_artwork_id_idx" ON "tracks_table" ("artwork_id") WHERE "artwork_id" is not null;