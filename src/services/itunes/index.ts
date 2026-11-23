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

/** iTunes lookups through the process-wide request gate; they throw `ITunesStoppedError` once the service stops. */
export const itunes_lookups = {
	artist_albums: async (artist_id: number) => service.artist_albums(artist_id),
	album_tracks: async (collection_ids: readonly number[]) => service.album_tracks(collection_ids)
};
export type ITunesLookups = typeof itunes_lookups;

/** Queues (live lane) any of these local entities that have never been looked up. Imported tracks are skipped. */
export async function enqueue_if_needed(illusi_ids: readonly string[]): Promise<void> {
	await service.enqueue_if_needed(illusi_ids);
}
