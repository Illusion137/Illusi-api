CREATE TABLE "track_duration_reports_table" (
	"track_id" uuid,
	"user_id" uuid,
	"duration_ms" integer NOT NULL,
	"source" varchar(16) NOT NULL,
	"service" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_duration_reports_table_pkey" PRIMARY KEY("track_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "track_duration_reports_table" ADD CONSTRAINT "track_duration_reports_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_duration_reports_table" ADD CONSTRAINT "track_duration_reports_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Each user's reports are theirs (see 20261031033716_row_level_security); POST /tracks/:id/duration reads them all as the owner.
ALTER TABLE "track_duration_reports_table" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_only ON "track_duration_reports_table" USING (user_id = (SELECT app_user_id())) WITH CHECK (user_id = (SELECT app_user_id()));
