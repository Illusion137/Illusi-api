import '../load_env';

/**
 * For scripts run on the host next to the compose stack: a compose .env leaves the database URLs empty and sets
 * POSTGRES_* instead, so build the owner URL the way compose.yaml does, against the port it publishes on 127.0.0.1.
 */
export function use_compose_owner_url() {
	if (process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL) return;
	const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;
	if (!POSTGRES_PASSWORD) return;
	const url = new URL('postgres://127.0.0.1:5432');
	url.username = POSTGRES_USER || 'illusi';
	url.password = POSTGRES_PASSWORD;
	url.pathname = `/${POSTGRES_DB || 'illusi'}`;
	process.env.MIGRATE_DATABASE_URL = url.toString();
}
