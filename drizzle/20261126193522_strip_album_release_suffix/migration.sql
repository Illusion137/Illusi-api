-- Apple Music names releases "Name - Single", "Name - EP" or "Name - Album", and library pushes stored albums that way.
-- Albums are stored without it (`split_release_suffix`); the suffix fills a missing type.
UPDATE "albums_table"
SET "album_type" = coalesce("album_type", upper(substring("name" FROM '(?i)\s+[-–—]\s+(single|ep|album)$'))::"album_type"),
	"name" = regexp_replace("name", '\s+[-–—]\s+(single|ep|album)$', '', 'i'),
	"modified_at" = now()
WHERE "name" ~* '\s+[-–—]\s+(single|ep|album)$'
	AND btrim(regexp_replace("name", '\s+[-–—]\s+(single|ep|album)$', '', 'i')) <> '';
