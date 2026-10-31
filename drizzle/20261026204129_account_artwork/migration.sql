CREATE TYPE "export_status" AS ENUM('PENDING', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "export_jobs_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"status" "export_status" DEFAULT 'PENDING'::"export_status" NOT NULL,
	"file_name" varchar(64),
	"size" bigint,
	"error" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "playlists_table" ADD COLUMN "artwork_id" varchar(64);--> statement-breakpoint
ALTER TABLE "playlists_table" ADD COLUMN "artwork_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contributions_log_table" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "export_jobs_user_id_created_at_idx" ON "export_jobs_table" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "export_jobs_status_idx" ON "export_jobs_table" ("status");--> statement-breakpoint
CREATE INDEX "playlists_artwork_id_idx" ON "playlists_table" ("artwork_id") WHERE "artwork_id" is not null;--> statement-breakpoint
ALTER TABLE "export_jobs_table" ADD CONSTRAINT "export_jobs_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contributions_log_table" DROP CONSTRAINT "contributions_log_table_user_id_users_table_id_fkey", ADD CONSTRAINT "contributions_log_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE SET NULL;