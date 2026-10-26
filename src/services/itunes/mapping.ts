import type { ITunesArtist, ITunesCollection, ITunesTrack } from '@origin/itunes/itunes';
import type { itunes_artists_table, itunes_collections_table, itunes_tracks_table } from '../../db/schema';

export type ITunesArtistRow = typeof itunes_artists_table.$inferInsert;
export type ITunesCollectionRow = typeof itunes_collections_table.$inferInsert;
export type ITunesTrackRow = typeof itunes_tracks_table.$inferInsert;

type Explicitness = 'explicit' | 'cleaned' | 'notExplicit';
const EXPLICITNESS = new Set<string>(['explicit', 'cleaned', 'notExplicit']);

export function map_explicitness(value: unknown): Explicitness | null {
	return typeof value === 'string' && EXPLICITNESS.has(value) ? value as Explicitness : null;
}

function date_or_null(value: string | undefined): Date | null {
	if (!value) return null;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const str_array = (v: unknown) => (Array.isArray(v) ? v.map(String) : null);

/** iTunes rarely returns `artworkUrl600`; the same image is served at 600x600 by rewriting the size. */
export function artwork_600(url600: string | undefined, url100: string | undefined): string | null {
	if (url600) return url600;
	if (url100?.includes('100x100bb')) return url100.replace('100x100bb', '600x600bb');
	return null;
}

export function map_artist(a: ITunesArtist): ITunesArtistRow {
	return {
		id: a.artistId!,
		name: a.artistName ?? '',
		link_url: str(a.artistLinkUrl) ?? str(a.artistViewUrl),
		artist_type: str(a.artistType),
		amg_artist_id: int(a.amgArtistId),
		primary_genre_name: str(a.primaryGenreName),
		primary_genre_id: int(a.primaryGenreId)
	};
}

export function map_collection(c: ITunesCollection): ITunesCollectionRow {
	return {
		id: c.collectionId!,
		artist_id: int(c.artistId),
		name: c.collectionName ?? c.collectionCensoredName ?? '',
		censored_name: str(c.collectionCensoredName),
		kind: str(c.kind),
		view_url: str(c.collectionViewUrl),
		artwork_url_30: str(c.artworkUrl30),
		artwork_url_60: str(c.artworkUrl60),
		artwork_url_100: str(c.artworkUrl100),
		artwork_url_600: artwork_600(c.artworkUrl600, c.artworkUrl100),
		price: num(c.collectionPrice),
		explicitness: map_explicitness(c.collectionExplicitness),
		track_count: int(c.trackCount),
		copyright: str(c.copyright),
		content_advisory_rating: str(c.contentAdvisoryRating),
		country: str(c.country),
		currency: str(c.currency),
		release_date: date_or_null(c.releaseDate),
		primary_genre_name: str(c.primaryGenreName),
		primary_genre_id: int(c.primaryGenreId),
		genres: str_array(c.genres),
		genre_ids: str_array(c.genreIds)
	};
}

export function map_track(t: ITunesTrack): ITunesTrackRow {
	return {
		id: t.trackId!,
		artist_id: int(t.artistId),
		collection_id: int(t.collectionId),
		name: t.trackName ?? t.trackCensoredName ?? '',
		censored_name: str(t.trackCensoredName),
		kind: str(t.kind),
		view_url: str(t.trackViewUrl),
		preview_url: str(t.previewUrl),
		artwork_url_30: str(t.artworkUrl30),
		artwork_url_60: str(t.artworkUrl60),
		artwork_url_100: str(t.artworkUrl100),
		artwork_url_600: artwork_600(t.artworkUrl600, t.artworkUrl100),
		price: num(t.trackPrice),
		explicitness: map_explicitness(t.trackExplicitness),
		disc_count: int(t.discCount),
		disc_number: int(t.discNumber),
		track_count: int(t.trackCount),
		track_number: int(t.trackNumber),
		track_time_millis: int(t.trackTimeMillis),
		is_streamable: typeof t.isStreamable === 'boolean' ? t.isStreamable : null,
		country: str(t.country),
		currency: str(t.currency),
		release_date: date_or_null(t.releaseDate),
		primary_genre_name: str(t.primaryGenreName),
		primary_genre_id: int(t.primaryGenreId),
		genres: str_array(t.genres),
		genre_ids: str_array(t.genreIds)
	};
}

/** A minimal artist row from a song/album result, used only when the full artist row isn't known (FK target). */
export function derive_artist(r: ITunesTrack | ITunesCollection): ITunesArtistRow | null {
	if (r.artistId == null || !r.artistName) return null;
	return { id: r.artistId, name: r.artistName, link_url: str(r.artistViewUrl), primary_genre_name: null, primary_genre_id: null };
}

/** A minimal collection row from a song result, used only when the full collection row isn't known (FK target). */
export function derive_collection(t: ITunesTrack): ITunesCollectionRow | null {
	if (t.collectionId == null || !(t.collectionName ?? t.collectionCensoredName)) return null;
	return {
		id: t.collectionId,
		artist_id: int(t.artistId),
		name: t.collectionName ?? t.collectionCensoredName ?? '',
		censored_name: str(t.collectionCensoredName),
		view_url: str(t.collectionViewUrl),
		artwork_url_30: str(t.artworkUrl30),
		artwork_url_60: str(t.artworkUrl60),
		artwork_url_100: str(t.artworkUrl100),
		artwork_url_600: artwork_600(t.artworkUrl600, t.artworkUrl100),
		price: num(t.collectionPrice),
		explicitness: map_explicitness(t.collectionExplicitness),
		track_count: int(t.trackCount),
		country: str(t.country),
		currency: str(t.currency)
	};
}
