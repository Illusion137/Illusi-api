ALTER TABLE "users_table" ADD COLUMN "public_imports" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Users who make their imports public show up as profiles, with those imported library rows readable by anyone signed in.
DROP POLICY IF EXISTS public_imports_visible ON users_table;
--> statement-breakpoint
CREATE POLICY public_imports_visible ON users_table FOR SELECT USING ((SELECT app_user_id()) IS NOT NULL AND public_imports);
--> statement-breakpoint
DROP POLICY IF EXISTS public_imports_visible ON user_tracks_table;
--> statement-breakpoint
CREATE POLICY public_imports_visible ON user_tracks_table FOR SELECT USING (
	(SELECT app_user_id()) IS NOT NULL
	AND NOT deleted
	AND EXISTS (SELECT 1 FROM users_table u WHERE u.id = user_tracks_table.user_id AND u.public_imports)
	AND EXISTS (SELECT 1 FROM tracks_table t WHERE t.id = user_tracks_table.track_id AND t.imported)
);
