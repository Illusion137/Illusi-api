/**
 * Track feature vector encoding. One pure, versioned function: any change to the layout,
 * scaling or weights must bump `CURRENT_VECTOR_VERSION` so startup rebuilds stored vectors.
 */

export const CURRENT_VECTOR_VERSION = 1;

/**
 * Every label Mood-Detector's rule-based classifier can return (`mood_detector/mood_classifier.py`,
 * `detect_mood`). Order is part of the encoding: append only, and bump the version when it changes.
 */
export const MOOD_LABELS = [
	'Ambient/Drone',
	'Atmospheric/Textural',
	'Noise/Experimental',
	'Harsh Noise/Experimental',
	'Glitch/Experimental',
	'Techno/Dark',
	'Techno/Industrial',
	'Energetic/Rave',
	'Disco/Funk',
	'House/Dance',
	'Dark House',
	'Club/Groovy',
	'Drum & Bass',
	'Breakbeat/Fast',
	'Fast/Atmospheric',
	'Hard/Aggressive',
	'Driving Electronic',
	'Ambient/Atmospheric',
	'Melancholic/Sad',
	'Downtempo/Relaxed',
	'Downtempo/Dark',
	'Ambient/Chill',
	'Midtempo Groove',
	'Minimal/Sparse',
	'Upbeat/Moderate',
	'Moderate Groove',
	'Relaxed/Moderate',
	'Low Energy'
] as const;

export const AUDIO_FEATURES = ['acousticness', 'instrumentalness', 'liveness', 'danceability', 'speechiness', 'valence', 'arousal'] as const;

/** Per-group weights, applied when the vector is built. All start at 1.0. */
export const GROUP_WEIGHTS = {
	features: 1.0,
	tempo: 1.0,
	brightness: 1.0,
	key: 1.0,
	mood: 1.0
} as const;

/** Layout: 7 audio features, tempo, brightness, key (sin, cos, major flag), mood one-hot. */
export const VECTOR_DIMENSIONS = AUDIO_FEATURES.length + 1 + 1 + 3 + MOOD_LABELS.length;

export const TEMPO_CLAMP = { min: 60, max: 200 } as const;
/** Tempos are folded into this one-octave band before scaling, so half/double tempo map to the same value. */
export const TEMPO_OCTAVE = { low: 70, high: 140 } as const;
/**
 * Mood-Detector brightness is the mean spectral centroid in Hz (librosa, 22.05 kHz). Music sits roughly
 * in 500-5000 Hz; Mood-Detector itself treats 5000 Hz as fully bright.
 */
export const BRIGHTNESS_RANGE_HZ = { min: 500, max: 5000 } as const;

export interface SampleFeatures {
	mood: string;
	tempo: number;
	brightness: number;
	key: string;
	acousticness: number;
	instrumentalness: number;
	liveness: number;
	danceability: number;
	speechiness: number;
	valence: number;
	arousal: number;
}

const clamp01 = (x: number) => Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;

/** Clamps to 60-200 BPM, folds into [70, 140) and scales to [0, 1). Non-positive/NaN tempo → 0. */
export function fold_tempo(bpm: number): number {
	if (!Number.isFinite(bpm) || bpm <= 0) return 0;
	let t = Math.min(TEMPO_CLAMP.max, Math.max(TEMPO_CLAMP.min, bpm));
	while (t >= TEMPO_OCTAVE.high) t /= 2;
	while (t < TEMPO_OCTAVE.low) t *= 2;
	// log scale inside the octave: equal musical ratios get equal distances.
	return Math.log2(t / TEMPO_OCTAVE.low) / Math.log2(TEMPO_OCTAVE.high / TEMPO_OCTAVE.low);
}

export function scale_brightness(hz: number): number {
	return clamp01((hz - BRIGHTNESS_RANGE_HZ.min) / (BRIGHTNESS_RANGE_HZ.max - BRIGHTNESS_RANGE_HZ.min));
}

const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Parses `C#m` / `C#` (the stored format) and Mood-Detector's raw `C# minor` / `C# major`. Flats accepted.
 * Returns null when unparseable.
 */
export function parse_key(key: string): { pitch_class: number; major: boolean } | null {
	const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major)?\s*$/i.exec(key);
	if (!m) return null;
	const [, letter, accidental, mode] = m;
	let pc = NOTE_PC[letter.toUpperCase()];
	if (accidental === '#' || accidental === '♯') pc += 1;
	else if (accidental === 'b' || accidental === '♭') pc -= 1;
	const lower = mode?.toLowerCase();
	const major = !(lower === 'm' || lower === 'min' || lower === 'minor');
	// Keep a lone uppercase "M" as major (some tools write CM), but lowercase "m" is minor.
	return { pitch_class: (pc + 12) % 12, major: mode === 'M' ? true : major };
}

/**
 * Circle-of-fifths position (0-11) of a key. Minor keys take their relative major's position
 * (Am → C, Camelot-style), so keys sharing a scale coincide and neighbours on the wheel stay close;
 * the mode flag still separates relative major/minor.
 */
export function circle_of_fifths_position(pitch_class: number, major: boolean): number {
	const tonic = major ? pitch_class : (pitch_class + 3) % 12;
	return (tonic * 7) % 12;
}

/** [sin, cos, major] with sin/cos shifted into [0, 1]. Unknown key → neutral [0.5, 0.5, 0.5]. */
export function encode_key(key: string): [number, number, number] {
	const parsed = parse_key(key);
	if (!parsed) return [0.5, 0.5, 0.5];
	const angle = (2 * Math.PI * circle_of_fifths_position(parsed.pitch_class, parsed.major)) / 12;
	return [(Math.sin(angle) + 1) / 2, (Math.cos(angle) + 1) / 2, parsed.major ? 1 : 0];
}

/** One-hot over `MOOD_LABELS`; unknown labels encode as all zeros. */
export function encode_mood(mood: string): number[] {
	const out = new Array<number>(MOOD_LABELS.length).fill(0);
	const index = (MOOD_LABELS as readonly string[]).indexOf(mood.trim());
	if (index >= 0) out[index] = 1;
	return out;
}

/** Builds the embedding for one `track_sample_data_table` row. Length is `VECTOR_DIMENSIONS`. */
export function encode_sample(sample: SampleFeatures, weights: Readonly<Record<keyof typeof GROUP_WEIGHTS, number>> = GROUP_WEIGHTS): number[] {
	const w = (group: number[], weight: number) => group.map(x => x * weight);
	return [
		...w(AUDIO_FEATURES.map(f => clamp01(sample[f])), weights.features),
		...w([fold_tempo(sample.tempo)], weights.tempo),
		...w([scale_brightness(sample.brightness)], weights.brightness),
		...w(encode_key(sample.key), weights.key),
		...w(encode_mood(sample.mood), weights.mood)
	];
}
