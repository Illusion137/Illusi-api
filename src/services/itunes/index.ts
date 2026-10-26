import { ITunesService } from './service';

const service = new ITunesService();

/** Starts the queue (backfill scan + event listeners). Must not block startup: the drain runs in the background. */
export async function start(): Promise<void> {
	service.start();
}

/** Stops pulling new work and waits for the in-flight item (pending backoff sleeps are cut short). */
export async function stop(): Promise<void> {
	await service.stop();
}

/** Queues (live lane) any of these local entities that have never been looked up. Imported tracks are skipped. */
export async function enqueue_if_needed(illusi_ids: readonly string[]): Promise<void> {
	await service.enqueue_if_needed(illusi_ids);
}
