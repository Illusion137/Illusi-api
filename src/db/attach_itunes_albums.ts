/**
 * One-off backfill: puts tracks linked to an iTunes song, but on no album, on that song's album, by the same rule as
 * new links (`attach_itunes_album`). Tracks split off onto their iTunes song before splits attached albums, and
 * links made before the rule allowed featured-artist titles and any credited artist, never got one.
 *
 *   node --import tsx src/db/attach_itunes_albums.ts            dry run: lists what it would attach, then rolls back
 *   node --import tsx src/db/attach_itunes_albums.ts --apply    keeps it
 */
import { sql } from 'drizzle-orm';
import { db } from './index';
import { write_audit } from '../core/audit';
import { PendingEvents } from '../core/events';
import { attach_itunes_album } from '../services/itunes/album_link';

const apply = process.argv.includes('--apply');

class Rollback extends Error {}

async function main() {
	const events = new PendingEvents();
	try {
		await db.transaction(async (tx) => {
			const candidates = (await tx.execute<{ id: string; title: string; applemusic_id: string }>(sql`
				select t.id, t.title, s.applemusic_id from tracks_table t join service_ids_table s on s.illusi_id = t.id
				where t.album_id is null and s.applemusic_id ~ '^[0-9]+$'
				  and not exists(select 1 from album_tracks_table x where x.track_id = t.id)
				order by t.id`)).rows;
			const attached: { track_id: string; album_id: string }[] = [];
			for (const c of candidates) {
				const album_id = await attach_itunes_album(tx, c.id, Number(c.applemusic_id), events);
				if (album_id === null) continue;
				attached.push({ track_id: c.id, album_id });
				const [album] = (await tx.execute<{ name: string }>(sql`select name from albums_table where id = ${album_id}`)).rows;
				console.log(`  ${c.title} → ${album?.name}`);
			}
			console.log(`\nattached ${attached.length} of ${candidates.length} track(s) to their iTunes album`);
			await write_audit(tx, { action: 'catalog_cleanup', actor: 'admin', details: { step: 'attach_itunes_albums', attached } });
			if (!apply) throw new Rollback();
		});
		events.flush();
		console.log('applied');
	} catch (err) {
		if (!(err instanceof Rollback)) throw err;
		console.log('dry run: rolled back (pass --apply to keep it)');
	} finally {
		await (db.$client as { end(): Promise<void> }).end();
	}
}

void main();
