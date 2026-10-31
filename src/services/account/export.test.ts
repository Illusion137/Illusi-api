import { describe, expect, it } from 'vitest';
import { export_path, job_view } from './export';

describe('export files', () => {
	const id = '0b7c9a3e-5f1d-4c2a-9e8b-123456789abc';
	it('only resolves `<uuid>.json.gz` names inside the exports folder', () => {
		expect(export_path(`${id}.json.gz`)).toMatch(new RegExp(`/\\.exports/${id}\\.json\\.gz$`, 'u'));
		for (const bad of [`${id}.json.gz.part`, `${id}.json`, `../${id}.json.gz`, `${id}.jpg`, '']) expect(export_path(bad)).toBeNull();
	});
	it('shows clients the job without its user or file name', () => {
		const now = new Date();
		const view = job_view({ id, user_id: 'u', status: 'READY', file_name: `${id}.json.gz`, size: 10, error: null, created_at: now, started_at: now, finished_at: now, expires_at: now });
		expect(view).toEqual({ id, status: 'READY', created_at: now, started_at: now, finished_at: now, expires_at: now, size: 10, error: null });
	});
});
