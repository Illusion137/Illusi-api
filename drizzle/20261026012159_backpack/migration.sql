CREATE TYPE "research_status" AS ENUM('PENDING', 'FOUND', 'NOT_FOUND');--> statement-breakpoint
ALTER TYPE "provenance_source" ADD VALUE 'research';--> statement-breakpoint
CREATE TABLE "track_research_table" (
	"track_id" uuid,
	"service" varchar(32),
	"status" "research_status" DEFAULT 'PENDING'::"research_status" NOT NULL,
	"requested_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"checked_by" uuid,
	"found_value" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_research_table_pkey" PRIMARY KEY("track_id","service")
);
--> statement-breakpoint
CREATE TABLE "track_unavailable_reports_table" (
	"track_id" uuid,
	"user_id" uuid,
	"service" varchar(32),
	"reason" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_unavailable_reports_table_pkey" PRIMARY KEY("track_id","user_id","service")
);
--> statement-breakpoint
ALTER TABLE "tracks_table" ADD COLUMN "backpacked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tracks_backpacked_at_idx" ON "tracks_table" ("backpacked_at") WHERE "backpacked";--> statement-breakpoint
ALTER TABLE "track_research_table" ADD CONSTRAINT "track_research_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_research_table" ADD CONSTRAINT "track_research_table_checked_by_users_table_id_fkey" FOREIGN KEY ("checked_by") REFERENCES "users_table"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "track_unavailable_reports_table" ADD CONSTRAINT "track_unavailable_reports_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_unavailable_reports_table" ADD CONSTRAINT "track_unavailable_reports_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;