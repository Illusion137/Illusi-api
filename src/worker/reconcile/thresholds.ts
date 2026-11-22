import { config } from '../../config';
import { DEFAULT_SIMILARITY_THRESHOLD, DURATION_TOLERANCE_MS } from '../../core/normalize';

/** Every tunable of the resolver. */
export interface Thresholds {
	/** Name similarity counted as a match. */
	name_match: number;
	/** Name similarity below which titles clearly disagree. */
	name_contradiction: number;
	duration_tolerance_ms: number;
	/** Duration gap that is hard evidence of different recordings (split, and blocks merges). */
	split_duration_gap_ms: number;
	audio_match_distance: number;
	audio_contradiction_distance: number;
	/** Without hard evidence: at or above → admin review, below → dismissed. */
	review_min_confidence: number;
	max_group_size: number;
	/** Largest metadata block linked by "strong metadata match"; bigger blocks are too generic to group. */
	max_metadata_block: number;
	weights: {
		cross_service_id: number;
		shared_unique_id: number;
		same_isrc: number;
		title: number;
		artist: number;
		album: number;
		track_number: number;
		duration: number;
		explicit: number;
		release_year: number;
		/** Two albums whose track lists mostly agree. */
		album_tracks: number;
		audio: number;
		weak_contradiction: number;
		strong_contradiction: number;
	};
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	name_match: DEFAULT_SIMILARITY_THRESHOLD,
	name_contradiction: 0.5,
	duration_tolerance_ms: DURATION_TOLERANCE_MS,
	split_duration_gap_ms: DURATION_TOLERANCE_MS,
	audio_match_distance: 0.02,
	audio_contradiction_distance: 0.25,
	review_min_confidence: 0.5,
	max_group_size: 50,
	max_metadata_block: 20,
	weights: {
		cross_service_id: 0.6,
		shared_unique_id: 0.45,
		same_isrc: 0.4,
		title: 0.15,
		artist: 0.1,
		album: 0.05,
		track_number: 0.05,
		duration: 0.15,
		explicit: 0.03,
		release_year: 0.03,
		album_tracks: 0.2,
		audio: 0.15,
		weak_contradiction: 0.15,
		strong_contradiction: 0.5
	}
};

export function thresholds_from_config(): Thresholds {
	return {
		...DEFAULT_THRESHOLDS,
		split_duration_gap_ms: config.RECONCILE_SPLIT_DURATION_GAP_MS,
		audio_match_distance: config.RECONCILE_AUDIO_MATCH_DISTANCE,
		audio_contradiction_distance: config.RECONCILE_AUDIO_CONTRADICTION_DISTANCE,
		review_min_confidence: config.RECONCILE_REVIEW_MIN_CONFIDENCE,
		max_group_size: config.RECONCILE_MAX_GROUP_SIZE
	};
}
