/**
 * One-off catalog cleanup, run once against data written before the matching fixes: `npx tsx src/db/cleanup_catalog.ts [--apply]`.
 * Without --apply it does everything in a transaction, prints what changed and rolls back. Connects with
 * MIGRATE_DATABASE_URL (the owner role); on the VPS: `scripts/catalog-cleanup.sh [--apply]`. Applied once, 2026-11-23.
 *
 * In order:
 *  1. invisible characters (left-to-right marks, zero-width spaces) are removed from names;
 *  2. artist names lose account dressing (`(@handle)`, `Official`, `VEVO` when the plain artist exists);
 *  3. joint credits stored as one artist (`Tory Lanez & Trippie Redd`) become their artists, when every one of them
 *     is already in the catalog and the joint artist has no Apple Music or Spotify id (a real duo has);
 *  4. artists with the same name are merged, unless their ids on a service other than YouTube differ;
 *  5. YouTube uploads titled `Artist - Title` whose prefix names artists in the catalog are credited to them, with
 *     the uploading channel's credit dropped, and titled `Title`; `Title - Artist` the other way around; upload
 *     decorations (`(Official Video)`, `(Lyrics)`) are removed;
 *  6. step 4 again, for the names the steps above produced;
 *     Then known aliases (`BabyTron SB`, BabyTron's channel) are merged into their artist;
 *  7. open review items are settled by the rules contributions now use, or dismissed when the entity already has
 *     the proposed value or the two albums are different albums (a track named like the other album moves out);
 *  8. artists the steps above left without any credit, without an Apple Music or Spotify id, are deleted.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './index';
import type { Tx } from './index';
import { album_tracks_table, albums_table, artist_albums_table, artists_table, review_items_table, service_ids_table, tracks_artists_table, tracks_table } from './schema';
import { write_audit } from '../core/audit';
import { names_differ, normalize_name } from '../core/normalize';
import { ARTIST_IDENTITY_COLUMNS } from '../services/entities/matching';
import { clean_artist_name, credit_parts, settle_artist_name, settle_title } from '../services/entities/settle';
import { apply_merge } from '../worker/reconcile/apply';

const apply = process.argv.includes('--apply');
const now = new Date();
const report: Record<string, string[]> = {};
const note = (step: string, line: string) => { (report[step] ??= []).push(line); };

// Not U+200D (zero-width joiner): emoji like 🤷‍♂️ are built with it.
// eslint-disable-next-line no-control-regex -- control characters are what this removes
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff]/gu;
const UPLOAD_DECORATION = /\s*[([\u300c](?:[^)\]\u300d]*\b(?:official|video|audio|lyrics?|visuali[sz]er|4k|hd|hq|mv|m\/v)\b)[^)\]\u300d]*[)\]\u300d]/giu;
/** `OFFICIAL VERSION`, `LYRICS` and the like at the end, outside brackets. */
const UPLOAD_SUFFIX = /\s+(?:official\s+(?:music\s+)?(?:video|audio|version)|lyrics?(?:\s+video)?)$/iu;
/** `"Hell Shell" OFFICIAL VERSION`: the song's title in quotes. */
const QUOTED = /^["\u201c](.+?)["\u201d](.*)$/u;
const CHANNEL_NAME = /\b(?:lyrics?|music|records|recordings|tv|media|radio|vault|hub|archive|channel|hype|scene|sounds|studios?|entertainment|uploads?|unreleased|leaks?|vevo|nightcore)\b/iu;
const FEATURES = /[([]?\s*\b(?:feat|ft|featuring)\.?\s+([^)\]]+)[)\]]?/iu;
const DASH = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/u;
const key = (s: string) => normalize_name(s).replace(/\s+/gu, '');

class Rollback extends Error {}

interface ArtistRow { id: string; name: string; tracks: number; ids: Partial<Record<string, string>> }

async function load_artists(tx: Tx): Promise<ArtistRow[]> {
	const rows = await tx.execute<{ id: string; name: string; tracks: number; ids: Record<string, string | null> }>(sql`
		select a.id, a.name, (select count(*)::int from tracks_artists_table x where x.artist_id = a.id)
			+ (select count(*)::int from albums_table x where x.artist_id = a.id) as tracks, to_jsonb(s) as ids
		from artists_table a join service_ids_table s on s.illusi_id = a.id`);
	return rows.rows.map(r => ({
		id: r.id, name: r.name, tracks: r.tracks,
		ids: Object.fromEntries(ARTIST_IDENTITY_COLUMNS.filter(c => r.ids[c] != null).map(c => [c, String(r.ids[c])]))
	}));
}

/** The best-known artist of each normalized name (most credits), for matching names in titles and credits. */
async function artists_by_name(tx: Tx): Promise<Map<string, ArtistRow>> {
	const out = new Map<string, ArtistRow>();
	for (const a of await load_artists(tx)) {
		const k = normalize_name(a.name);
		if (!k) continue;
		const prev = out.get(k);
		if (!prev || a.tracks > prev.tracks) out.set(k, a);
	}
	return out;
}

async function rename(tx: Tx, table: typeof artists_table | typeof albums_table, id: string, name: string) {
	await tx.update(table).set({ name, modified_at: now }).where(eq(table.id, id));
}

async function step_invisible(tx: Tx) {
	for (const [table, column] of [[artists_table, 'name'], [albums_table, 'name'], [tracks_table, 'title']] as const) {
		const rows = await tx.execute<{ id: string; v: string }>(sql`select id, ${sql.identifier(column)} as v from ${table} where ${sql.identifier(column)} ~ '[\\u0001-\\u0008\\u000b-\\u001f\\u007f\\u00ad\\u200b\\u200c\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff]'`);
		for (const r of rows.rows) {
			const clean = r.v.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
			if (!clean || clean === r.v) continue;
			await tx.update(table).set({ [column]: clean, modified_at: now }).where(eq(table.id, r.id));
			note('1 invisible characters', `${JSON.stringify(r.v)} → ${JSON.stringify(clean)}`);
		}
	}
}

async function step_artist_dressing(tx: Tx) {
	const by_key = new Map<string, string>();
	const all = await load_artists(tx);
	for (const a of all) if (!by_key.has(key(a.name))) by_key.set(key(a.name), a.name);
	for (const a of all) {
		let name = clean_artist_name(a.name).text;
		const k = key(name);
		if (k.endsWith('vevo') && by_key.has(k.slice(0, -4))) name = by_key.get(k.slice(0, -4))!;
		if (name === a.name) continue;
		await rename(tx, artists_table, a.id, name);
		note('2 artist names', `${a.name} → ${name}`);
	}
}

async function step_joint_credits(tx: Tx) {
	const by_name = await artists_by_name(tx);
	for (const a of await load_artists(tx)) {
		const parts = credit_parts(a.name);
		if (!parts || a.ids.applemusic_id || a.ids.spotify_id) continue;
		const artists = parts.map(p => by_name.get(normalize_name(clean_artist_name(p).text)));
		if (artists.some(x => !x || x.id === a.id)) continue;
		const ids = [...new Set(artists.map(x => x!.id))];
		const credits = await tx.select().from(tracks_artists_table).where(eq(tracks_artists_table.artist_id, a.id));
		for (const c of credits) {
			await tx.insert(tracks_artists_table).values(ids.map((artist_id, i) => {
				const at = new Date(c.created_at.getTime() + i);
				return { artist_id, track_id: c.track_id, created_at: at, modified_at: now };
			})).onConflictDoNothing();
			await tx.update(tracks_table).set({ modified_at: now }).where(eq(tracks_table.id, c.track_id));
		}
		await tx.delete(tracks_artists_table).where(eq(tracks_artists_table.artist_id, a.id));
		const linked = await tx.select({ album_id: artist_albums_table.album_id }).from(artist_albums_table).where(eq(artist_albums_table.artist_id, a.id));
		for (const l of linked) await tx.insert(artist_albums_table).values(ids.map(artist_id => ({ artist_id, album_id: l.album_id, position: 0 }))).onConflictDoNothing();
		await tx.update(albums_table).set({ artist_id: ids[0], modified_at: now }).where(eq(albums_table.artist_id, a.id));
		// What is left (links, conflicts, redirects) follows the leading artist.
		await apply_merge(tx, { type: 'merge', kind: 'artist', survivor: ids[0], loser: a.id, auto: true, reasons: ['joint_credit'] }, { actor: 'admin' });
		note('3 joint credits', `${a.name} (${credits.length} tracks) → ${artists.map(x => x!.name).join(' + ')}`);
	}
}

/** Channel names no rule can tell from a different artist, known to be the artist: merged into them. */
const ALIASES: readonly [alias: string, artist: string][] = [['BabyTron SB', 'BabyTron']];

async function step_aliases(tx: Tx) {
	const by_name = await artists_by_name(tx);
	for (const [alias, name] of ALIASES) {
		const target = by_name.get(normalize_name(name));
		if (!target) continue;
		for (const a of (await load_artists(tx)).filter(x => normalize_name(x.name) === normalize_name(alias))) {
			const r = await apply_merge(tx, { type: 'merge', kind: 'artist', survivor: target.id, loser: a.id, auto: true, reasons: ['alias'] }, { actor: 'admin' });
			if (r.applied) note('6 aliases', `${a.name} (${a.tracks} credits) → ${target.name}`);
		}
	}
}

/** Artists credited somewhere, before this run. */
async function credited_artists(tx: Tx): Promise<Set<string>> {
	const rows = await tx.execute<{ id: string }>(sql`
		select artist_id as id from tracks_artists_table union select artist_id from albums_table where artist_id is not null
		union select artist_id from artist_albums_table`);
	return new Set(rows.rows.map(r => r.id));
}

/**
 * Artists this run left without any credit (mostly uploading channels): deleted, unless a catalog id makes them a real
 * artist. Artists that had no credits before (an artist page someone opened) are left alone.
 */
async function step_orphans(tx: Tx, credited_before: ReadonlySet<string>) {
	const orphans = await tx.execute<{ id: string; name: string }>(sql`
		select a.id, a.name from artists_table a join service_ids_table s on s.illusi_id = a.id
		where s.applemusic_id is null and s.spotify_id is null
			and not exists(select 1 from tracks_artists_table x where x.artist_id = a.id)
			and not exists(select 1 from albums_table x where x.artist_id = a.id)
			and not exists(select 1 from artist_albums_table x where x.artist_id = a.id)`);
	const gone = orphans.rows.filter(r => credited_before.has(r.id));
	const ids = gone.map(r => r.id);
	for (let i = 0; i < ids.length; i += 500) {
		const chunk = ids.slice(i, i + 500);
		await tx.delete(artists_table).where(inArray(artists_table.id, chunk));
		await tx.delete(service_ids_table).where(inArray(service_ids_table.illusi_id, chunk));
	}
	for (const r of gone) note('8 artists left without credits, deleted', r.name);
}

async function step_merge_same_name(tx: Tx, step: string) {
	const groups = new Map<string, ArtistRow[]>();
	for (const a of await load_artists(tx)) {
		const k = normalize_name(a.name);
		if (k) groups.set(k, [...(groups.get(k) ?? []), a]);
	}
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		group.sort((a, b) => b.tracks - a.tracks || Object.keys(b.ids).length - Object.keys(a.ids).length);
		// Survivors each hold one identity; an artist joins the first survivor whose ids don't contradict its own.
		const survivors: ArtistRow[] = [];
		for (const a of group) {
			const target = survivors.find(s => !ARTIST_IDENTITY_COLUMNS.some(c => s.ids[c] != null && a.ids[c] != null && s.ids[c] !== a.ids[c]));
			if (!target) { survivors.push(a); continue; }
			const r = await apply_merge(tx, { type: 'merge', kind: 'artist', survivor: target.id, loser: a.id, auto: true, reasons: ['same_artist_name'] }, { actor: 'reconcile' });
			if (!r.applied) { note(step, `skipped ${a.name} ${a.id}: ${r.skipped}`); continue; }
			target.ids = { ...a.ids, ...target.ids };
			target.tracks += a.tracks;
		}
		const merged = group.length - survivors.length;
		if (merged > 0) note(step, `${group[0].name}: ${merged} merged into ${survivors.length === 1 ? 'one' : `${survivors.length} (different ids)`}`);
	}
}

async function step_youtube_titles(tx: Tx) {
	const by_name = await artists_by_name(tx);
	const known = (name: string) => {
		const a = by_name.get(normalize_name(clean_artist_name(name).text));
		// A name used once, by one upload, isn't proof of an artist (`CHAPTER 1`, `02. jades`).
		return a && (a.tracks >= 2 || a.ids.applemusic_id || a.ids.spotify_id) ? a : null;
	};
	// Credited on 2+ tracks, at least 3 in 4 of them titled `Someone Else - Title`: a channel uploading other artists' songs.
	const uploads = await tx.execute<{ id: string; name: string; titles: string[] }>(sql`
		select a.id, a.name, array_agg(t.title) as titles from artists_table a join tracks_artists_table ta on ta.artist_id = a.id
		join tracks_table t on t.id = ta.track_id group by a.id, a.name having count(*) >= 2`);
	const channels = new Set(uploads.rows.filter(r => r.titles.filter((title) => {
		const m = DASH.exec(title);
		return m != null && !(credit_parts(m[1]) ?? [m[1]]).some(p => normalize_name(p) === normalize_name(r.name));
	}).length * 4 >= r.titles.length * 3).map(r => r.id));
	const tracks = await tx.execute<{ id: string; title: string }>(sql`
		select t.id, t.title from tracks_table t join service_ids_table s on s.illusi_id = t.id
		where s.youtube_id is not null and s.applemusic_id is null and s.spotify_id is null and s.isrc is null`);
	for (const t of tracks.rows) {
		const credits = await tx.select({ id: artists_table.id, name: artists_table.name, youtube_id: service_ids_table.youtube_id, created_at: tracks_artists_table.created_at })
			.from(tracks_artists_table).innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
			.innerJoin(service_ids_table, eq(service_ids_table.illusi_id, artists_table.id))
			.where(eq(tracks_artists_table.track_id, t.id)).orderBy(tracks_artists_table.created_at);
		let title = t.title;
		let artists: ArtistRow[] | null = null;
		const m = DASH.exec(t.title);
		if (m) {
			const parts = credit_parts(m[1]) ?? [m[1]];
			const named = parts.map(known);
			if (named.every(Boolean)) {
				artists = named as ArtistRow[];
				title = m[2];
			} else if (credits.some(c => normalize_name(c.name) === normalize_name(m[2])) && !known(m[1])) {
				title = m[1];
			}
		}
		title = title.replace(UPLOAD_DECORATION, '').replace(UPLOAD_SUFFIX, '').replace(/\s+/gu, ' ').trim() || title;
		const quoted = QUOTED.exec(title);
		if (quoted && artists) title = `${quoted[1]}${quoted[2]}`.trim();

		let changed_credits = false;
		if (artists) {
			const wanted = [...new Set(artists.map(a => a.id))];
			// Artists the title names after `ft.` are credited too. A credit the title doesn't name is the uploading
			// channel when it is the only one, or when it is plainly a channel; other credits are featured artists and stay.
			const feature_names = credit_parts(FEATURES.exec(title)?.[1] ?? '') ?? (FEATURES.exec(title) ? [FEATURES.exec(title)![1].trim()] : []);
			const features = feature_names.map(known).filter((a): a is ArtistRow => a != null).map(a => a.id);
			const named_in_title = (name: string) => feature_names.some(f => normalize_name(f) === normalize_name(name));
			const unnamed = credits.filter(c => !wanted.includes(c.id) && !named_in_title(c.name));
			const uploader = (c: { id: string; name: string }) => (unnamed.length === 1 && credits.length === 1) || CHANNEL_NAME.test(c.name) || channels.has(c.id);
			const others = credits.filter(c => named_in_title(c.name) || !uploader(c)).map(c => c.id);
			const kept = [...new Set([...features, ...others])].filter(id => !wanted.includes(id));
			const next = [...wanted, ...kept];
			if (next.join() !== credits.map(c => c.id).join()) {
				changed_credits = true;
				await tx.delete(tracks_artists_table).where(eq(tracks_artists_table.track_id, t.id));
				await tx.insert(tracks_artists_table).values(next.map((artist_id, i) => {
					const at = new Date(now.getTime() + i);
					return { artist_id, track_id: t.id, created_at: at, modified_at: at };
				}));
			}
		}
		if (title === t.title && !changed_credits) continue;
		await tx.update(tracks_table).set({ title, modified_at: now }).where(eq(tracks_table.id, t.id));
		const names = changed_credits
			? (await tx.select({ name: artists_table.name }).from(tracks_artists_table).innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
					.where(eq(tracks_artists_table.track_id, t.id)).orderBy(tracks_artists_table.created_at)).map(r => r.name)
			: [];
		note('5 youtube uploads', `${t.title} [${credits.map(c => c.name).join(', ')}] → ${title}${changed_credits ? ` [${names.join(', ')}]` : ''}`);
	}
}

/**
 * An album that took another release's tracks because their names were close ("Tony Flow 3" holding the singles
 * "Tony Flow 4" and "Tony Flow 6"): a track named like one of the other releases moves to an album of its own.
 * Other tracks can't be told apart and stay.
 */
async function split_singles(tx: Tx, album_id: string, album: Record<string, unknown>, proposals: readonly string[]) {
	const tracks = await tx.select({ id: tracks_table.id, title: tracks_table.title, album_id: tracks_table.album_id }).from(album_tracks_table)
		.innerJoin(tracks_table, eq(tracks_table.id, album_tracks_table.track_id)).where(eq(album_tracks_table.album_id, album_id));
	for (const name of proposals) {
		const single = tracks.find(t => normalize_name(t.title) === normalize_name(name) && normalize_name(t.title) !== normalize_name(String(album.name)));
		if (!single) continue;
		const id = randomUUID();
		await tx.insert(service_ids_table).values({ illusi_id: id });
		await tx.insert(albums_table).values({ id, name, artist_id: (album.artist_id as string | null) ?? null, album_type: 'SINGLE', track_count: 1 });
		const artist_id = album.artist_id as string | null;
		if (artist_id) await tx.insert(artist_albums_table).values({ artist_id, album_id: id, position: 0 }).onConflictDoNothing();
		await tx.delete(album_tracks_table).where(and(eq(album_tracks_table.album_id, album_id), eq(album_tracks_table.track_id, single.id)));
		await tx.insert(album_tracks_table).values({ album_id: id, track_id: single.id, track_number: 1 });
		await tx.update(tracks_table).set({ album_id: single.album_id === album_id || single.album_id == null ? id : single.album_id, modified_at: now }).where(eq(tracks_table.id, single.id));
		note('7 reviews', `  moved ${JSON.stringify(single.title)} out of ${JSON.stringify(album.name)} into its own single`);
	}
}

async function step_reviews(tx: Tx) {
	const items = await tx.select().from(review_items_table).where(and(eq(review_items_table.status, 'OPEN'), eq(review_items_table.kind, 'FIELD_CONFLICT')));
	for (const item of items) {
		const table = item.entity_table === 'tracks_table' ? tracks_table : item.entity_table === 'artists_table' ? artists_table : item.entity_table === 'albums_table' ? albums_table : null;
		if (!table || (item.field !== 'title' && item.field !== 'name')) continue;
		const target = (await tx.execute<{ id: string }>(sql`select coalesce((select new_id from illusi_id_redirects_table where old_id = ${item.entity_id}), ${item.entity_id}::uuid) as id`)).rows[0].id;
		const [row] = await tx.select().from(table).where(eq(table.id, target)) as Record<string, unknown>[];
		const proposals = (item.proposed_values as { value: unknown }[]).map(p => String(p.value));
		let decision: 'APPLIED' | 'DISMISSED' | null = null;
		let apply_value: string | null = null;
		if (!row) {
			decision = 'DISMISSED';
		} else {
			const current = String(row[item.field]);
			if (proposals.every(p => normalize_name(p) === normalize_name(current))) decision = 'DISMISSED';
			else if (item.entity_table === 'albums_table' && proposals.every(p => names_differ(current, p))) {
				decision = 'DISMISSED';
				await split_singles(tx, target, row, proposals);
			} else if (proposals.length === 1) {
				const artists = item.entity_table === 'tracks_table'
					? (await tx.select({ name: artists_table.name }).from(tracks_artists_table).innerJoin(artists_table, eq(artists_table.id, tracks_artists_table.artist_id))
							.where(eq(tracks_artists_table.track_id, target))).map(r => r.name)
					: [];
				const settled = item.entity_table === 'tracks_table'
					? settle_title(current, proposals[0], artists)
					: item.entity_table === 'artists_table' ? settle_artist_name(current, proposals[0]) : 'review';
				if (settled === 'apply') { decision = 'APPLIED'; apply_value = proposals[0]; }
				if (settled === 'ignore') decision = 'DISMISSED';
			}
		}
		if (!decision) continue;
		if (apply_value != null) await tx.update(table).set({ [item.field]: apply_value, modified_at: now }).where(eq(table.id, target));
		await tx.update(review_items_table).set({ status: decision, resolved_at: now, modified_at: now }).where(eq(review_items_table.id, item.id));
		note('7 reviews', `${decision.toLowerCase()} ${item.entity_table} ${item.field}: ${JSON.stringify(row?.[item.field] ?? null)} vs ${proposals.map(p => JSON.stringify(p)).join(' | ')}`);
	}
}

async function counts(tx: Tx) {
	const [r] = (await tx.execute<{ artists: number; tracks: number; open: number }>(sql`select
		(select count(*)::int from artists_table) as artists, (select count(*)::int from tracks_table) as tracks,
		(select count(*)::int from review_items_table where status = 'OPEN') as open`)).rows;
	return r;
}

async function main() {
	try {
		await db.transaction(async (tx) => {
			const before = await counts(tx);
			const credited_before = await credited_artists(tx);
			await step_invisible(tx);
			await step_artist_dressing(tx);
			await step_joint_credits(tx);
			await step_merge_same_name(tx, '4 same-name artists');
			await step_youtube_titles(tx);
			await step_merge_same_name(tx, '6 same-name artists, again');
			await step_aliases(tx);
			await step_reviews(tx);
			await step_orphans(tx, credited_before);
			const after = await counts(tx);
			for (const [step, lines] of Object.entries(report).sort(([a], [b]) => a.localeCompare(b))) {
				console.log(`\n== ${step} (${lines.length})`);
				for (const l of lines) console.log(`  ${l}`);
			}
			console.log(`\nartists ${before.artists} → ${after.artists}, tracks ${before.tracks} → ${after.tracks}, open reviews ${before.open} → ${after.open}`);
			await write_audit(tx, { action: 'catalog_cleanup', actor: 'admin', details: { counts: { before, after }, changes: Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.length])) } });
			if (!apply) throw new Rollback();
		});
		console.log('\napplied');
	} catch (err) {
		if (!(err instanceof Rollback)) throw err;
		console.log('\ndry run: rolled back (pass --apply to keep it)');
	} finally {
		await (db.$client as { end(): Promise<void> }).end();
	}
}

void main();
