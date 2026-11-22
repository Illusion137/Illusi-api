ALTER TABLE "track_plays_table" DROP CONSTRAINT "track_plays_table_client_id_key";--> statement-breakpoint
ALTER TABLE "user_recent_searches" DROP CONSTRAINT "user_recent_searches_client_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX "track_plays_user_id_client_id_idx" ON "track_plays_table" ("user_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_recent_searches_user_id_client_id_idx" ON "user_recent_searches" ("user_id","client_id");