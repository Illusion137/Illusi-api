import { afterAll } from 'vitest';
import { start_inproc_app } from './inproc_app';

// The remaining black-box suites against an in-process server too, so their coverage of src/ is measured exactly
// (the API process under c8 only gives approximate line numbers).
const app = await start_inproc_app();
process.env.API_URL = app.url;
afterAll(async () => { await app.stop(); });

await import('./01_auth.test');
await import('./02_contribute.test');
await import('./03_sync.test');
await import('./09_read_performance.test');
await import('./10_search_suggestions.test');
await import('./12_email_verification.test');
await import('./14_cors_headers.test');
await import('./15_admin_dashboard.test');
await import('./40_auth_validation.test');
await import('./41_catalog_validation.test');
await import('./42_sync_entities_validation.test');
await import('./43_admin_validation.test');
await import('./44_account_media_playlists_validation.test');
await import('./45_ingest_validation.test');
await import('./46_service_catalog.test');
