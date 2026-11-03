ALTER TABLE "track_vocals_table" ADD COLUMN "words_model" varchar(128);--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "words" text[];--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "word_times" integer[];--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "word_probabilities" real[];--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "speech_model" varchar(128);--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "speech_hop_ms" integer;--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "speech" real[];--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "beat_grid_model" varchar(128);--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "grid_beats" integer[];--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "downbeats" integer[];