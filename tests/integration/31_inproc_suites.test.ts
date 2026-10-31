import { afterAll } from 'vitest';
import { start_inproc_app } from './inproc_app';

// Runs the black-box suites against an in-process server (same database), so coverage sees the service code.
const app = await start_inproc_app();
process.env.API_URL = app.url;
afterAll(async () => { await app.stop(); });

await import('./04_lyrics_soundcloud.test');
await import('./05_media_playlists_admin.test');
await import('./06_releases_reconcile_concurrency.test');
await import('./08_backpack.test');
