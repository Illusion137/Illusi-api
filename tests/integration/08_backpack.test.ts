import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { add_to_library, api, contribute, create_user, mock_album, query, unique, uuid, wav_bytes } from './helpers';
import type { TestUser } from './helpers';

const youtube_id = () => randomBytes(8).toString('base64url').slice(0, 11);

async function backpacked(track_id: string): Promise<{ backpacked: boolean; backpacked_at: Date | null }> {
	const [row] = await query('select backpacked, backpacked_at from tracks_table where id = $1', [track_id]);
	return row;
}

/** Moves the report back past the upload window so research actions start. */
async function age_report(track_id: string, hours = 49) {
	await query(`update tracks_table set backpacked_at = now() - make_interval(hours => $2) where id = $1`, [track_id, hours]);
}

function research_requests(user: TestUser) {
	return api('GET', '/backpack/requests', { token: user.access_token });
}

function upload(user: TestUser, track_id: string, file: Buffer) {
	const form = new FormData();
	form.append('file', new Blob([new Uint8Array(file)], { type: 'audio/wav' }), 'song.wav');
	return api('POST', `/tracks/${track_id}/media`, { token: user.access_token, raw: form });
}

async function pull_actions(user: TestUser) {
	let cursor: string | undefined;
	for (;;) {
		const res = await api('POST', '/sync/pull', { token: user.access_token, body: cursor ? { cursor } : {} });
		expect(res.status).toBe(200);
		if (!res.body.has_more) return (res.body.actions ?? []) as { type: string; track_id: string; service?: string }[];
		cursor = res.body.next_cursor;
	}
}

describe('backpacked tracks', () => {
	it('flags a reported track, asks downloaders for a copy, and clears the flag on upload', async () => {
		const owner = await create_user('bp-owner');
		const created = await contribute(owner, mock_album({ artist: unique('BP Artist'), album: unique('BP Album'), n: 3 }));
		const tracks: string[] = [created.body.refs.t0, created.body.refs.t1, created.body.refs.t2];
		await add_to_library(owner, tracks, { downloaded_at: new Date().toISOString() });

		const reporter = await create_user('bp-reporter');
		await add_to_library(reporter, tracks);
		// The last track by id, so ordering by id alone would put it last.
		const target = [...tracks].sort().at(-1)!;
		const report = await api('POST', `/tracks/${target}/unavailable`, { token: reporter.access_token, body: { service: 'youtube', reason: 'video removed' } });
		expect(report.status).toBe(200);
		expect(report.body).toMatchObject({ track_id: target, backpacked: true, has_media: false });
		const first = await backpacked(target);
		expect(first.backpacked).toBe(true);

		// Reporting again keeps the original time.
		await api('POST', `/tracks/${target}/unavailable`, { token: owner.access_token, body: { service: 'soundcloud' } });
		expect((await backpacked(target)).backpacked_at).toEqual(first.backpacked_at);
		expect(await query('select service from track_unavailable_reports_table where track_id = $1 order by service', [target]))
			.toEqual([{ service: 'soundcloud' }, { service: 'youtube' }]);

		const actions = await pull_actions(owner);
		const uploads = actions.filter(a => a.type === 'UPLOAD_MEDIA').map(a => a.track_id);
		// Only the backpacked track: the other downloads can still be played from a service.
		expect(uploads).toEqual([target]);

		// Still inside the upload window: nobody is asked to research it.
		expect((await research_requests(reporter)).body.actions).toEqual([]);

		expect((await upload(owner, target, wav_bytes(Math.floor(Math.random() * 1000)))).status).toBe(201);
		expect((await backpacked(target)).backpacked).toBe(false);

		// With a server copy, a report doesn't flag it.
		const again = await api('POST', `/tracks/${target}/unavailable`, { token: reporter.access_token, body: { service: 'youtube' } });
		expect(again.body).toMatchObject({ backpacked: false, has_media: true });
		expect((await backpacked(target)).backpacked).toBe(false);
	});

	it('asks library users to research it on each service, and a found id makes it playable', async () => {
		const owner = await create_user('bp-research');
		const created = await contribute(owner, mock_album({ artist: unique('Research Artist'), album: unique('Research Album'), n: 1 }));
		const t0: string = created.body.refs.t0;
		await add_to_library(owner, [t0]);
		const outsider = await create_user('bp-outsider');

		expect((await api('POST', `/tracks/${t0}/unavailable`, { token: owner.access_token, body: { service: 'youtube' } })).body.backpacked).toBe(true);
		await age_report(t0);

		const [youtube] = (await research_requests(owner)).body.actions;
		expect(youtube).toMatchObject({ type: 'RESEARCH_TRACK', track_id: t0, service: 'youtube', artists: [expect.stringMatching(/^Research Artist/u)] });
		expect(youtube.query).toContain(' - ');
		expect((await research_requests(outsider)).body.actions).toEqual([]);

		// youtube is cooling down, so the next request moves to the next empty service.
		const [soundcloud] = (await research_requests(owner)).body.actions;
		expect(soundcloud.service).toBe('soundcloud');

		const not_found = await api('POST', '/ingest/track_research', { token: owner.access_token, body: { token: soundcloud.token, track_id: t0, service: 'soundcloud', result: 'NOT_FOUND' } });
		expect(not_found.status).toBe(200);
		expect(not_found.body).toMatchObject({ status: 'NOT_FOUND', applied: false, backpacked: true });

		// A token only fulfils the service it was issued for, and only once.
		const wrong = await api('POST', '/ingest/track_research', { token: owner.access_token, body: { token: youtube.token, track_id: t0, service: 'bandlab', service_id: 'x' } });
		expect(wrong.status).toBeGreaterThanOrEqual(400);
		const invalid = await api('POST', '/ingest/track_research', { token: owner.access_token, body: { token: youtube.token, track_id: t0, service: 'youtube', service_id: 'not a video' } });
		expect(invalid.status).toBe(422);

		const id = youtube_id();
		const found = await api('POST', '/ingest/track_research', { token: owner.access_token, body: { token: youtube.token, track_id: t0, service: 'youtube', service_id: `https://youtu.be/${id}` } });
		expect(found.status).toBe(200);
		expect(found.body).toMatchObject({ status: 'FOUND', applied: true, backpacked: false });
		expect(await query('select youtube_id from service_ids_table where illusi_id = $1', [t0])).toEqual([{ youtube_id: id }]);
		expect(await query('select service, status, found_value from track_research_table where track_id = $1 order by service', [t0])).toEqual([
			{ service: 'soundcloud', status: 'NOT_FOUND', found_value: null },
			{ service: 'youtube', status: 'FOUND', found_value: id }
		]);
		const reuse = await api('POST', '/ingest/track_research', { token: owner.access_token, body: { token: youtube.token, track_id: t0, service: 'youtube', service_id: id } });
		expect(reuse.status).toBeGreaterThanOrEqual(400);
		expect((await research_requests(owner)).body.actions).toEqual([]);
	});

	it('keeps it backpacked when the found id differs from a dead one already stored', async () => {
		const owner = await create_user('bp-conflict');
		const created = await contribute(owner, mock_album({ artist: unique('Conflict Artist'), album: unique('Conflict Album'), n: 1 }));
		const t0: string = created.body.refs.t0;
		await add_to_library(owner, [t0]);
		const dead = youtube_id();
		await query('update service_ids_table set youtube_id = $2, soundcloud_permalink = $3, bandlab_id = $4, audiomack_id = $5 where illusi_id = $1',
			[t0, dead, `someone/${unique('dead')}`, unique('bl'), unique('am')]);

		await api('POST', `/tracks/${t0}/unavailable`, { token: owner.access_token, body: { service: 'youtube' } });
		await age_report(t0);
		const [action] = (await research_requests(owner)).body.actions;
		expect(action.service).toBe('youtube');

		const res = await api('POST', '/ingest/track_research', { token: owner.access_token, body: { token: action.token, track_id: t0, service: 'youtube', service_id: youtube_id() } });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ status: 'FOUND', applied: false, backpacked: true, conflict: { column: 'youtube_id', kind: 'different_value', existing_value: dead } });
		expect(await query('select count(*)::int as n from service_id_conflicts_table where illusi_id = $1 and "column" = $2', [t0, 'youtube_id'])).toEqual([{ n: 1 }]);
	});

	it('hands research actions out on sync pull', async () => {
		const owner = await create_user('bp-pull');
		const created = await contribute(owner, mock_album({ artist: unique('Pull Artist'), album: unique('Pull Album'), n: 1 }));
		const t0: string = created.body.refs.t0;
		await add_to_library(owner, [t0]);
		await api('POST', `/tracks/${t0}/unavailable`, { token: owner.access_token, body: { service: 'audiomack' } });
		await age_report(t0);
		const research = (await pull_actions(owner)).filter(a => a.type === 'RESEARCH_TRACK');
		expect(research).toEqual([expect.objectContaining({ track_id: t0, service: 'youtube' })]);
	});

	it('validates reports', async () => {
		const user = await create_user('bp-bad');
		expect((await api('POST', `/tracks/${uuid()}/unavailable`, { token: user.access_token, body: { service: 'youtube' } })).status).toBe(404);
		expect((await api('POST', '/tracks/nope/unavailable', { token: user.access_token, body: { service: 'youtube' } })).status).toBe(400);
		const created = await contribute(user, mock_album({ artist: unique('Bad Artist'), album: unique('Bad Album'), n: 1 }));
		expect((await api('POST', `/tracks/${created.body.refs.t0}/unavailable`, { token: user.access_token, body: { service: 'spotify' } })).status).toBe(400);
	});
});
