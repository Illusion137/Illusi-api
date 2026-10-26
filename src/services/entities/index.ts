import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { contributions_log_table } from '../../db/schema';
import { HttpError, json_body, parse_body, require_user } from '../../core/http';
import { ProvenanceLog } from '../../core/provenance';
import { rate_limit_user } from '../../core/rate_limit';
import { apply_graph, flush_engine_events } from './engine';
import type { ConflictReport, EntityOutcome, MatchedOutcome } from './engine';
import { match_entity } from './match';
import type { MatchInput } from './match';
import { graph_counts, raw_graph_schema, service_ids_schema, validate_graph } from './payload';
import type { Rejection } from './payload';
import { pg_error_code, PG_ERRORS } from '../../core/pg_errors';

export { apply_graph, flush_engine_events } from './engine';
export type { ConflictReport, EngineContext, EngineResult, EntityOutcome, MatchedOutcome } from './engine';
export { graph_counts, raw_graph_schema, validate_graph } from './payload';
export type { Graph, RawGraph, Rejection } from './payload';
export { similar_artist_ids } from './similar';

/** Mounted after `require_auth`: `POST /contribute`, `POST /resolve`. */
export const entities_router = Router();

export const CONTRIBUTE_MAX_ENTITIES = 1_000;
export const CONTRIBUTE_MAX_RELATIONS = 5_000;
const RESOLVE_MAX_ITEMS = 500;

export interface ContributionResponse {
	refs: Record<string, string>;
	created: EntityOutcome[];
	matched: MatchedOutcome[];
	conflicts: ConflictReport[];
	rejected: Rejection[];
}

const contribution_schema = raw_graph_schema.extend({ contribution_id: z.uuid() });

const is_unique_violation = (err: unknown) => pg_error_code(err) === PG_ERRORS.unique_violation;

/** The stored response of an already-applied contribution, or null. Another user's id is a conflict. */
async function replay(contribution_id: string, user_id: string): Promise<ContributionResponse | null> {
	const [row] = await db.select({ user_id: contributions_log_table.user_id, response: contributions_log_table.response })
		.from(contributions_log_table).where(eq(contributions_log_table.contribution_id, contribution_id)).limit(1);
	if (!row) return null;
	if (row.user_id !== user_id) throw new HttpError(409, 'contribution_id already used');
	return row.response as ContributionResponse;
}

entities_router.post('/contribute', rate_limit_user('contribute', 60, 60_000), json_body('4mb'), async (req, res) => {
	const user = require_user(req);
	const body = parse_body(contribution_schema, req.body);
	const counts = graph_counts(body);
	if (counts.entities > CONTRIBUTE_MAX_ENTITIES || counts.relations > CONTRIBUTE_MAX_RELATIONS) {
		throw new HttpError(413, 'too many entities', { max_entities: CONTRIBUTE_MAX_ENTITIES, max_relations: CONTRIBUTE_MAX_RELATIONS });
	}
	const previous = await replay(body.contribution_id, user.id);
	if (previous) {
		res.json(previous);
		return;
	}

	const { graph, rejected } = validate_graph(body);
	let result;
	try {
		result = await db.transaction(async (tx) => {
			const provenance = new ProvenanceLog('contribute', user.id, null, body.contribution_id);
			const applied = await apply_graph(tx, graph, { user_id: user.id, source: 'contribute', provenance });
			const response: ContributionResponse = {
				refs: applied.refs,
				created: applied.created,
				matched: applied.matched,
				conflicts: applied.conflicts,
				rejected: [...rejected, ...applied.rejected]
			};
			await provenance.write(tx, response);
			return { response, applied };
		});
	} catch (err) {
		// A concurrent retry with the same contribution_id committed first.
		if (is_unique_violation(err)) {
			const stored = await replay(body.contribution_id, user.id);
			if (stored) {
				res.json(stored);
				return;
			}
		}
		throw err;
	}
	flush_engine_events(result.applied);
	res.json(result.response);
});

const resolve_schema = z.object({
	items: z.array(z.object({
		ref: z.string().trim().min(1).max(128),
		type: z.enum(['track', 'album', 'artist']),
		service_ids: service_ids_schema.optional(),
		title: z.string().max(1024).nullish(),
		artist: z.string().max(1024).nullish(),
		album: z.string().max(1024).nullish(),
		duration_ms: z.number().int().min(0).nullish()
	})).max(RESOLVE_MAX_ITEMS)
});
type ResolveItem = z.infer<typeof resolve_schema>['items'][number];

/** Builds the match input for a `/resolve` item, which only knows names (no payload graph). */
export function resolve_match_input(item: ResolveItem): MatchInput {
	const base: MatchInput = { ref: item.ref, service_ids: item.service_ids ?? {} };
	if (item.type === 'track') {
		return item.title ? { ...base, track: { title: item.title, duration_ms: item.duration_ms, artist_name: item.artist, album_name: item.album } } : base;
	}
	if (item.type === 'album') {
		const name = item.album ?? item.title;
		return name ? { ...base, album: { name, artist_name: item.artist } } : base;
	}
	const name = item.artist ?? item.title;
	if (!name) return base;
	return {
		...base,
		artist: {
			name,
			album_names: item.album ? [item.album] : [],
			track_titles: item.artist && item.title ? [item.title] : []
		}
	};
}

/** Read-only lookup: same matching as the contribute path, follows redirects, creates nothing. Unclear matches are null. */
entities_router.post('/resolve', rate_limit_user('resolve', 120, 60_000), json_body('1mb'), async (req, res) => {
	require_user(req);
	const body = parse_body(resolve_schema, req.body);
	const out: Record<string, string | null> = {};
	await db.transaction(async (tx) => {
		for (const item of body.items) {
			const match = await match_entity(tx, item.type, resolve_match_input(item));
			out[item.ref] = match.kind === 'match' ? match.illusi_id : null;
		}
	}, { isolationLevel: 'repeatable read', accessMode: 'read only' });
	res.json(out);
});
