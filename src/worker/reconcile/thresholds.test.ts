import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { DEFAULT_THRESHOLDS, thresholds_from_config } from './thresholds';

describe('thresholds_from_config', () => {
	it('takes the tunables from the config and keeps the rest at the defaults', () => {
		const t = thresholds_from_config();
		expect(t.split_duration_gap_ms).toBe(config.RECONCILE_SPLIT_DURATION_GAP_MS);
		expect(t.audio_match_distance).toBe(config.RECONCILE_AUDIO_MATCH_DISTANCE);
		expect(t.audio_contradiction_distance).toBe(config.RECONCILE_AUDIO_CONTRADICTION_DISTANCE);
		expect(t.review_min_confidence).toBe(config.RECONCILE_REVIEW_MIN_CONFIDENCE);
		expect(t.max_group_size).toBe(config.RECONCILE_MAX_GROUP_SIZE);
		expect(t.weights).toEqual(DEFAULT_THRESHOLDS.weights);
		expect(t.name_match).toBe(DEFAULT_THRESHOLDS.name_match);
	});
});
