CREATE TABLE "track_downloads_table" (
	"session_family_id" uuid,
	"user_id" uuid NOT NULL,
	"track_id" uuid,
	"downloaded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_downloads_table_pkey" PRIMARY KEY("session_family_id","track_id")
);
--> statement-breakpoint
CREATE INDEX "track_downloads_track_id_idx" ON "track_downloads_table" ("track_id");--> statement-breakpoint
CREATE INDEX "track_downloads_user_id_idx" ON "track_downloads_table" ("user_id");--> statement-breakpoint
ALTER TABLE "track_downloads_table" ADD CONSTRAINT "track_downloads_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_downloads_table" ADD CONSTRAINT "track_downloads_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Downloads so far were per user. Credit them to the user's most recently used login, the device most likely to hold
-- them; clients re-report their own downloads after updating, which corrects the rest.
INSERT INTO "track_downloads_table" ("session_family_id", "user_id", "track_id", "downloaded_at")
SELECT s."family_id", ut."user_id", ut."track_id", ut."downloaded_at"
FROM "user_tracks_table" ut
JOIN LATERAL (
	SELECT "family_id" FROM "sessions_table"
	WHERE "user_id" = ut."user_id" AND "revoked_at" IS NULL AND "expires_at" > now()
	ORDER BY coalesce("last_used_at", "created_at") DESC LIMIT 1
) s ON true
WHERE ut."downloaded_at" IS NOT NULL AND NOT ut."deleted";
