CREATE TABLE "track_vocals_table" (
	"track_id" uuid PRIMARY KEY,
	"resource_id" varchar(256) NOT NULL,
	"status" "sample_lookup_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_after" timestamp with time zone,
	"model" varchar(128),
	"hop_ms" integer,
	"window_ms" integer,
	"duration_ms" integer,
	"voice" real[],
	"segments" integer[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD CONSTRAINT "track_vocals_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;