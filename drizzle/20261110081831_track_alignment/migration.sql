CREATE TABLE "track_alignment_table" (
	"track_id" uuid PRIMARY KEY,
	"resource_id" varchar(256) NOT NULL,
	"status" "sample_lookup_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_after" timestamp with time zone,
	"model" varchar(128),
	"duration_ms" integer,
	"frame_ms" double precision,
	"alphabet" varchar(64),
	"letter_scale" real,
	"letters" bytea,
	"loudness" bytea,
	"words_model" varchar(128),
	"words" text[],
	"word_times" integer[],
	"word_probabilities" real[],
	"beat_grid_model" varchar(128),
	"grid_beats" integer[],
	"downbeats" integer[],
	"repeats" integer[],
	"repeat_strengths" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "track_alignment_table" ADD CONSTRAINT "track_alignment_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;