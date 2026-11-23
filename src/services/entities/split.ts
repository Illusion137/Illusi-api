/**
 * Separators sent as artists (`&`, `,`) are dropped, and joint credits sent as one artist (`StanWill & NASAAN`,
 * `A, B, and C`), the way some services list a collaboration, become each of their artists on the same tracks before
 * anything is matched. Otherwise the joint name matches the
 * artist whose account id it carries and the others are lost, or it becomes an artist of its own.
 */
import { eq, or, sql } from 'drizzle-orm';
import type { Tx } from '../../db';
import { artists_table, service_ids_table } from '../../db/schema';
import { normalize_name } from '../../core/normalize';
import { normalize_service_ids, UNIQUE_SERVICE_ID_COLUMNS } from '../../core/service_ids';
import { credit_parts } from './settle';
import type { ArtistInput, Graph } from './payload';

/** Ids of a catalog of its own: such an artist is that service's (possibly joint) artist, never split. */
const CATALOG_COLUMNS = ['applemusic_id', 'spotify_id'] as const;

/** Which of these names are already artists' names (case, accents and punctuation aside). */
async function known_names(tx: Tx, names: readonly string[]): Promise<Set<string>> {
	const result = await tx.execute<{ name: string }>(sql`
		select x as name from unnest(${sql.param([...new Set(names)])}::text[]) x
		where exists(select 1 from ${artists_table} a where illusi_name_key(a.name) = illusi_name_key(x))`);
	return new Set(result.rows.map(r => r.name));
}

/** The name of the existing artist holding one of these account ids. */
async function account_owner(tx: Tx, artist: ArtistInput): Promise<string | null> {
	const ids = normalize_service_ids(artist.service_ids ?? {}).ids;
	const matches = UNIQUE_SERVICE_ID_COLUMNS.filter(c => ids[c] != null).map(c => eq(service_ids_table[c], ids[c] as never));
	if (matches.length === 0) return null;
	const [row] = await tx.select({ name: artists_table.name }).from(service_ids_table)
		.innerJoin(artists_table, eq(artists_table.id, service_ids_table.illusi_id)).where(or(...matches)).limit(1);
	return row?.name ?? null;
}

/**
 * How a contributed artist splits, or null to keep it whole. A name splits only when it plainly lists artists:
 * its account id belongs to an artist named as one of the parts (`StanWill & NASAAN` with StanWill's SoundCloud),
 * or the parts are already artists, in the catalog or this payload (both of two, two or more of a longer list). Names that are artists themselves
 * (`Tyler, The Creator`, `Kool & The Gang`) and service catalog artists stay whole. The owner of the account keeps
 * the ids; without an owner nobody does, since they can't be told apart.
 */
async function split_of(tx: Tx, artist: ArtistInput, in_payload: ReadonlySet<string>): Promise<{ parts: string[]; owner: number | null } | null> {
	const parts = credit_parts(artist.name);
	if (!parts) return null;
	const ids = normalize_service_ids(artist.service_ids ?? {}).ids;
	if (CATALOG_COLUMNS.some(c => ids[c] != null)) return null;
	const known = await known_names(tx, [artist.name, ...parts]);
	const is_known = (name: string) => known.has(name);
	if (is_known(artist.name)) return null;
	const owner_name = await account_owner(tx, artist);
	const owner = owner_name === null ? -1 : parts.findIndex(p => normalize_name(p) === normalize_name(owner_name));
	if (owner >= 0) return { parts, owner };
	const hits = parts.filter(p => is_known(p) || in_payload.has(normalize_name(p))).length;
	return (parts.length === 2 ? hits === 2 : hits >= 2) ? { parts, owner: null } : null;
}

/** `&`, `,`, ` and `, an invisible mark: what some services put between artists, sent as an artist of its own. */
const SEPARATOR_RE = /^(?:[\s\p{Cf},&+/|·•\-\u2013\u2014]|\b(?:and|x|featuring|feat|ft|with)\b\.?)*$/iu;
export const is_separator_name = (name: string) => SEPARATOR_RE.test(name);

/** The graph without separator artists and everything that links to them. */
function without_separators(graph: Graph): Graph {
	const gone = new Set(graph.artists.filter(a => is_separator_name(a.name)).map(a => a.ref));
	if (gone.size === 0) return graph;
	const r = graph.relations;
	return {
		artists: graph.artists.filter(a => !gone.has(a.ref)),
		albums: graph.albums.map(a => (a.artist_ref != null && gone.has(a.artist_ref) ? { ...a, artist_ref: null } : a)),
		tracks: graph.tracks,
		relations: {
			tracks_artists: r.tracks_artists.filter(x => !gone.has(x.artist_ref)),
			album_tracks: r.album_tracks,
			artist_albums: r.artist_albums.filter(x => !gone.has(x.artist_ref)),
			similar_artists: r.similar_artists.filter(x => !gone.has(x.artist_ref) && !gone.has(x.similar_artist_ref))
		}
	};
}

export async function split_joint_credits(tx: Tx, graph: Graph): Promise<Graph> {
	graph = without_separators(graph);
	const splits = new Map<string, string[]>();
	const artists: ArtistInput[] = [];
	const added: ArtistInput[] = [];
	const by_name = new Map(graph.artists.map(a => [normalize_name(a.name), a.ref]));
	const in_payload = new Set(by_name.keys());
	for (const artist of graph.artists) {
		const split = await split_of(tx, artist, in_payload);
		if (!split) { artists.push(artist); continue; }
		const owner = split.owner ?? 0;
		const refs = split.parts.map((name, i) => {
			if (i === owner) return artist.ref;
			const same = by_name.get(normalize_name(name));
			if (same !== undefined && same !== artist.ref) return same;
			const ref = `${artist.ref.slice(0, 120)}~${i}`;
			added.push({ ref, name });
			by_name.set(normalize_name(name), ref);
			return ref;
		});
		artists.push({ ...artist, name: split.parts[owner], ...(split.owner === null ? { service_ids: undefined } : {}) });
		splits.set(artist.ref, refs);
	}
	if (splits.size === 0) return graph;
	const tracks_artists = graph.relations.tracks_artists.flatMap(r => (splits.get(r.artist_ref) ?? [r.artist_ref]).map(artist_ref => ({ ...r, artist_ref })));
	return { ...graph, artists: [...artists, ...added], relations: { ...graph.relations, tracks_artists } };
}
