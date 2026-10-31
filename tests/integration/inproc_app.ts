import type { AddressInfo } from 'node:net';
import { create_app } from '../../src/app';

/** Serves the Express app from this process on a free port, so its code counts toward coverage and can be stubbed. */
export async function start_inproc_app(): Promise<{ url: string; stop: () => Promise<void> }> {
	const server = create_app().listen(0, '127.0.0.1');
	await new Promise<void>(resolve => server.once('listening', resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, stop: () => new Promise<void>((resolve, reject) => { server.close(err => (err ? reject(err) : resolve())); server.closeAllConnections(); }) };
}
