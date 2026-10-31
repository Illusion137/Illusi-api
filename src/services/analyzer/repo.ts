import { desc, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Executor } from '../../db';
import { db } from '../../db';
import { itunes_tracks_table, media_table, service_ids_table, track_sample_data_table, track_sample_lookups_table, track_vocals_table } from '../../db/schema';
import { write_vector } from '../vectors';
import type { SampleInsert, VocalsResult } from './contract';
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

/** Resolves the source a job should analyze right now, or null (sample exists / nothing eligible). */
export async function resolve_source(track_id: string, prefer?: SampleSource): Promise<ResolvedSource | null> {
	const [sample] = await db.select({ id: track_sample_data_table.id }).from(track_sample_data_table).where(eq(track_sample_data_table.id, track_id));
	if (sample) return null;

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
	const lookups = new Map<SampleSource, LookupRow>(lookup_rows.map(l => [l.source, { status: l.status, retry_after: l.retry_after, source_ref: l.source_ref, attempts: l.attempts }]));
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

/** Track ids whose newest media file has no vocals result and no failure blocking it (`source_eligible` rules). */
export async function eligible_vocals_track_ids(): Promise<string[]> {
	const rows = await db.execute<{ track_id: string }>(sql`
		select lm.track_id from (
			select distinct on (m.track_id) m.track_id, m.resource_id from media_table m order by m.track_id, m.id desc
		) lm
		left join track_vocals_table v on v.track_id = lm.track_id
		where v.track_id is null
			or v.resource_id <> lm.resource_id
			or (v.status = 'ERROR' and (v.retry_after is null or v.retry_after <= now()))`, 'objects');
	return rows.map(r => r.track_id);
}

export interface VocalsTarget { resource_id: string; prior: LookupRow | null }

/** The media file a vocals job should analyze right now, or null (no media / already done / blocked). */
export async function resolve_vocals_target(track_id: string): Promise<VocalsTarget | null> {
	const [media] = await db.select({ resource_id: media_table.resource_id }).from(media_table)
		.where(eq(media_table.track_id, track_id)).orderBy(desc(media_table.id)).limit(1);
	if (!media) return null;
	const [row] = await db.select().from(track_vocals_table).where(eq(track_vocals_table.track_id, track_id));
	const prior: LookupRow | null = row ? { status: row.status, retry_after: row.retry_after, source_ref: row.resource_id, attempts: row.attempts } : null;
	return source_eligible(prior, media.resource_id) ? { resource_id: media.resource_id, prior } : null;
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
		segments: result?.segments ?? null
	};
	await db.insert(track_vocals_table).values({ track_id, ...values })
		.onConflictDoUpdate({ target: track_vocals_table.track_id, set: { ...values, modified_at: now } });
}

/** Inserts the sample (first sample wins), its vector, and the DONE lookup in one transaction. */
export async function save_sample(row: SampleInsert, source: ResolvedSource): Promise<boolean> {
	return db.transaction(async (tx) => {
		const inserted = await tx.insert(track_sample_data_table).values(row).onConflictDoNothing().returning({ id: track_sample_data_table.id });
		if (inserted.length > 0) await write_vector(tx, row.id);
		await record_lookup(tx, row.id, source, 'DONE', null);
		return inserted.length > 0;
	});
}
