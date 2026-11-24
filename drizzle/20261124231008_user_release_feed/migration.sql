CREATE TABLE "user_release_feed_table" (
	"user_id" uuid,
	"service" varchar(32),
	"external_id" varchar(256),
	"kind" varchar(16) NOT NULL,
	"name" varchar(1024) NOT NULL,
	"album_type" varchar(32),
	"artists" jsonb DEFAULT '[]' NOT NULL,
	"artwork_url" varchar(1024),
	"url" varchar(1024),
	"explicit" boolean,
	"released_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_release_feed_table_pkey" PRIMARY KEY("user_id","service","external_id")
);
--> statement-breakpoint
ALTER TABLE "user_release_feed_table" ADD CONSTRAINT "user_release_feed_table_user_id_users_table_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users_table"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Each user's feed is theirs (see 20261031033716_row_level_security).
ALTER TABLE "user_release_feed_table" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_only ON "user_release_feed_table" USING (user_id = (SELECT app_user_id())) WITH CHECK (user_id = (SELECT app_user_id()));
