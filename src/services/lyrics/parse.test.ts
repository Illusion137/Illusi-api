import { describe, expect, it } from 'vitest';
import { find_ytm_plain_text, parse_lrc, parse_lyrics, parse_richsync, try_parse_lyrics } from './parse';

const TTML_WORD = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><head><metadata><iTunesMetadata><songwriters><songwriter>A Writer</songwriter></songwriters></iTunesMetadata></metadata></head><body><div><p begin="0:01.000" end="0:02.500" ttm:agent="v1"><span begin="0:01.000" end="0:01.500">Hello</span> <span begin="0:01.500" end="0:02.500">world</span></p><p begin="0:03.000" end="0:04.000"><span begin="0:03.000" end="0:04.000">Again</span></p></div></body></tt>`;

const TTML_NONE = '<tt itunes:timing="None"><body><div><p>First line</p><p>Second &amp; last</p></div></body></tt>';

describe('TTML', () => {
	it('parses word-synced TTML into lines with segments', () => {
		const parsed = parse_lyrics('TTML', 'WORD', TTML_WORD);
		expect(parsed.sync_type).toBe('WORD');
		expect(parsed.songwriters).toEqual(['A Writer']);
		expect(parsed.lines).toHaveLength(2);
		expect(parsed.lines[0]).toMatchObject({ text: 'Hello world', start_ms: 1000, end_ms: 2500, agent: 'v1' });
		expect(parsed.lines[0].segments).toEqual([
			{ text: 'Hello ', start_ms: 1000, end_ms: 1500 },
			{ text: 'world', start_ms: 1500, end_ms: 2500 }
		]);
	});

	it('drops segments for LINE sync', () => {
		const parsed = parse_lyrics('TTML', 'LINE', TTML_WORD);
		expect(parsed.lines[0].segments).toBeUndefined();
		expect(parsed.lines[0].start_ms).toBe(1000);
	});

	it('falls back to unsynced <p> lines', () => {
		const parsed = parse_lyrics('TTML', 'NONE', TTML_NONE);
		expect(parsed.lines.map(l => l.text)).toEqual(['First line', 'Second & last']);
		expect(parsed.lines[0].start_ms).toBeNull();
	});

	it('fails on garbage without throwing from try_parse', () => {
		expect(try_parse_lyrics('TTML', 'WORD', 'not ttml').ok).toBe(false);
	});
});

describe('LRC', () => {
	it('parses line-synced LRC, ignoring tags and filling ends', () => {
		const parsed = parse_lrc('[ar:Someone]\n[00:01.00]One\n[00:02.50] Two\n[00:04.00]', 'LINE');
		expect(parsed.lines.map(l => [l.text, l.start_ms, l.end_ms])).toEqual([
			['One', 1000, 2500],
			['Two', 2500, 4000],
			['', 4000, null]
		]);
	});

	it('expands repeated timestamps and sorts', () => {
		const parsed = parse_lrc('[00:05.00][00:01.00]Chorus\n[00:03.00]Verse', 'LINE');
		expect(parsed.lines.map(l => [l.text, l.start_ms])).toEqual([['Chorus', 1000], ['Verse', 3000], ['Chorus', 5000]]);
	});

	it('parses enhanced LRC word stamps', () => {
		const parsed = parse_lrc('[00:01.00]<00:01.00>Hello <00:01.50>world<00:02.00>', 'WORD');
		expect(parsed.lines[0].text).toBe('Hello world');
		expect(parsed.lines[0].segments).toEqual([
			{ text: 'Hello ', start_ms: 1000, end_ms: 1500 },
			{ text: 'world', start_ms: 1500, end_ms: 2000 }
		]);
		expect(parsed.lines[0].end_ms).toBe(2000);
	});

	it('applies offset', () => {
		const parsed = parse_lrc('[offset:+500]\n[00:02.00]x', 'LINE');
		expect(parsed.lines[0].start_ms).toBe(1500);
	});

	it('fails without timed lines', () => {
		expect(try_parse_lyrics('LRC', 'LINE', 'just text').ok).toBe(false);
	});
});

describe('Musixmatch richsync', () => {
	it('parses words relative to the line start and attaches spaces', () => {
		const raw = JSON.stringify([{ ts: 10, te: 12, x: 'Hi there', l: [{ c: 'Hi', o: 0 }, { c: ' ', o: 0.4 }, { c: 'there', o: 0.5 }] }]);
		const parsed = parse_lyrics('MXM_RICHSYNC_JSON', 'WORD', raw);
		expect(parsed.lines[0]).toMatchObject({ text: 'Hi there', start_ms: 10000, end_ms: 12000 });
		expect(parsed.lines[0].segments).toEqual([
			{ text: 'Hi ', start_ms: 10000, end_ms: 10500 },
			{ text: 'there', start_ms: 10500, end_ms: 12000 }
		]);
	});

	it('rejects non-richsync JSON', () => {
		expect(try_parse_lyrics('MXM_RICHSYNC_JSON', 'WORD', '{"a":1}').ok).toBe(false);
		expect(try_parse_lyrics('MXM_RICHSYNC_JSON', 'WORD', 'nope').ok).toBe(false);
	});
});

describe('plain, Genius and YouTube Music', () => {
	it('parses plain text, trimming blank edges', () => {
		const parsed = parse_lyrics('PLAIN', 'NONE', '\n\nA\r\n\nB\n\n');
		expect(parsed.lines.map(l => l.text)).toEqual(['A', '', 'B']);
		expect(try_parse_lyrics('PLAIN', 'NONE', '   \n ').ok).toBe(false);
	});

	it('parses a Genius body via lib-origin', () => {
		const body = { tag: 'root', children: [{ tag: 'p', children: ['[Verse]', { tag: 'br' }, 'Line ', { tag: 'a', children: ['one'] }] }] };
		const parsed = parse_lyrics('GENIUS_BODY_JSON', 'NONE', JSON.stringify(body));
		expect(parsed.lines.map(l => l.text)).toEqual(['[Verse]', 'Line one']);
		expect(try_parse_lyrics('GENIUS_BODY_JSON', 'NONE', JSON.stringify({ tag: 'root' })).ok).toBe(false);
	});

	it('parses YouTube Music timed lines', () => {
		const raw = JSON.stringify({ timedLyricsData: [
			{ lyricLine: 'One', cueRange: { startTimeMilliseconds: '1000', endTimeMilliseconds: '2000' } },
			{ lyricLine: 'Two', cueRange: { startTimeMilliseconds: '2000' } }
		] });
		const parsed = parse_lyrics('YTM_JSON', 'LINE', raw);
		expect(parsed.sync_type).toBe('LINE');
		expect(parsed.lines.map(l => [l.text, l.start_ms, l.end_ms])).toEqual([['One', 1000, 2000], ['Two', 2000, null]]);
	});

	it('parses YouTube Music plain payloads (runs)', () => {
		const raw = JSON.stringify({ description: { runs: [{ text: 'A\nB' }] } });
		expect(parse_lyrics('YTM_JSON', 'NONE', raw).lines.map(l => l.text)).toEqual(['A', 'B']);
	});
});

describe('parse gaps', () => {
	it('shifts word segments by the LRC offset', () => {
		const parsed = parse_lrc('[offset:500]\n[00:02.00]<00:02.00>Hello <00:03.00>there', 'WORD');
		const line = parsed.lines[0];
		expect(line.start_ms).toBe(1500);
		expect(line.segments?.[0].start_ms).toBe(1500);
		expect(line.segments?.[1].start_ms).toBe(2500);
	});
	it('builds richsync line text from its words when no text is given', () => {
		const parsed = parse_richsync(JSON.stringify([{ ts: 1, te: 3, l: [{ c: 'Hi', o: 0 }, { c: ' ', o: 0.5 }, { c: 'you', o: 1 }] }]));
		expect(parsed.lines[0].text).toBe('Hi you');
	});
	it('finds no plain text in an object without lyrics keys', () => {
		expect(find_ytm_plain_text({ other: 1 })).toBeNull();
	});
});
