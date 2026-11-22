import { count, inArray } from 'drizzle-orm';
import type { Tx } from '../../db';
import { artists_table, tracks_artists_table } from '../../db/schema';
import { names_match } from '../../core/normalize';
import type { ProvenanceLog } from '../../core/provenance';
import { apply_graph, validate_graph } from '../entities';
import type { EngineResult, RawGraph } from '../entities';
import { album_candidates, artist_ids_by_name } from '../entities/candidates';
import { resolve_existing_ref } from '../entities/match';

export interface OverrideRef { id?: string; name: string }

const NEW_REF = 'override';

/**
 * Resolves the artists and album a user credits a track with: a known id, else the catalog's entity with that
 * name, else a new entity. Names are only ever linked, never renamed, so the catalog stays as it is.
 */
export class OverrideResolver {
	/** Engine runs for created entities; their events flush after commit */
	readonly results: EngineResult[] = [];
	private readonly artists = new Map<string, string>();
	private readonly albums = new Map<string, string>();

	constructor(private tx: Tx, private user_id: string, private provenance: ProvenanceLog) {}

	private async create(raw: RawGraph): Promise<string | null> {
		const { graph, rejected } = validate_graph(raw);
		if (rejected.length > 0) return null;
		const result = await apply_graph(this.tx, graph, { user_id: this.user_id, source: 'sync_push', provenance: this.provenance });
		this.results.push(result);
		return result.refs[NEW_REF] ?? null;
	}

	/** The most credited catalog artist whose own name matches */
	private async named_artist(name: string): Promise<string | null> {
		const ids = await artist_ids_by_name(this.tx, name);
		if (ids.length === 0) return null;
		const rows = await this.tx.select({ id: artists_table.id, name: artists_table.name }).from(artists_table).where(inArray(artists_table.id, ids));
		const matching = rows.filter(r => names_match(name, r.name)).map(r => r.id);
		if (matching.length <= 1) return matching[0] ?? null;
		const credits = await this.tx.select({ id: tracks_artists_table.artist_id, n: count() }).from(tracks_artists_table)
			.where(inArray(tracks_artists_table.artist_id, matching)).groupBy(tracks_artists_table.artist_id);
		const by_id = new Map(credits.map(c => [c.id, c.n]));
		return matching.reduce((best, id) => ((by_id.get(id) ?? 0) > (by_id.get(best) ?? 0) ? id : best));
	}

	async artist(ref: OverrideRef): Promise<string | null> {
		if (ref.id) {
			const known = await resolve_existing_ref(this.tx, 'artist', ref.id);
			if (known) return known;
		}
		const key = ref.name.trim().toLowerCase();
		const cached = this.artists.get(key);
		if (cached) return cached;
		const id = await this.named_artist(ref.name) ?? await this.create({ artists: [{ ref: NEW_REF, name: ref.name.trim() }] });
		if (id) this.artists.set(key, id);
		return id;
	}

	/** An album of one of the track's artists with that name; with no artists, any album of that name */
	async album(ref: OverrideRef, artist_ids: readonly string[]): Promise<string | null> {
		if (ref.id) {
			const known = await resolve_existing_ref(this.tx, 'album', ref.id);
			if (known) return known;
		}
		const key = `${ref.name.trim().toLowerCase()}|${artist_ids.join(',')}`;
		const cached = this.albums.get(key);
		if (cached) return cached;
		const candidates = await album_candidates(this.tx, ref.name, artist_ids);
		const found = artist_ids.length === 0 ? candidates[0] : candidates.find(c => c.artist_ids.some(id => artist_ids.includes(id)));
		const id = found?.id ?? await this.create({ albums: [{ ref: NEW_REF, name: ref.name.trim(), artist_ref: artist_ids[0] ?? null }] });
		if (id) this.albums.set(key, id);
		return id;
	}
}
