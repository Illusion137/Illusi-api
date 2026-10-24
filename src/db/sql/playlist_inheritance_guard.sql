CREATE OR REPLACE FUNCTION guard_playlist_inheritance() RETURNS trigger AS $$
DECLARE
	max_inheritances CONSTANT integer := 10;
BEGIN
	IF NEW.deleted THEN
		RETURN NEW;
	END IF;

	-- Serialize inheritance writes so concurrent inserts can't each pass the checks and then form a cycle together.
	PERFORM pg_advisory_xact_lock(hashtext('playlist_inherited_playlists_guard'));

	IF (
		SELECT count(*) FROM playlist_inherited_playlists_table
		WHERE playlist_id = NEW.playlist_id AND NOT deleted AND id IS DISTINCT FROM NEW.id
	) >= max_inheritances THEN
		RAISE EXCEPTION 'playlist % cannot inherit more than % playlists', NEW.playlist_id, max_inheritances
			USING ERRCODE = 'check_violation';
	END IF;

	-- The new edge playlist_id -> ref_id closes a cycle if ref_id already reaches playlist_id.
	IF EXISTS (
		WITH RECURSIVE reachable(id) AS (
			SELECT NEW.ref_id
			UNION
			SELECT e.ref_id FROM playlist_inherited_playlists_table e
			JOIN reachable r ON e.playlist_id = r.id
			WHERE NOT e.deleted AND e.id IS DISTINCT FROM NEW.id
		)
		SELECT 1 FROM reachable WHERE id = NEW.playlist_id
	) THEN
		RAISE EXCEPTION 'playlist % inheriting playlist % would create a cycle', NEW.playlist_id, NEW.ref_id
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER playlist_inherited_playlists_guard
BEFORE INSERT OR UPDATE OF playlist_id, ref_id, deleted ON playlist_inherited_playlists_table
FOR EACH ROW EXECUTE FUNCTION guard_playlist_inheritance();
