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

const ms = z.number().int().nonnegative();

/**
 * `POST /vocals` response: `voice[i]` is the voice probability of the window `[i * hop_ms, i * hop_ms + window_ms)`,
 * `segments` the voiced spans derived from it.
 */
export const vocals_response_schema = z.object({
	model: z.string().trim().min(1).max(128),
	hop_ms: z.number().int().positive(),
	window_ms: z.number().int().positive(),
	duration_ms: ms,
	voice: z.array(unit).max(200_000),
	segments: z.array(z.object({ start_ms: ms, end_ms: ms }).refine(s => s.end_ms >= s.start_ms)).max(20_000)
});

export interface VocalsResult {
	model: string;
	hop_ms: number;
	window_ms: number;
	duration_ms: number;
	voice: number[];
	/** Flat `[start_ms, end_ms, ...]`, as stored. */
	segments: number[];
}

/** Validates a `/vocals` response; null when it breaks the contract (treated like a model failure). */
export function map_vocals(body: unknown): VocalsResult | null {
	const parsed = vocals_response_schema.safeParse(body);
	if (!parsed.success) return null;
	const { segments, ...rest } = parsed.data;
	return { ...rest, segments: segments.flatMap(s => [s.start_ms, s.end_ms]) };
}

/** Stored flat segments back to `{ start_ms, end_ms }` pairs. */
export function unflatten_segments(flat: readonly number[]): { start_ms: number; end_ms: number }[] {
	const out: { start_ms: number; end_ms: number }[] = [];
	for (let i = 0; i + 1 < flat.length; i += 2) out.push({ start_ms: flat[i], end_ms: flat[i + 1] });
	return out;
}

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
