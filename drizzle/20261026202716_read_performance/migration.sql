CREATE TABLE "read_versions_table" (
	"key" varchar(32) PRIMARY KEY,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_play_counts_table" (
	"track_id" uuid PRIMARY KEY,
	"plays" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "track_play_counts_plays_check" CHECK ("plays" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_read_versions_table" (
	"user_id" uuid PRIMARY KEY,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DROP INDEX "track_plays_user_id_idx";--> statement-breakpoint
CREATE INDEX "track_plays_user_id_track_id_idx" ON "track_plays_table" ("user_id","track_id");--> statement-breakpoint
CREATE INDEX "track_plays_user_id_created_at_idx" ON "track_plays_table" ("user_id","created_at" DESC,"id" DESC);--> statement-breakpoint
ALTER TABLE "track_play_counts_table" ADD CONSTRAINT "track_play_counts_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_read_versions_table" ADD CONSTRAINT "user_read_versions_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;