import { describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { system_status } from '../../src/services/admin/status';

describe.skipIf(!process.env.DATABASE_URL)('system status (in-process)', () => {
	it('reports an unreadable media directory instead of failing', async () => {
		const mutable = config as { MEDIA_DIR: string };
		const original = mutable.MEDIA_DIR;
		mutable.MEDIA_DIR = '/nonexistent/illusi-media';
		try {
			const status = await system_status();
			expect(status.disk).toMatchObject({ ok: false, path: '/nonexistent/illusi-media', error: expect.any(String) });
		} finally {
			mutable.MEDIA_DIR = original;
		}
	});
});
