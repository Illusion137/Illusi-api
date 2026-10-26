import { z } from 'zod';
import { track_sample_data_table } from '../../db/schema';
import { truncate_to_columns } from '../../core/truncate';
import { parse_key } from '../vectors/encoding';

const unit = z.number().min(0).max(1);

/**
 * `POST /analyze` response:
 * - Mood-Detector: `mood` (one label from its fixed set), `tempo` (BPM, half-tempo corrected),
 *   `brightness` (mean spectral centroid, Hz), `key` (`C#` / `C#m`; the analyzer converts Mood-Detector's `C# major`).
 * - VibeNet (0-1): `acousticness`, `instrumentalness`, `liveness`, `danceability`, `speechiness`, `valence`,
 *   and `energy` sent as `arousal`.
 */
export const analyze_response_schema = z.object({
	mood: z.string().trim().min(1),
	tempo: z.number().nonnegative(),
	brightness: z.number().nonnegative(),
	key: z.string().trim().min(1),
	arousal: unit,
	valence: unit,
	acousticness: unit,
	instrumentalness: unit,
	liveness: unit,
	danceability: unit,
	speechiness: unit
});

export type AnalyzeResponse = z.infer<typeof analyze_response_schema>;

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Normalizes any accepted key spelling to the stored `varchar(5)` form: sharps, `m` suffix for minor. */
export function normalize_key(key: string): string | null {
	const parsed = parse_key(key);
	if (!parsed) return null;
	return `${PITCH_NAMES[parsed.pitch_class]}${parsed.major ? '' : 'm'}`;
}

export type SampleInsert = typeof track_sample_data_table.$inferInsert;

/**
 * Validates an analyzer response and maps it to a `track_sample_data_table` row.
 * Returns null when the body doesn't satisfy the contract (treated like a model failure).
 */
export function map_analysis(track_id: string, body: unknown): SampleInsert | null {
	const parsed = analyze_response_schema.safeParse(body);
	if (!parsed.success) return null;
	const r = parsed.data;
	const key = normalize_key(r.key);
	if (!key) return null;
	return truncate_to_columns(track_sample_data_table, {
		id: track_id,
		mood: r.mood,
		tempo: r.tempo,
		brightness: r.brightness,
		key,
		acousticness: r.acousticness,
		instrumentalness: r.instrumentalness,
		liveness: r.liveness,
		danceability: r.danceability,
		arousal: r.arousal,
		valence: r.valence,
		speechiness: r.speechiness
	}, `track_sample_data ${track_id}`);
}
