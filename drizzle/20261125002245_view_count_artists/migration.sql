-- A `$` written for an s (`KA$HDAMI`, `$umn$light`, `Bada$$`) is an s in the name key, as in `normalize_name`, so
-- `KASHDAMI` finds `KA$HDAMI` as a candidate. `$100` keeps its `$` (and loses it with the other punctuation).
CREATE OR REPLACE FUNCTION illusi_name_key(value text) RETURNS text
	LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
	AS $$ SELECT regexp_replace(
		regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, value)), '(?<=[[:alpha:]]\$*)\$|\$(?=\$*[[:alpha:]])', 's', 'g'),
		'[^[:alnum:]]+', '', 'g') $$;
--> statement-breakpoint
REINDEX INDEX "artists_name_key_idx";
--> statement-breakpoint
REINDEX INDEX "albums_name_key_idx";
--> statement-breakpoint
-- Older clients credited the view count YouTube shows beside a channel (`175K`, `1.2M`) as an artist; a later
-- contribution added the real artist, so those tracks read `175K, Lelo`. The view count's credit goes wherever the
-- track or album has a real artist too. A track credited to nothing else (a real artist named `10k`) keeps it.
CREATE TEMP TABLE "view_count_artists" ON COMMIT DROP AS
	SELECT "id" FROM "artists_table" WHERE "name" ~* '^[0-9][0-9.,]*(\s*[KMB]|\s*[KMB]?\s+(views?|plays?))$';
--> statement-breakpoint
WITH "dropped" AS (
	DELETE FROM "tracks_artists_table" ta USING "view_count_artists" v
	WHERE ta."artist_id" = v."id"
		AND EXISTS (SELECT 1 FROM "tracks_artists_table" o WHERE o."track_id" = ta."track_id" AND o."artist_id" NOT IN (SELECT "id" FROM "view_count_artists"))
	RETURNING ta."track_id"
)
UPDATE "tracks_table" SET "modified_at" = now() WHERE "id" IN (SELECT "track_id" FROM "dropped");
--> statement-breakpoint
UPDATE "albums_table" al SET "artist_id" = (
	SELECT aa."artist_id" FROM "artist_albums_table" aa
	WHERE aa."album_id" = al."id" AND aa."artist_id" NOT IN (SELECT "id" FROM "view_count_artists")
	ORDER BY aa."position" NULLS LAST LIMIT 1
), "modified_at" = now()
WHERE al."artist_id" IN (SELECT "id" FROM "view_count_artists")
	AND EXISTS (SELECT 1 FROM "artist_albums_table" aa WHERE aa."album_id" = al."id" AND aa."artist_id" NOT IN (SELECT "id" FROM "view_count_artists"));
--> statement-breakpoint
WITH "dropped" AS (
	DELETE FROM "artist_albums_table" aa USING "view_count_artists" v
	WHERE aa."artist_id" = v."id"
		AND EXISTS (SELECT 1 FROM "artist_albums_table" o WHERE o."album_id" = aa."album_id" AND o."artist_id" NOT IN (SELECT "id" FROM "view_count_artists"))
	RETURNING aa."album_id"
)
UPDATE "albums_table" SET "modified_at" = now() WHERE "id" IN (SELECT "album_id" FROM "dropped");
--> statement-breakpoint
-- Left with no credit at all, they're deleted, ids and all: an Apple Music id on one came from an unrelated artist
-- that happens to be called `16K`.
WITH "gone" AS (
	DELETE FROM "artists_table" a USING "view_count_artists" v
	WHERE a."id" = v."id"
		AND NOT EXISTS (SELECT 1 FROM "tracks_artists_table" x WHERE x."artist_id" = a."id")
		AND NOT EXISTS (SELECT 1 FROM "albums_table" x WHERE x."artist_id" = a."id")
		AND NOT EXISTS (SELECT 1 FROM "artist_albums_table" x WHERE x."artist_id" = a."id")
	RETURNING a."id"
)
DELETE FROM "service_ids_table" s USING "gone" WHERE s."illusi_id" = "gone"."id";
--> statement-breakpoint
-- iTunes lookups that missed a `$` name (`$umn$light` by KASHDAMI is `SumnSlight` by KA$HDAMI) are tried again now
-- that names fold `$` to s.
UPDATE "itunes_lookups_table" l SET "retry_after" = now()
WHERE l."status" = 'NOT_FOUND' AND (
	EXISTS (SELECT 1 FROM "tracks_table" t WHERE t."id" = l."illusi_id" AND (t."title" LIKE '%$%'
		OR EXISTS (SELECT 1 FROM "tracks_artists_table" ta JOIN "artists_table" a ON a."id" = ta."artist_id" WHERE ta."track_id" = t."id" AND a."name" LIKE '%$%')))
	OR EXISTS (SELECT 1 FROM "albums_table" al LEFT JOIN "artists_table" a ON a."id" = al."artist_id" WHERE al."id" = l."illusi_id" AND (al."name" LIKE '%$%' OR a."name" LIKE '%$%'))
	OR EXISTS (SELECT 1 FROM "artists_table" a WHERE a."id" = l."illusi_id" AND a."name" LIKE '%$%')
);
--> statement-breakpoint
DROP TABLE "view_count_artists";
