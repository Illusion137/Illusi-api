CREATE TABLE "track_youtube_ids_table" (
	"youtube_id" varchar(64) PRIMARY KEY,
	"track_id" uuid NOT NULL,
	"unavailable_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "track_youtube_ids_track_id_idx" ON "track_youtube_ids_table" ("track_id");--> statement-breakpoint
ALTER TABLE "track_youtube_ids_table" ADD CONSTRAINT "track_youtube_ids_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Tracks backpacked because their YouTube id stopped playing: that id is dead.
INSERT INTO "track_youtube_ids_table" ("youtube_id", "track_id", "unavailable_at")
SELECT si."youtube_id", t."id", coalesce(t."backpacked_at", now())
FROM "tracks_table" t
JOIN "service_ids_table" si ON si."illusi_id" = t."id"
WHERE t."backpacked" AND si."youtube_id" IS NOT NULL
	AND EXISTS (SELECT 1 FROM "track_unavailable_reports_table" r WHERE r."track_id" = t."id" AND r."service" = 'youtube')
ON CONFLICT DO NOTHING;
