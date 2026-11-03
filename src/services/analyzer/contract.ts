import { z } from 'zod';
import { track_sample_data_table } from '../../db/schema';
import { truncate_to_columns } from '../../core/truncate';
import { parse_key } from '../vectors/encoding';

const unit = z.number().min(0).max(1);

/** Samples written from an analyzer that returns Mood-Detector's other features; rows below it are analyzed again. */
export const SAMPLE_VERSION = 2;

/**
 * `POST /analyze` response:
 * - Mood-Detector: `mood` (one label from its fixed set), `tempo` (BPM, half-tempo corrected),
 *   `brightness` (mean spectral centroid, Hz), `key` (`C#` / `C#m`; the analyzer converts Mood-Detector's `C# major`).
 * - VibeNet (0-1): `acousticness`, `instrumentalness`, `liveness`, `danceability`, `speechiness`, `valence`,
 *   and `energy` sent as `arousal`.
 * - The rest of Mood-Detector's features (`tempo_confidence` through `mood_scores`); optional so an older analyzer
 *   still works during a deploy.
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
	speechiness: unit,
	tempo_confidence: z.number().nonnegative().optional(),
	rms_energy: unit.optional(),
	spectral_rolloff: z.number().nonnegative().optional(),
	zero_crossing_rate: unit.optional(),
	mfccs: z.array(z.number()).length(13).optional(),
	chroma: z.array(unit).length(12).optional(),
	duration_ms: z.number().int().nonnegative().optional(),
	mood_scores: z.record(z.string().max(64), z.number()).refine(scores => Object.keys(scores).length <= 32).optional()
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
	segments: z.array(z.object({ start_ms: ms, end_ms: ms }).refine(s => s.end_ms >= s.start_ms)).max(20_000),
	/** Beat tracking over the same file; absent from an older analyzer */
	rhythm: z.object({
		model: z.string().trim().min(1).max(128),
		bpm: z.number().nonnegative(),
		confidence: z.number().nonnegative(),
		beats_ms: z.array(ms).max(50_000),
		bpm_estimates: z.array(z.number()).max(1024)
	}).optional(),
	/** What the lyrics aligner reads; each is absent from an older analyzer */
	words: z.object({
		model: z.string().trim().min(1).max(128),
		words: z.array(z.object({ text: z.string().max(64), start_ms: ms, end_ms: ms, probability: unit })).max(20_000)
	}).optional(),
	speech: z.object({
		model: z.string().trim().min(1).max(128),
		hop_ms: z.number().int().positive(),
		voice: z.array(unit).max(500_000)
	}).optional(),
	beat_grid: z.object({
		model: z.string().trim().min(1).max(128),
		beats_ms: z.array(ms).max(50_000),
		downbeats_ms: z.array(ms).max(50_000)
	}).optional()
});

export interface VocalsResult {
	model: string;
	hop_ms: number;
	window_ms: number;
	duration_ms: number;
	voice: number[];
	/** Flat `[start_ms, end_ms, ...]`, as stored. */
	segments: number[];
	rhythm_model: string | null;
	rhythm_bpm: number | null;
	rhythm_confidence: number | null;
	beats: number[] | null;
	bpm_estimates: number[] | null;
	words_model: string | null;
	words: string[] | null;
	/** Flat `[start_ms, end_ms, ...]`, as stored. */
	word_times: number[] | null;
	word_probabilities: number[] | null;
	speech_model: string | null;
	speech_hop_ms: number | null;
	speech: number[] | null;
	beat_grid_model: string | null;
	grid_beats: number[] | null;
	downbeats: number[] | null;
}

const sorted_unique = (xs: readonly number[]) => [...new Set(xs)].sort((a, b) => a - b);

/** Validates a `/vocals` response; null when it breaks the contract (treated like a model failure). */
export function map_vocals(body: unknown): VocalsResult | null {
	const parsed = vocals_response_schema.safeParse(body);
	if (!parsed.success) return null;
	const { segments, rhythm, words, speech, beat_grid, ...rest } = parsed.data;
	const heard = words ? [...words.words].sort((a, b) => a.start_ms - b.start_ms) : null;
	return {
		...rest,
		segments: segments.flatMap(s => [s.start_ms, s.end_ms]),
		rhythm_model: rhythm?.model ?? null,
		rhythm_bpm: rhythm?.bpm ?? null,
		rhythm_confidence: rhythm?.confidence ?? null,
		beats: rhythm ? sorted_unique(rhythm.beats_ms) : null,
		bpm_estimates: rhythm ? sorted_unique(rhythm.bpm_estimates) : null,
		words_model: words?.model ?? null,
		words: heard?.map(w => w.text) ?? null,
		word_times: heard?.flatMap(w => [w.start_ms, Math.max(w.start_ms, w.end_ms)]) ?? null,
		word_probabilities: heard?.map(w => w.probability) ?? null,
		speech_model: speech?.model ?? null,
		speech_hop_ms: speech?.hop_ms ?? null,
		speech: speech?.voice ?? null,
		beat_grid_model: beat_grid?.model ?? null,
		grid_beats: beat_grid ? sorted_unique(beat_grid.beats_ms) : null,
		downbeats: beat_grid ? sorted_unique(beat_grid.downbeats_ms) : null
	};
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
		speechiness: r.speechiness,
		version: r.mfccs === undefined ? 1 : SAMPLE_VERSION,
		tempo_confidence: r.tempo_confidence ?? null,
		rms_energy: r.rms_energy ?? null,
		spectral_rolloff: r.spectral_rolloff ?? null,
		zero_crossing_rate: r.zero_crossing_rate ?? null,
		mfccs: r.mfccs ?? null,
		chroma: r.chroma ?? null,
		mood_scores: r.mood_scores ?? null,
		source_duration_ms: r.duration_ms ?? null
	}, `track_sample_data ${track_id}`);
}
