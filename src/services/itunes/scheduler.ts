export type Lane = 'live' | 'backfill';

export interface LaneRatio { live: number; backfill: number }

const DEFAULT_RATIO: LaneRatio = { live: 3, backfill: 1 };

/** Parses `ITUNES_LIVE_TO_BACKFILL` (`"3:1"`); anything malformed falls back to 3:1. */
export function parse_lane_ratio(value: string | undefined): LaneRatio {
	const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/u.exec(value ?? '');
	if (!m) return { ...DEFAULT_RATIO };
	const live = Number(m[1]);
	const backfill = Number(m[2]);
	if (live === 0 && backfill === 0) return { ...DEFAULT_RATIO };
	return { live, backfill };
}

/**
 * Interleaves the live and backfill lanes at a fixed ratio. An empty lane gives its turns
 * to the other one; a zero side of the ratio only runs when the other lane is empty.
 */
export class LaneScheduler {
	private live_turns = 0;
	private backfill_turns = 0;

	constructor(private readonly ratio: LaneRatio) {}

	next(live_size: number, backfill_size: number): Lane | null {
		if (live_size === 0 && backfill_size === 0) return null;
		if (backfill_size === 0) return 'live';
		if (live_size === 0) return 'backfill';
		if (this.live_turns >= this.ratio.live && this.backfill_turns >= this.ratio.backfill) {
			this.live_turns = 0;
			this.backfill_turns = 0;
		}
		if (this.live_turns < this.ratio.live) {
			this.live_turns++;
			return 'live';
		}
		this.backfill_turns++;
		return 'backfill';
	}
}
