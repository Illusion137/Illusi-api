CREATE TABLE "password_resets_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Counters are worthless after a crash, so skip the WAL.
CREATE UNLOGGED TABLE "rate_limit_counters_table" (
	"key" varchar(256),
	"window_start" timestamp with time zone,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_table_pkey" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "user_inherited_tracks_table" (
	"user_id" uuid,
	"track_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_inherited_tracks_table_pkey" PRIMARY KEY("user_id","track_id")
);
--> statement-breakpoint
ALTER TABLE "users_table" ADD COLUMN "signup_ip_prefix" varchar(64);--> statement-breakpoint
ALTER TABLE "users_table" ADD COLUMN "inherited_scope_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "password_resets_user_id_idx" ON "password_resets_table" ("user_id");--> statement-breakpoint
CREATE INDEX "rate_limit_counters_window_start_idx" ON "rate_limit_counters_table" ("window_start");--> statement-breakpoint
CREATE INDEX "user_inherited_tracks_created_at_idx" ON "user_inherited_tracks_table" ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "password_resets_table" ADD CONSTRAINT "password_resets_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_inherited_tracks_table" ADD CONSTRAINT "user_inherited_tracks_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_inherited_tracks_table" ADD CONSTRAINT "user_inherited_tracks_table_track_id_tracks_table_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks_table"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Personal rows: the same owner-only policy as the other user tables (row_level_security migration).
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['password_resets_table', 'user_inherited_tracks_table'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS owner_only ON %I', t);
		EXECUTE format('CREATE POLICY owner_only ON %I USING (user_id = (SELECT app_user_id())) WITH CHECK (user_id = (SELECT app_user_id()))', t);
	END LOOP;
END;
$$;
