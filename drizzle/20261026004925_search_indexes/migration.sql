CREATE INDEX "albums_search_trgm_idx" ON "albums_table" USING gin (illusi_search_text("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "artists_search_trgm_idx" ON "artists_table" USING gin (illusi_search_text("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "playlists_search_trgm_idx" ON "playlists_table" USING gin (illusi_search_text("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tracks_search_trgm_idx" ON "tracks_table" USING gin (illusi_search_text("title") gin_trgm_ops);