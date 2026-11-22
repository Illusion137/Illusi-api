-- The analyzer used to give a track without a duration the length of the audio it analyzed, including ~30 s iTunes
-- previews (29 929 / 29 952 / 29 976 ms). Those durations then split tracks off their real iTunes entries. Clear them
-- where nobody else vouches for the length (no uploaded media, no user duration reports, no iTunes entry that long);
-- modified_at moves so clients pull the change.
UPDATE "tracks_table" t SET "duration_ms" = NULL, "modified_at" = now()
WHERE t."duration_ms" IN (29929, 29952, 29976)
	AND NOT EXISTS (SELECT 1 FROM "media_table" m WHERE m."track_id" = t."id")
	AND NOT EXISTS (SELECT 1 FROM "track_duration_reports_table" d WHERE d."track_id" = t."id")
	AND NOT EXISTS (
		SELECT 1 FROM "service_ids_table" s JOIN "itunes_tracks_table" it ON s."applemusic_id" = it."id"::text
		WHERE s."illusi_id" = t."id" AND it."track_time_millis" = t."duration_ms"
	);--> statement-breakpoint
-- Merges on hard evidence (a shared unique id) no longer raise review items; acknowledge the ones still open.
UPDATE "review_items_table" SET "status" = 'DISMISSED', "resolved_at" = now(), "modified_at" = now()
WHERE "kind" = 'AUTO_MERGE' AND "status" = 'OPEN' AND NOT ("details"->'reasons' ? 'transitive');
