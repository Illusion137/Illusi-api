-- Row-level security for everything a user owns. Authenticated requests run as a role without BYPASSRLS and with
-- `app.user_id` set (src/db/index.ts); the table owner (migrations, background jobs, login) is exempt. Unset means no rows.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY[
		'sessions_table', 'action_token_uses_table', 'user_tracks_table', 'user_recent_searches', 'track_plays_table',
		'user_read_versions_table', 'linked_playlists_table', 'contributions_log_table', 'export_jobs_table',
		'sync_pushes_table', 'track_unavailable_reports_table', 'email_verifications_table'
	] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS owner_only ON %I', t);
		EXECUTE format('CREATE POLICY owner_only ON %I USING (user_id = (SELECT app_user_id())) WITH CHECK (user_id = (SELECT app_user_id()))', t);
	END LOOP;
END;
$$;
--> statement-breakpoint

ALTER TABLE users_table ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS owner_only ON users_table;
--> statement-breakpoint
CREATE POLICY owner_only ON users_table USING (id = (SELECT app_user_id())) WITH CHECK (id = (SELECT app_user_id()));
--> statement-breakpoint
-- Public playlists show their owner's username.
DROP POLICY IF EXISTS playlist_owner_visible ON users_table;
--> statement-breakpoint
CREATE POLICY playlist_owner_visible ON users_table FOR SELECT USING ((SELECT app_user_id()) IS NOT NULL AND EXISTS (SELECT 1 FROM playlists_table p WHERE p.user_id = users_table.id));
--> statement-breakpoint

-- Playlists: everyone sees public ones, only the owner changes them.
ALTER TABLE playlists_table ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS visible ON playlists_table;
--> statement-breakpoint
CREATE POLICY visible ON playlists_table FOR SELECT USING (user_id = (SELECT app_user_id()) OR ((SELECT app_user_id()) IS NOT NULL AND public AND NOT deleted));
--> statement-breakpoint
DROP POLICY IF EXISTS owner_insert ON playlists_table;
--> statement-breakpoint
CREATE POLICY owner_insert ON playlists_table FOR INSERT WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS owner_update ON playlists_table;
--> statement-breakpoint
CREATE POLICY owner_update ON playlists_table FOR UPDATE USING (user_id = (SELECT app_user_id())) WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS owner_delete ON playlists_table;
--> statement-breakpoint
CREATE POLICY owner_delete ON playlists_table FOR DELETE USING (user_id = (SELECT app_user_id()));
--> statement-breakpoint

-- Playlist contents follow their playlist: readable where the playlist is, writable by its owner.
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['playlist_tracks_table', 'playlist_inherited_searches_table', 'playlist_inherited_playlists_table'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS visible ON %I', t);
		EXECUTE format('CREATE POLICY visible ON %I FOR SELECT USING (EXISTS (SELECT 1 FROM playlists_table p WHERE p.id = playlist_id))', t);
		EXECUTE format('DROP POLICY IF EXISTS owner_insert ON %I', t);
		EXECUTE format('CREATE POLICY owner_insert ON %I FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM playlists_table p WHERE p.id = playlist_id AND p.user_id = (SELECT app_user_id())))', t);
		EXECUTE format('DROP POLICY IF EXISTS owner_update ON %I', t);
		EXECUTE format('CREATE POLICY owner_update ON %I FOR UPDATE USING (EXISTS (SELECT 1 FROM playlists_table p WHERE p.id = playlist_id AND p.user_id = (SELECT app_user_id()))) WITH CHECK (EXISTS (SELECT 1 FROM playlists_table p WHERE p.id = playlist_id AND p.user_id = (SELECT app_user_id())))', t);
		EXECUTE format('DROP POLICY IF EXISTS owner_delete ON %I', t);
		EXECUTE format('CREATE POLICY owner_delete ON %I FOR DELETE USING (EXISTS (SELECT 1 FROM playlists_table p WHERE p.id = playlist_id AND p.user_id = (SELECT app_user_id())))', t);
	END LOOP;
END;
$$;
--> statement-breakpoint

-- Triggers that read or bump rows across users must not be narrowed by the caller's policies.
ALTER FUNCTION guard_playlist_inheritance() SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION guard_playlist_inheritance_same_owner() SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION illusi_bump_user_read_versions() SECURITY DEFINER SET search_path = public, pg_temp;
