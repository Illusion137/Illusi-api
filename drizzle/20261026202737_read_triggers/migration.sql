-- Query statistics (the server preloads the library; see compose.yaml).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
--> statement-breakpoint

-- Play totals per track, maintained from track_plays_table. Statement-level so a batch insert costs one upsert per
-- track, and rows are upserted in track_id order so concurrent batches lock them in the same order.
CREATE OR REPLACE FUNCTION illusi_track_play_counts_insert() RETURNS trigger AS $$
BEGIN
	INSERT INTO track_play_counts_table AS c (track_id, plays)
	SELECT track_id, count(*) FROM new_rows GROUP BY track_id ORDER BY track_id
	ON CONFLICT (track_id) DO UPDATE SET plays = c.plays + EXCLUDED.plays;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION illusi_track_play_counts_delete() RETURNS trigger AS $$
BEGIN
	UPDATE track_play_counts_table c SET plays = greatest(c.plays - d.n, 0)
	FROM (SELECT track_id, count(*) AS n FROM old_rows GROUP BY track_id) d
	WHERE c.track_id = d.track_id;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Merges repoint plays with an UPDATE of track_id: the loser loses them and the survivor gains them.
CREATE OR REPLACE FUNCTION illusi_track_play_counts_update() RETURNS trigger AS $$
BEGIN
	INSERT INTO track_play_counts_table AS c (track_id, plays)
	SELECT track_id, n FROM (
		SELECT track_id, sum(n) AS n FROM (
			SELECT track_id, count(*) AS n FROM new_rows GROUP BY track_id
			UNION ALL
			SELECT track_id, -count(*) FROM old_rows GROUP BY track_id
		) x GROUP BY track_id
	) delta
	WHERE n > 0 AND EXISTS (SELECT 1 FROM tracks_table t WHERE t.id = delta.track_id)
	ORDER BY track_id
	ON CONFLICT (track_id) DO UPDATE SET plays = c.plays + EXCLUDED.plays;

	UPDATE track_play_counts_table c SET plays = greatest(c.plays + delta.n, 0)
	FROM (
		SELECT track_id, sum(n) AS n FROM (
			SELECT track_id, count(*) AS n FROM new_rows GROUP BY track_id
			UNION ALL
			SELECT track_id, -count(*) FROM old_rows GROUP BY track_id
		) x GROUP BY track_id
	) delta
	WHERE delta.n < 0 AND c.track_id = delta.track_id;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS track_play_counts_insert ON track_plays_table;
--> statement-breakpoint
CREATE TRIGGER track_play_counts_insert AFTER INSERT ON track_plays_table
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION illusi_track_play_counts_insert();
--> statement-breakpoint
DROP TRIGGER IF EXISTS track_play_counts_delete ON track_plays_table;
--> statement-breakpoint
CREATE TRIGGER track_play_counts_delete AFTER DELETE ON track_plays_table
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION illusi_track_play_counts_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS track_play_counts_update ON track_plays_table;
--> statement-breakpoint
CREATE TRIGGER track_play_counts_update AFTER UPDATE ON track_plays_table
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION illusi_track_play_counts_update();
--> statement-breakpoint
-- The triggers above already hold a lock on track_plays_table, so no play can slip in between.
INSERT INTO track_play_counts_table (track_id, plays)
SELECT track_id, count(*) FROM track_plays_table GROUP BY track_id
ON CONFLICT (track_id) DO UPDATE SET plays = EXCLUDED.plays;
--> statement-breakpoint

-- Read-API validators. A version is bumped once per transaction, at commit (deferred constraint triggers), so the
-- row lock on the counter is held only for the moment of commit and a reader never sees a new version with old data.
INSERT INTO read_versions_table (key, version) VALUES ('catalog', 0), ('plays', 0) ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION illusi_bump_read_version() RETURNS trigger AS $$
DECLARE
	flag text := 'illusi.read_version_bumped_' || TG_ARGV[0];
BEGIN
	IF current_setting(flag, true) IS DISTINCT FROM '1' THEN
		PERFORM set_config(flag, '1', true);
		UPDATE read_versions_table SET version = version + 1 WHERE key = TG_ARGV[0];
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
DECLARE
	t text;
BEGIN
	-- Every table a track, album or artist view is built from.
	FOREACH t IN ARRAY ARRAY[
		'tracks_table', 'albums_table', 'artists_table', 'tracks_artists_table', 'album_tracks_table', 'artist_albums_table',
		'tracks_producers_table', 'service_ids_table', 'thumbnails_table', 'itunes_tracks_table', 'itunes_collections_table',
		'itunes_artists_table', 'genius_artists_table', 'track_sample_data_table', 'illusi_id_redirects_table'
	] LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS read_version_catalog ON %I', t);
		EXECUTE format('CREATE CONSTRAINT TRIGGER read_version_catalog AFTER INSERT OR UPDATE OR DELETE ON %I
			DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION illusi_bump_read_version(%L)', t, 'catalog');
	END LOOP;
	-- Views only show whether media and lyrics exist; lyrics rows are also updated on read (parse cache).
	FOREACH t IN ARRAY ARRAY['media_table', 'track_lyrics_table'] LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS read_version_catalog ON %I', t);
		EXECUTE format('CREATE CONSTRAINT TRIGGER read_version_catalog AFTER INSERT OR DELETE ON %I
			DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION illusi_bump_read_version(%L)', t, 'catalog');
	END LOOP;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS read_version_plays ON track_play_counts_table;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER read_version_plays AFTER INSERT OR UPDATE OR DELETE ON track_play_counts_table
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION illusi_bump_read_version('plays');
--> statement-breakpoint

-- Per-user versions for the library overlay (library rows and plays). Transactional, so only the same user's
-- concurrent writes wait on the row. Users being deleted are skipped (their rows go with them).
CREATE OR REPLACE FUNCTION illusi_bump_user_read_versions() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO user_read_versions_table AS v (user_id, version)
		SELECT u.user_id, 1 FROM (SELECT DISTINCT user_id FROM new_rows) u
		WHERE EXISTS (SELECT 1 FROM users_table WHERE id = u.user_id) ORDER BY u.user_id
		ON CONFLICT (user_id) DO UPDATE SET version = v.version + 1;
	ELSIF TG_OP = 'DELETE' THEN
		INSERT INTO user_read_versions_table AS v (user_id, version)
		SELECT u.user_id, 1 FROM (SELECT DISTINCT user_id FROM old_rows) u
		WHERE EXISTS (SELECT 1 FROM users_table WHERE id = u.user_id) ORDER BY u.user_id
		ON CONFLICT (user_id) DO UPDATE SET version = v.version + 1;
	ELSE
		INSERT INTO user_read_versions_table AS v (user_id, version)
		SELECT u.user_id, 1 FROM (SELECT user_id FROM new_rows UNION SELECT user_id FROM old_rows) u
		WHERE EXISTS (SELECT 1 FROM users_table WHERE id = u.user_id) ORDER BY u.user_id
		ON CONFLICT (user_id) DO UPDATE SET version = v.version + 1;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['user_tracks_table', 'track_plays_table'] LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS user_read_version_insert ON %I', t);
		EXECUTE format('CREATE TRIGGER user_read_version_insert AFTER INSERT ON %I
			REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION illusi_bump_user_read_versions()', t);
		EXECUTE format('DROP TRIGGER IF EXISTS user_read_version_delete ON %I', t);
		EXECUTE format('CREATE TRIGGER user_read_version_delete AFTER DELETE ON %I
			REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION illusi_bump_user_read_versions()', t);
		EXECUTE format('DROP TRIGGER IF EXISTS user_read_version_update ON %I', t);
		EXECUTE format('CREATE TRIGGER user_read_version_update AFTER UPDATE ON %I
			REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION illusi_bump_user_read_versions()', t);
	END LOOP;
END;
$$;
--> statement-breakpoint

-- Merges change which id a track resolves to; every API process drops its resolved-playlist cache on commit.
CREATE OR REPLACE FUNCTION illusi_notify_ids_redirected() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify('illusi_events', '{"name":"ids_redirected","payload":{}}');
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notify_ids_redirected ON illusi_id_redirects_table;
--> statement-breakpoint
CREATE TRIGGER notify_ids_redirected AFTER INSERT OR UPDATE OR DELETE ON illusi_id_redirects_table
FOR EACH STATEMENT EXECUTE FUNCTION illusi_notify_ids_redirected();
