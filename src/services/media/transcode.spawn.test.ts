import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
	spawn: () => {
		const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => undefined;
		queueMicrotask(() => child.emit('error', new Error('spawn nice ENOENT')));
		return child;
	}
}));

import { normalize_image } from './transcode';

describe('transcode when the process cannot start', () => {
	it('rejects with the spawn error', async () => {
		await expect(normalize_image('/in', '/out', 100)).rejects.toThrow();
	});
});
