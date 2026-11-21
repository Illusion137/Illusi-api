import express from 'express';
import { require_admin, require_auth, require_verified } from './core/auth/middleware';
import { config } from './config';
import { cors } from './core/cors';
import { health_router } from './core/health';
import { error_handler } from './core/http';
import { request_context } from './core/request_id';
import { auth_router } from './routes/auth';
import { account_router } from './services/account';
import { admin_router, admin_ui } from './services/admin';
import { backpack_router } from './services/backpack';
import { durations_router } from './services/durations';
import { catalog_router } from './services/catalog';
import { entities_router } from './services/entities';
import { lyrics_router } from './services/lyrics';
import { media_router } from './services/media';
import { playlists_router } from './services/playlists';
import { releases_router } from './services/releases';
import { soundcloud_router } from './services/soundcloud';
import { service_catalog_router } from './services/service_catalog';
import { sync_router } from './services/sync';

/** Every client-facing route lives under this prefix; `/health` stays at the root for infrastructure. */
export const API_PREFIX = '/api/v1';

export function create_app() {
	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', parse_trust_proxy(config.TRUST_PROXY));

	app.use(request_context);
	app.use(cors(config.CORS_ALLOWED_DOMAIN));
	app.use(health_router);
	app.use('/admin', admin_ui());
	app.use(API_PREFIX, api_v1());

	app.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
	app.use(error_handler);
	return app;
}

function api_v1() {
	const api = express.Router();
	api.use('/auth', auth_router);

	// Everything below requires a valid access token and a confirmed email address.
	api.use(require_auth, require_verified);
	api.use('/admin', require_admin, admin_router);
	api.use(sync_router);
	api.use(entities_router);
	api.use(lyrics_router);
	api.use(soundcloud_router);
	api.use(service_catalog_router);
	api.use(playlists_router);
	api.use(media_router);
	api.use(releases_router);
	api.use(backpack_router);
	api.use(durations_router);
	api.use(account_router);
	api.use(catalog_router);
	return api;
}

/** `TRUST_PROXY`: a hop count, true/false, or Express subnet names / CIDRs (`loopback, uniquelocal`). */
export function parse_trust_proxy(value: string): boolean | number | string {
	if (/^\d+$/u.test(value)) return Number(value);
	if (value === 'true' || value === 'false') return value === 'true';
	return value;
}
