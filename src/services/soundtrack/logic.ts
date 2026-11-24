/**
 * Pure parts of "My Soundtrack": what a user has on heavy rotation, mixed with tracks picked for them, in an order
 * that changes once a day and doesn't play the same artist twice in a row when it can help it.
 */

/** A track the user has been playing lately; `score` weighs each play by how recent it was. */
export interface RotationTrack { track_id: string; plays: number; score: number }

export type SoundtrackReason = 'heavy_rotation' | 'for_you';
export interface SoundtrackPick { track_id: string; reason: SoundtrackReason }

export interface MixOptions {
	rotation: readonly RotationTrack[];
	/** Picked for the user, best first */
	recommended: readonly string[];
	/** Credited artists per track, for spacing */
	artists: ReadonlyMap<string, readonly string[]>;
	limit: number;
	random: () => number;
	/** Share of the soundtrack that is heavy rotation when both sides have enough */
	rotation_share?: number;
}

export const DEFAULT_ROTATION_SHARE = 0.4;
/** How far ahead a list is searched for a track by a different artist than the one just placed */
const SPACING_LOOKAHEAD = 6;

/** The seed for a user's soundtrack on a given (UTC) day: the same all day, different the next. */
export const day_seed = (user_id: string, now: Date) => `${user_id}:${now.toISOString().slice(0, 10)}`;

/** A small seeded PRNG (FNV-1a hash of the seed into mulberry32), uniform on [0, 1). */
export function seeded_random(seed: string): () => number {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
	let state = h >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** Weighted random order without replacement (Efraimidis–Spirakis): heavier items tend to come first. */
export function weighted_order<T>(items: readonly T[], weight: (item: T, index: number) => number, random: () => number): T[] {
	return items
		.map((item, index) => ({ item, key: Math.pow(random() || Number.MIN_VALUE, 1 / Math.max(weight(item, index), 1e-9)) }))
		.sort((a, b) => b.key - a.key)
		.map(({ item }) => item);
}

/** How many of each side to take: the asked share, with either side filling in for what the other lacks. */
export function split_counts(rotation: number, recommended: number, limit: number, share = DEFAULT_ROTATION_SHARE): { rotation: number; recommended: number } {
	let from_rotation = Math.min(rotation, Math.round(limit * share));
	const from_recommended = Math.min(recommended, limit - from_rotation);
	from_rotation = Math.min(rotation, limit - from_recommended);
	return { rotation: from_rotation, recommended: from_recommended };
}

/**
 * The soundtrack: heavy rotation (hotter tracks more likely to make the cut) and recommendations (better ones more
 * likely), spread evenly through each other, opening with something familiar.
 */
export function mix_soundtrack(opts: MixOptions): SoundtrackPick[] {
	const rotation_ids = new Set(opts.rotation.map(r => r.track_id));
	const recommended = [...new Set(opts.recommended)].filter(id => !rotation_ids.has(id));
	const counts = split_counts(opts.rotation.length, recommended.length, opts.limit, opts.rotation_share);
	const queues: Record<SoundtrackReason, string[]> = {
		heavy_rotation: weighted_order(opts.rotation, r => r.score, opts.random).slice(0, counts.rotation).map(r => r.track_id),
		// Only the best few times as many as needed are in the running, so a day's mix stays close to the user's taste.
		for_you: weighted_order(recommended.slice(0, counts.recommended * 2), (_, index) => 1 / (1 + index), opts.random).slice(0, counts.recommended)
	};
	const total = queues.heavy_rotation.length + queues.for_you.length;
	const placed: Record<SoundtrackReason, number> = { heavy_rotation: 0, for_you: 0 };
	const out: SoundtrackPick[] = [];
	let previous: readonly string[] = [];
	while (out.length < total) {
		// Whichever side is furthest behind its even share goes next; ties go to heavy rotation.
		const progress = (reason: SoundtrackReason) => (queues[reason].length === 0 ? Infinity : placed[reason] / (placed[reason] + queues[reason].length));
		const reason: SoundtrackReason = progress('heavy_rotation') <= progress('for_you') ? 'heavy_rotation' : 'for_you';
		const queue = queues[reason];
		const clashes = (id: string) => (opts.artists.get(id) ?? []).some(artist => previous.includes(artist));
		let index = queue.slice(0, SPACING_LOOKAHEAD).findIndex(id => !clashes(id));
		if (index === -1) index = 0;
		const [track_id] = queue.splice(index, 1);
		placed[reason]++;
		out.push({ track_id, reason });
		previous = opts.artists.get(track_id) ?? [];
	}
	return out;
}
