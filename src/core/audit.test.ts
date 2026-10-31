import { describe, expect, it, vi } from 'vitest';
import { write_audit } from './audit';

const tx = () => {
	const values = vi.fn().mockResolvedValue(undefined);
	return { tx: { insert: vi.fn(() => ({ values })) }, values };
};

describe('write_audit', () => {
	it('inserts the entry with nulls for omitted fields', async () => {
		const { tx: t, values } = tx();
		await write_audit(t as never, { action: 'merge', actor: 'reconcile', details: { a: 1 } });
		expect(values).toHaveBeenCalledWith({ action: 'merge', actor: 'reconcile', actor_user_id: null, entity_table: null, entity_id: null, details: { a: 1 }, undo: null });
	});

	it('keeps everything provided and defaults missing details to {}', async () => {
		const { tx: t, values } = tx();
		await write_audit(t as never, { action: 'admin_edit', actor: 'admin', actor_user_id: 'u', entity_table: 'x', entity_id: '1', details: undefined, undo: { v: 1 } });
		expect(values).toHaveBeenCalledWith({ action: 'admin_edit', actor: 'admin', actor_user_id: 'u', entity_table: 'x', entity_id: '1', details: {}, undo: { v: 1 } });
	});
});
