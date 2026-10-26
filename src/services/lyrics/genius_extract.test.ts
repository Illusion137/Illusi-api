import { describe, expect, it } from 'vitest';
import { epoch_to_date, extract_genius_payload, match_genius_song, release_date } from './genius_extract';
import type { GeniusExtraction, TrackFacts } from './genius_extract';

const artist = (id: number, name: string) => ({ id, name, slug: name.toLowerCase(), url: `https://genius.com/artists/${name}`, imageUrl: `https://images.genius.com/${id}.png`, headerImageUrl: null });

function fixture(overrides: Record<string, unknown> = {}) {
	return {
		songPage: { song: 100, lyricsData: { body: { tag: 'root', children: [{ tag: 'p', children: ['Hello', { tag: 'br' }, 'World'] }] } } },
		entities: {
			users: { 7: { id: 7, login: 'owner', name: 'Owner', avatar: { medium: { url: 'https://a/m.png' } }, iq: 10 } },
			artists: { 1: artist(1, 'Main Artist') },
			songs: {
				100: {
					id: 100,
					title: 'Great Song',
					primaryArtist: artist(1, 'Main Artist'),
					primaryArtists: [artist(1, 'Main Artist')],
					featuredArtists: [artist(2, 'Guest')],
					writerArtists: [artist(3, 'Writer')],
					producerArtists: [artist(4, 'Producer')],
					lyricsOwnerId: 7,
					description: { markdown: 'About' },
					stats: { hot: true, pageviews: 1234 },
					appleMusicId: '1440000001',
					spotifyUuid: '4uLU6hMCjMI75M1A2tKUQC',
					youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
					soundcloudUrl: 'https://soundcloud.com/User/Track?in=x',
					media: [
						{ provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', type: 'video' },
						{ provider: 'spotify', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', type: 'audio' },
						{ provider: 'napster', url: 'https://napster.com/x', type: 'audio' }
					],
					releaseDate: '2020-05-01',
					lyricsUpdatedAt: 1_700_000_000,
					updatedByHumanAt: 1_700_000_100,
					instrumental: false,
					songArtImageUrl: 'https://images.genius.com/art.1000x1000x1.png',
					album: { id: 9, name: 'The Album' },
					...overrides
				}
			},
			referents: {
				50: { id: 50, songId: 100, annotatorId: 7, fragment: 'Hello', classification: 'accepted', path: '/50', isImage: false, isDescription: false },
				51: { id: 51, classification: 'unreviewed', fragmentId: 'f' },
				52: { id: 52, songId: 999, fragment: 'other song' }
			},
			annotations: {
				60: { id: 60, referentId: 50, createdBy: 7, body: { markdown: 'note' }, createdAt: 1_600_000_000, votesTotal: 3 },
				61: { id: 61, referentId: 404, body: { markdown: 'orphan' } }
			}
		}
	};
}

function extract(overrides: Record<string, unknown> = {}): GeniusExtraction {
	const ex = extract_genius_payload(fixture(overrides));
	if ('error' in ex) throw new Error(ex.error);
	return ex;
}

describe('extract_genius_payload', () => {
	it('verifies songPage.song is in entities.songs', () => {
		const state = fixture();
		state.songPage.song = 101;
		expect(extract_genius_payload(state)).toEqual({ error: 'preloaded_state.songPage.song is not in entities.songs' });
		expect(extract_genius_payload({})).toHaveProperty('error');
		expect(extract_genius_payload(null)).toHaveProperty('error');
	});

	it('maps users, artists, roles and the song', () => {
		const ex = extract();
		expect(ex.users).toEqual([expect.objectContaining({ id: 7, login: 'owner', avatar_url: 'https://a/m.png', iq: 10 })]);
		expect(ex.artists.map(a => a.id).sort()).toEqual([1, 2, 3, 4]);
		expect(ex.song_artists).toEqual([
			{ artist_id: 1, role: 'PRIMARY' },
			{ artist_id: 2, role: 'FEATURED' },
			{ artist_id: 4, role: 'PRODUCER' },
			{ artist_id: 3, role: 'WRITER' }
		]);
		expect(ex.song).toMatchObject({
			id: 100, primary_artist_id: 1, lyrics_owner_id: 7, description: 'About', hot: true, pageviews: 1234,
			apple_music_id: '1440000001', spotify_uuid: '4uLU6hMCjMI75M1A2tKUQC', release_date: '2020-05-01'
		});
		expect(ex.song.lyrics_updated_at).toEqual(new Date(1_700_000_000_000));
		expect(ex.producer_ids).toEqual([4]);
	});

	it('keeps referents of this song (stubs included) and annotations with a known referent', () => {
		const ex = extract();
		expect(ex.referents.map(r => [r.id, r.song_id])).toEqual([[50, 100], [51, 100]]);
		expect(ex.annotations.map(a => a.id)).toEqual([60]);
		expect(ex.annotations[0]).toMatchObject({ referent_id: 50, created_by_id: 7, body_markdown: 'note', genius_created_at: new Date(1_600_000_000_000) });
	});

	it('stores the raw lyrics body, none for instrumentals', () => {
		const ex = extract();
		expect(ex.lyrics?.format).toBe('GENIUS_BODY_JSON');
		expect(JSON.parse(ex.lyrics!.raw_content)).toEqual(fixture().songPage.lyricsData.body);
		const instrumental = extract({ instrumental: true });
		expect(instrumental.instrumental).toBe(true);
		expect(instrumental.lyrics).toBeNull();
	});

	it('collects normalized service ids and unknown providers', () => {
		const ex = extract();
		expect(ex.ids.map(c => [c.column, c.value])).toEqual([
			['genius_id', 100],
			['applemusic_id', '1440000001'],
			['spotify_id', '4uLU6hMCjMI75M1A2tKUQC'],
			['youtube_id', 'dQw4w9WgXcQ'],
			['soundcloud_permalink', 'user/track']
		]);
		expect(ex.unknown_providers).toEqual([{ provider: 'napster', url: 'https://napster.com/x' }]);
		expect(ex.credited_artists.map(a => a.id)).toEqual([1, 2]);
		expect(ex.facts).toEqual({ title: 'Great Song', primary_artist: 'Main Artist', album: 'The Album', duration_ms: null });
	});

	it('converts formats defensively', () => {
		expect(epoch_to_date(1)).toEqual(new Date(1000));
		expect(epoch_to_date('x')).toBeNull();
		expect(release_date('2020-13-45')).toBeNull();
		expect(release_date('May 1, 2020')).toBeNull();
	});
});

describe('match_genius_song', () => {
	const track: TrackFacts = { service_ids: {}, title: 'Great Song (Remastered)', artists: ['Main Artist', 'Guest'], album: 'The Album', duration_ms: 200_000 };

	it('matches on any shared id first', () => {
		const ex = extract({ title: 'Totally Different' });
		expect(match_genius_song({ ...track, service_ids: { youtube_id: 'dQw4w9WgXcQ' } }, ex)).toEqual({ matched: true, method: 'id', column: 'youtube_id' });
		expect(match_genius_song({ ...track, service_ids: { genius_id: 100 } }, ex)).toMatchObject({ matched: true, method: 'id' });
	});

	it('falls back to metadata', () => {
		expect(match_genius_song(track, extract())).toEqual({ matched: true, method: 'metadata' });
	});

	it('rejects on title, artist, album or duration mismatch', () => {
		expect(match_genius_song(track, extract({ title: 'Other Song' }))).toEqual({ matched: false, reason: 'title' });
		expect(match_genius_song({ ...track, artists: ['Somebody Else'] }, extract())).toEqual({ matched: false, reason: 'artist' });
		expect(match_genius_song({ ...track, album: 'Different Record' }, extract())).toEqual({ matched: false, reason: 'album' });
		const with_duration = extract({ media: [{ provider: 'youtube', url: 'https://youtu.be/aaaaaaaaaaa', duration: 210 }] });
		expect(match_genius_song(track, with_duration)).toEqual({ matched: false, reason: 'duration' });
		const close = extract({ media: [{ provider: 'youtube', url: 'https://youtu.be/aaaaaaaaaaa', duration: 202 }] });
		expect(match_genius_song(track, close)).toEqual({ matched: true, method: 'metadata' });
	});

	it('ignores album when one side has none', () => {
		expect(match_genius_song({ ...track, album: null }, extract({ album: null }))).toMatchObject({ matched: true });
	});

	it('a different id value is not a match by itself', () => {
		expect(match_genius_song({ ...track, title: 'x', service_ids: { applemusic_id: '1' } }, extract())).toEqual({ matched: false, reason: 'title' });
	});
});
