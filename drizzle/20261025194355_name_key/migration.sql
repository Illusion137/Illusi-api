-- Accent/case/punctuation-insensitive name key for §9.2 metadata candidate lookups ("Beyoncé" = "beyonce",
-- "Tyler, The Creator" = "tyler the creator"). The final decision is still the fuzzy matcher in the app.
-- unaccent() is STABLE (its dictionary could change), so the IMMUTABLE wrapper pins the dictionary explicitly.
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION illusi_name_key(value text) RETURNS text
	LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
	AS $$ SELECT regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, value)), '[^[:alnum:]]+', '', 'g') $$;
