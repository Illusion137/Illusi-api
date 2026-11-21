import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Executor } from '../../db';
import { db } from '../../db';
import { itunes_tracks_table, media_table, service_ids_table, track_alignment_table, track_play_counts_table, track_sample_data_table, track_sample_lookups_table, track_vocals_table, tracks_table } from '../../db/schema';
import { write_vector } from '../vectors';
import type { AlignmentResult, SampleInsert, VocalsResult } from './contract';
import { SAMPLE_VERSION } from './contract';
import type { LookupState, SampleLookupStatus, SampleSource, SourceCandidate } from './decisions';
import { choose_source, next_attempts, source_eligible } from './decisions';

export interface LookupRow extends LookupState { attempts: number }

export type ResolvedSource = SourceCandidate & { prior: LookupRow | null };

/**
 * Track ids that have an analyzable source, no sample, and no lookup record blocking that source.
 * Blocking mirrors `source_eligible`: BAD_FILE/NOT_FOUND/DONE for the same source ref, ERROR until `retry_after`.
 * Media uses the newest `media_table` row; previews join `service_ids_table.applemusic_id = itunes_tracks_table.id`.
 */
export async function eligible_track_ids(only?: readonly string[]): Promise<string[]> {
	if (only?.length === 0) return [];
	const filter: SQL = only ? sql`and c.track_id in ${[...only]}` : sql``;
	const rows = await db.execute<{ track_id: string }>(sql`
		select c.track_id from (
			select m.track_id from media_table m
			union
			select si.illusi_id as track_id from service_ids_table si
			join itunes_tracks_table it on it.id::text = si.applemusic_id
			where it.preview_url is not null
		) c
		where not exists (select 1 from track_sample_data_table s where s.id = c.track_id)
		${filter}
		and (
			exists (
				select 1 from (select m.resource_id from media_table m where m.track_id = c.track_id order by m.id desc limit 1) lm
				where not exists (
					select 1 from track_sample_lookups_table l
					where l.track_id = c.track_id and l.source = 'media' and l.source_ref is not distinct from lm.resource_id
					and (l.status <> 'ERROR' or l.retry_after > now())
				)
			)
			or exists (
				select 1 from service_ids_table si
				join itunes_tracks_table it on it.id::text = si.applemusic_id
				where si.illusi_id = c.track_id and it.preview_url is not null
				and not exists (
					select 1 from track_sample_lookups_table l
					where l.track_id = c.track_id and l.source = 'itunes_preview' and l.source_ref is not distinct from it.preview_url
					and (l.status <> 'ERROR' or l.retry_after > now())
				)
			)
		)`, 'objects');
	return rows.map(r => r.track_id);
}

/** Tracks whose sample came from an older analyzer and lacks what it returns now. */
export async function outdated_sample_track_ids(): Promise<string[]> {
	const rows = await db.select({ id: track_sample_data_table.id }).from(track_sample_data_table).where(lt(track_sample_data_table.version, SAMPLE_VERSION));
	return rows.map(r => r.id);
}

/**
 * Resolves the source a job should analyze right now, or null (sample exists / nothing eligible). With `upgrade`, a
 * sample from an older analyzer is analyzed again, from a source that already succeeded too.
 */
export async function resolve_source(track_id: string, prefer?: SampleSource, upgrade = false): Promise<ResolvedSource | null> {
	const [sample] = await db.select({ version: track_sample_data_table.version }).from(track_sample_data_table).where(eq(track_sample_data_table.id, track_id));
	if (sample && (!upgrade || sample.version >= SAMPLE_VERSION)) return null;
	if (!sample && upgrade) return null;

	const candidates: SourceCandidate[] = [];
	const [media] = await db.select({ resource_id: media_table.resource_id }).from(media_table)
		.where(eq(media_table.track_id, track_id)).orderBy(desc(media_table.id)).limit(1);
	if (media) candidates.push({ source: 'media', ref: media.resource_id });

	const [preview] = await db.select({ preview_url: itunes_tracks_table.preview_url }).from(service_ids_table)
		.innerJoin(itunes_tracks_table, sql`${itunes_tracks_table.id}::text = ${service_ids_table.applemusic_id}`)
		.where(eq(service_ids_table.illusi_id, track_id)).limit(1);
	if (preview?.preview_url) candidates.push({ source: 'itunes_preview', ref: preview.preview_url });
	if (candidates.length === 0) return null;

	const lookup_rows = await db.select().from(track_sample_lookups_table).where(eq(track_sample_lookups_table.track_id, track_id));
	const lookups = new Map<SampleSource, LookupRow>(lookup_rows.filter(l => !(upgrade && l.status === 'DONE'))
		.map(l => [l.source, { status: l.status, retry_after: l.retry_after, source_ref: l.source_ref, attempts: l.attempts }]));
	const chosen = choose_source(candidates, lookups, prefer);
	return chosen ? { ...chosen, prior: lookups.get(chosen.source) ?? null } : null;
}

/** Upserts the `(track_id, source)` lookup record. */
export async function record_lookup(ex: Executor, track_id: string, source: ResolvedSource, status: SampleLookupStatus, retry_after: Date | null): Promise<void> {
	const values = {
		track_id,
		source: source.source,
		status,
		attempts: next_attempts(source.prior, source.ref),
		attempted_at: new Date(),
		retry_after,
		source_ref: source.ref
	};
	await ex.insert(track_sample_lookups_table).values(values).onConflictDoUpdate({
		target: [track_sample_lookups_table.track_id, track_sample_lookups_table.source],
		set: { status, attempts: values.attempts, attempted_at: values.attempted_at, retry_after, source_ref: source.ref }
	});
}

/**
 * Whether the track's lyrics are all unsynced: only then does the app line them up with the vocals, so only then is
 * the costly `/vocals` worth running.
 */
const has_only_unsynced_lyrics = (track_id: SQL) => sql`(
	exists (select 1 from track_lyrics_table ly where ly.track_id = ${track_id} and ly.sync_type = 'NONE')
	and not exists (select 1 from track_lyrics_table ly where ly.track_id = ${track_id} and ly.sync_type <> 'NONE')
)`;

export async function has_only_unsynced_lyrics_now(track_id: string): Promise<boolean> {
	const rows = await db.execute<{ ok: boolean }>(sql`select ${has_only_unsynced_lyrics(sql`${track_id}::uuid`)} as ok`, 'objects');
	return rows[0]?.ok ?? false;
}

export interface TrackPriority { plays: number; views: number }

/**
 * How much each track is listened to: plays by Illusi users, then the most plays any streaming service reports.
 * Tracks without either are 0, 0.
 */
export async function track_priorities(track_ids: readonly string[]): Promise<Map<string, TrackPriority>> {
	const out = new Map<string, TrackPriority>();
	const unique = [...new Set(track_ids)];
	for (let i = 0; i < unique.length; i += 1000) {
		const part = unique.slice(i, i + 1000);
		const rows = await db.execute<{ track_id: string; plays: string | number; views: string | number }>(sql`
			select t.id as track_id, coalesce(pc.plays, 0) as plays, coalesce((select max(st.plays) from service_tracks_table st where st.illusi_id = t.id), 0) as views
			from unnest(${`{${part.join(',')}}`}::uuid[]) as t(id)
			left join track_play_counts_table pc on pc.track_id = t.id`, 'objects');
		for (const r of rows) out.set(r.track_id, { plays: Number(r.plays), views: Number(r.views) });
	}
	return out;
}

/**
 * Track ids whose newest media file has no vocals result and no failure blocking it (`source_eligible` rules), among
 * tracks whose lyrics are all unsynced.
 */
export async function eligible_vocals_track_ids(): Promise<string[]> {
	const rows = await db.execute<{ track_id: string }>(sql`
		select lm.track_id from (
			select distinct on (m.track_id) m.track_id, m.resource_id from media_table m order by m.track_id, m.id desc
		) lm
		left join track_vocals_table v on v.track_id = lm.track_id
		where (v.track_id is null
			or v.resource_id <> lm.resource_id
			or (v.status = 'ERROR' and (v.retry_after is null or v.retry_after <= now()))
			or (v.status = 'DONE' and (v.beats is null or v.words is null)))
		and ${has_only_unsynced_lyrics(sql`lm.track_id`)}`, 'objects');
	return rows.map(r => r.track_id);
}

export interface VocalsTarget { resource_id: string; prior: LookupRow | null }

/** The media file a vocals job should analyze right now, or null (no media / lyrics synced or missing / already done / blocked). */
export async function resolve_vocals_target(track_id: string): Promise<VocalsTarget | null> {
	if (!(await has_only_unsynced_lyrics_now(track_id))) return null;
	const [media] = await db.select({ resource_id: media_table.resource_id }).from(media_table)
		.where(eq(media_table.track_id, track_id)).orderBy(desc(media_table.id)).limit(1);
	if (!media) return null;
	const [row] = await db.select().from(track_vocals_table).where(eq(track_vocals_table.track_id, track_id));
	const prior: LookupRow | null = row ? { status: row.status, retry_after: row.retry_after, source_ref: row.resource_id, attempts: row.attempts } : null;
	// Rows from before beat tracking or the lyrics alignment features are analyzed again for them
	const outdated = row?.status === 'DONE' && (row.beats === null || row.words === null) && row.resource_id === media.resource_id;
	return outdated || source_eligible(prior, media.resource_id) ? { resource_id: media.resource_id, prior } : null;
}

/** Stores a vocals result (DONE) or failure for the target's file. A failure clears results from an older file. */
export async function record_vocals(track_id: string, target: VocalsTarget, status: SampleLookupStatus, retry_after: Date | null, result: VocalsResult | null): Promise<void> {
	const now = new Date();
	const values = {
		resource_id: target.resource_id,
		status,
		attempts: next_attempts(target.prior, target.resource_id),
		attempted_at: now,
		retry_after,
		model: result?.model ?? null,
		hop_ms: result?.hop_ms ?? null,
		window_ms: result?.window_ms ?? null,
		duration_ms: result?.duration_ms ?? null,
		voice: result?.voice ?? null,
		segments: result?.segments ?? null,
		rhythm_model: result?.rhythm_model ?? null,
		rhythm_bpm: result?.rhythm_bpm ?? null,
		rhythm_confidence: result?.rhythm_confidence ?? null,
		beats: result?.beats ?? null,
		bpm_estimates: result?.bpm_estimates ?? null,
		words_model: result?.words_model ?? null,
		words: result?.words ?? null,
		word_times: result?.word_times ?? null,
		word_probabilities: result?.word_probabilities ?? null,
		speech_model: result?.speech_model ?? null,
		speech_hop_ms: result?.speech_hop_ms ?? null,
		speech: result?.speech ?? null,
		beat_grid_model: result?.beat_grid_model ?? null,
		grid_beats: result?.grid_beats ?? null,
		downbeats: result?.downbeats ?? null
	};
	await db.insert(track_vocals_table).values({ track_id, ...values })
		.onConflictDoUpdate({ target: track_vocals_table.track_id, set: { ...values, modified_at: now } });
}

/**
 * Track ids users have played whose newest media file has no alignment result and no failure blocking it
 * (`source_eligible` rules), among tracks whose lyrics are all unsynced.
 */
export async function eligible_alignment_track_ids(): Promise<string[]> {
	const rows = await db.execute<{ track_id: string }>(sql`
		select lm.track_id from (
			select distinct on (m.track_id) m.track_id, m.resource_id from media_table m order by m.track_id, m.id desc
		) lm
		join track_play_counts_table pc on pc.track_id = lm.track_id and pc.plays > 0
		left join track_alignment_table a on a.track_id = lm.track_id
		where (a.track_id is null
			or a.resource_id <> lm.resource_id
			or (a.status = 'ERROR' and (a.retry_after is null or a.retry_after <= now())))
		and ${has_only_unsynced_lyrics(sql`lm.track_id`)}`, 'objects');
	return rows.map(r => r.track_id);
}

/**
 * The media file an alignment job should analyze right now, or null (no media / lyrics synced or missing / nobody
 * plays it / already done / blocked). `requested`: a user is playing it right now, before the play is synced.
 */
export async function resolve_alignment_target(track_id: string, requested = false): Promise<VocalsTarget | null> {
	if (!(await has_only_unsynced_lyrics_now(track_id))) return null;
	if (!requested) {
		const [count] = await db.select({ plays: track_play_counts_table.plays }).from(track_play_counts_table).where(eq(track_play_counts_table.track_id, track_id));
		if (!count || count.plays <= 0) return null;
	}
	const [media] = await db.select({ resource_id: media_table.resource_id }).from(media_table)
		.where(eq(media_table.track_id, track_id)).orderBy(desc(media_table.id)).limit(1);
	if (!media) return null;
	const [row] = await db.select({ status: track_alignment_table.status, retry_after: track_alignment_table.retry_after, resource_id: track_alignment_table.resource_id, attempts: track_alignment_table.attempts })
		.from(track_alignment_table).where(eq(track_alignment_table.track_id, track_id));
	const prior: LookupRow | null = row ? { status: row.status, retry_after: row.retry_after, source_ref: row.resource_id, attempts: row.attempts } : null;
	return source_eligible(prior, media.resource_id) ? { resource_id: media.resource_id, prior } : null;
}

/** Stores an alignment result (DONE) or failure for the target's file. A failure clears results from an older file. */
export async function record_alignment(track_id: string, target: VocalsTarget, status: SampleLookupStatus, retry_after: Date | null, result: AlignmentResult | null): Promise<void> {
	const now = new Date();
	const values = {
		resource_id: target.resource_id,
		status,
		attempts: next_attempts(target.prior, target.resource_id),
		attempted_at: now,
		retry_after,
		model: result?.model ?? null,
		duration_ms: result?.duration_ms ?? null,
		frame_ms: result?.frame_ms ?? null,
		alphabet: result?.alphabet ?? null,
		letter_scale: result?.letter_scale ?? null,
		letters: result?.letters ?? null,
		loudness: result?.loudness ?? null,
		words_model: result?.words_model ?? null,
		words: result?.words ?? null,
		word_times: result?.word_times ?? null,
		word_probabilities: result?.word_probabilities ?? null,
		beat_grid_model: result?.beat_grid_model ?? null,
		grid_beats: result?.grid_beats ?? null,
		downbeats: result?.downbeats ?? null,
		repeats: result?.repeats ?? null,
		repeat_strengths: result?.repeat_strengths ?? null
	};
	await db.insert(track_alignment_table).values({ track_id, ...values })
		.onConflictDoUpdate({ target: track_alignment_table.track_id, set: { ...values, modified_at: now } });
}

/**
 * Inserts the sample, its vector, and the DONE lookup in one transaction. The first sample wins, except that one from
 * a newer analyzer replaces a sample from an older one.
 */
export async function save_sample(row: SampleInsert, source: ResolvedSource): Promise<boolean> {
	return db.transaction(async (tx) => {
		const { id: _id, ...columns } = row;
		const inserted = await tx.insert(track_sample_data_table).values(row)
			.onConflictDoUpdate({
				target: track_sample_data_table.id,
				set: { ...columns, modified_at: new Date() },
				setWhere: sql`${track_sample_data_table.version} < excluded.version`
			})
			.returning({ id: track_sample_data_table.id });
		if (inserted.length > 0) await write_vector(tx, row.id);
		// The analyzer measured the audio itself: a track nobody gave a duration gets this one (and syncs it out).
		if (row.source_duration_ms) {
			await tx.update(tracks_table).set({ duration_ms: row.source_duration_ms, modified_at: new Date() })
				.where(and(eq(tracks_table.id, row.id), isNull(tracks_table.duration_ms)));
		}
		await record_lookup(tx, row.id, source, 'DONE', null);
		return inserted.length > 0;
	});
}
