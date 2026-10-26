-- Case- and accent-insensitive text for trigram search: "Beyoncé" and "beyonce" both search as "beyonce".
-- Unlike illusi_name_key, spaces and punctuation are kept so word boundaries still count for similarity.
-- unaccent() is STABLE (its dictionary could change), so the IMMUTABLE wrapper pins the dictionary explicitly.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION illusi_search_text(value text) RETURNS text
	LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
	AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, value)) $$;
