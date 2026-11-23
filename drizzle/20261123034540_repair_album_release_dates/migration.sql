-- Older lib-origin builds turned a year-only release date ("2026") into the moment the album was added, so those
-- albums showed up as new releases. Take the linked iTunes collection's date when it's from the same year, else
-- keep only the year (January 1st, the convention for year-only dates). Same rule as `take_collection_date`.
UPDATE "albums_table" a
SET "release_date" = coalesce(
	(
		SELECT ic."release_date" FROM "service_ids_table" s
		JOIN "itunes_collections_table" ic ON ic."id"::text = s."applemusic_id"
		WHERE s."illusi_id" = a."id" AND ic."release_date" IS NOT NULL
			AND extract(year FROM ic."release_date" AT TIME ZONE 'UTC') = extract(year FROM a."release_date" AT TIME ZONE 'UTC')
	),
	date_trunc('year', a."release_date" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
)
WHERE abs(extract(epoch FROM a."release_date" - a."created_at")) < 120;
