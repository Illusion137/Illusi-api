import { describe, expect, it, vi } from 'vitest';
import { ProvenanceLog } from './provenance';

const tx = (id = 7) => {
	const values = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id }]) }));
	return { tx: { insert: vi.fn(() => ({ values })) }, values };
};

describe('ProvenanceLog', () => {
	it('ignores touches that filled nothing', () => {
		const log = new ProvenanceLog('contribute', 'u1');
		log.touch('tracks', 1, []);
		log.touch('tracks', 2, ['*']);
		expect(log.entities).toEqual([{ table: 'tracks', id: 2, filled: ['*'] }]);
	});

	it('writes one row and returns its id', async () => {
		const { tx: t, values } = tx(42);
		const log = new ProvenanceLog('contribute', 'u1', 'jti', 'c1');
		log.touch('tracks', 'a', ['name']);
		expect(await log.write(t as never, { ok: true })).toBe(42);
		expect(values).toHaveBeenCalledWith({ contribution_id: 'c1', user_id: 'u1', source: 'contribute', token_jti: 'jti', entities: [{ table: 'tracks', id: 'a', filled: ['name'] }], response: { ok: true } });
	});

	it('defaults optional ids and response to null', async () => {
		const { tx: t, values } = tx();
		await new ProvenanceLog('contribute', 'u1').write(t as never);
		expect(values).toHaveBeenCalledWith(expect.objectContaining({ contribution_id: null, token_jti: null, response: null, entities: [] }));
	});
});
