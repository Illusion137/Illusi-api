ALTER TABLE "track_sample_data_table" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD COLUMN "tempo_confidence" real;--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD COLUMN "rms_energy" real;--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD COLUMN "spectral_rolloff" real;--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD COLUMN "zero_crossing_rate" real;--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD COLUMN "mfccs" real[];--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD COLUMN "chroma" real[];--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD COLUMN "mood_scores" jsonb;--> statement-breakpoint
ALTER TABLE "track_sample_data_table" ADD COLUMN "source_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "rhythm_model" varchar(128);--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "rhythm_bpm" real;--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "rhythm_confidence" real;--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "beats" integer[];--> statement-breakpoint
ALTER TABLE "track_vocals_table" ADD COLUMN "bpm_estimates" real[];