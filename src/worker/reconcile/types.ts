import type { ServiceIdColumn } from '../../core/service_ids';

export type EntityKind = 'track' | 'album' | 'artist' | 'unknown';

/** Where a claim on an external id comes from. `stored` = a `service_ids_table` value no service data confirms. */
export type ClaimSource = 'stored' | 'itunes' | 'soundcloud' | 'genius' | (string & {});

/** Metadata of one entity as seen by one source (the local entity row, or a service's own row). */
export interface Facet {
	source: 'entity' | 'itunes' | 'soundcloud' | 'genius';
	/** The `service_ids_table` column(s) through which this facet is attached (empty for the entity facet). */
	columns: ServiceIdColumn[];
	title?: string | null;
	artist?: string | null;
	album?: string | null;
	duration_ms?: number | null;
	isrc?: string | null;
	explicit?: boolean | null;
	track_number?: number | null;
	release_year?: number | null;
	/** Other external ids this service reports for the entity (Genius `appleMusicId`, `soundcloudUrl`, ...), normalized. */
	reported?: Partial<Record<ServiceIdColumn, string>>;
	/** Thumbnail URLs that came from this service, moved along on a split. */
	thumbnails?: string[];
}

/** One `illusi_id` with everything the resolver needs. Plain data, so groups can be streamed later. */
export interface ReconcileNode {
	illusi_id: string;
	kind: EntityKind;
	has_entity: boolean;
	/** Epoch ms of the `service_ids_table` row. */
	created_at: number;
	/** Normalized, stringified `service_ids_table` values. */
	ids: Partial<Record<ServiceIdColumn, string>>;
	/** The local entity row as a facet (title, duration...). */
	meta: Facet;
	/** Service rows attached through this node's ids. */
	facets: Facet[];
	/** Library, playlist and play rows referencing it. */
	user_data: number;
	/** Filled `service_ids_table` columns plus filled entity columns. */
	filled: number;
	vector?: readonly number[] | null;
}

export interface ConflictInfo {
	id: number;
	illusi_id: string;
	column: ServiceIdColumn;
	existing_value: string | null;
	incoming_value: string;
	other_illusi_id: string | null;
	source: string;
	status: 'open' | 'deferred';
}

export interface GroupInput {
	nodes: ReconcileNode[];
	conflicts: ConflictInfo[];
}

export interface Claim {
	column: ServiceIdColumn;
	value: string;
	source: ClaimSource;
}

export interface Signal {
	name: string;
	weight: number;
	detail?: unknown;
}

export interface PairEvidence {
	a: string;
	b: string;
	signals: Signal[];
	/** Negative-weight signals that argue for "different entities". `strong` ones block any automatic merge. */
	contradictions: (Signal & { strong: boolean })[];
	confidence: number;
	/** Which hard-evidence rule applies, if any. */
	hard: 'cross_service_id' | 'isrc_duration' | 'shared_unique_id' | null;
}

export type PairDecision = 'merge' | 'review' | 'dismiss';

export interface FacetDisagreement {
	illusi_id: string;
	facet_source: Facet['source'];
	facet: Facet;
	columns: ServiceIdColumn[];
	reasons: string[];
	/** Hard: different ISRCs plus different titles, or a duration gap above the split threshold. */
	hard: boolean;
}

interface StepBase {
	/** Backed by hard evidence: applied by the worker. Otherwise it waits for an admin. */
	auto: boolean;
	reasons: string[];
	confidence?: number;
}

export interface MergeStep extends StepBase {
	type: 'merge';
	kind: EntityKind;
	survivor: string;
	loser: string;
}

export interface NewEntity {
	kind: EntityKind;
	title: string;
	duration_ms: number | null;
	explicit: boolean | null;
}

export interface SplitStep extends StepBase {
	type: 'split';
	from: string;
	/** Columns (and their values at planning time) moved to the new entity. */
	values: Partial<Record<ServiceIdColumn, string>>;
	facet_source: Facet['source'];
	new_entity: NewEntity;
	thumbnails: string[];
}

export interface MoveStep extends StepBase {
	type: 'move';
	from: string;
	to: string;
	values: Partial<Record<ServiceIdColumn, string>>;
	facet_source: Facet['source'];
	thumbnails: string[];
}

export type PlanStep = MergeStep | SplitStep | MoveStep;

export type ConflictResolution = 'merged' | 'split' | 'deferred' | 'dismissed';

export interface GroupPlan {
	/** Smallest illusi_id in the group; stable across runs. */
	key: string;
	kind: EntityKind;
	node_ids: string[];
	steps: PlanStep[];
	evidence: PairEvidence[];
	disagreements: FacetDisagreement[];
	/** What each conflict in the group becomes once the auto steps are applied. */
	conflicts: { id: number; status: ConflictResolution }[];
	/** If the whole group was skipped (too large, mixed kinds...). */
	skipped?: string;
}
