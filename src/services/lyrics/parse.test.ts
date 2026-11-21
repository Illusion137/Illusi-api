import { describe, expect, it } from 'vitest';
import { find_ytm_plain_text, parse_lrc, parse_lyrics, try_parse_lyrics } from './parse';

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

	it('splits background vocals off the line and skips translations', () => {
		const ttml = '<tt itunes:timing="Word"><body><div><p begin="0:01.000" end="0:04.500"><span begin="0:01.000" end="0:02.000">Hello</span> <span ttm:role="x-bg" begin="0:02.500" end="0:04.400"><span begin="0:02.500" end="0:03.000">(oh</span> <span begin="0:03.100" end="0:04.400">yeah)</span></span><span ttm:role="x-translation">Hola</span></p></div></body></tt>';
		const [line] = parse_lyrics('TTML', 'WORD', ttml).lines;
		expect(line.text).toBe('Hello');
		expect(line.segments).toEqual([{ text: 'Hello ', start_ms: 1000, end_ms: 2000 }]);
		expect(line.background).toEqual({
			text: '(oh yeah)',
			start_ms: 2500,
			end_ms: 4400,
			segments: [
				{ text: '(oh ', start_ms: 2500, end_ms: 3000 },
				{ text: 'yeah)', start_ms: 3100, end_ms: 4400 }
			]
		});
		expect(parse_lyrics('TTML', 'LINE', ttml).lines[0].background).toEqual({ text: '(oh yeah)', start_ms: 2500, end_ms: 4400 });
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

describe('QQ Music QRC', () => {
	const qrc = (content: string) => `<?xml version="1.0" encoding="utf-8"?>\n<QrcInfos>\n<LyricInfo LyricCount="1">\n<Lyric_1 LyricType="1" LyricContent="${content}"/>\n</LyricInfo>\n</QrcInfos>`;

	it('parses absolute word times, joins timed spaces and drops the credits', () => {
		const parsed = parse_lyrics('QRC', 'WORD', qrc([
			'[ti:Song]',
			'[0,1756]Song (0,439)- (439,439)Artist(878,439)',
			'[1757,1000]Lyrics (1757,500)by：(2257,500)Someone(2757,0)',
			'[3000,1200]Hi(3000,400) (3400,100)&amp;(3500,200) (3700,100)(bye)(3800,400)'
		].join('\n')));
		expect(parsed.sync_type).toBe('WORD');
		expect(parsed.lines).toHaveLength(1);
		expect(parsed.lines[0]).toMatchObject({ text: 'Hi & (bye)', start_ms: 3000, end_ms: 4200 });
		expect(parsed.lines[0].segments).toEqual([
			{ text: 'Hi ', start_ms: 3000, end_ms: 3400 },
			{ text: '& ', start_ms: 3500, end_ms: 3700 },
			{ text: '(bye)', start_ms: 3800, end_ms: 4200 }
		]);
	});

	it('fails without LyricContent or timed lines', () => {
		expect(try_parse_lyrics('QRC', 'WORD', '<QrcInfos/>').ok).toBe(false);
		expect(try_parse_lyrics('QRC', 'WORD', qrc('[ti:x]')).ok).toBe(false);
	});
});

describe('KuGou KRC', () => {
	it('parses word offsets relative to the line and skips tags and credits', () => {
		const parsed = parse_lyrics('KRC', 'WORD', [
			'[ti:Song]',
			'[language:eyJjb250ZW50IjpbXX0=]',
			'[0,2000]<0,1000,0>Song - <1000,1000,0>Artist',
			'[2000,1000]<0,500,0>作词：<500,500,0>某人',
			'[5000,1500]<0,500,0>Hello <500,1000,0>world'
		].join('\r\n'));
		expect(parsed.lines).toEqual([{
			text: 'Hello world', start_ms: 5000, end_ms: 6500,
			segments: [{ text: 'Hello ', start_ms: 5000, end_ms: 5500 }, { text: 'world', start_ms: 5500, end_ms: 6500 }]
		}]);
	});

	it('keeps a lone title-like line when it is the only lyric', () => {
		expect(parse_lyrics('KRC', 'WORD', '[0,1000]<0,1000,0>A - B').lines.map(l => l.text)).toEqual(['A - B']);
	});
});

describe('Unison', () => {
	it('parses the stored lyrics by their own format', () => {
		const row = (format: string, lyrics: string) => JSON.stringify({ id: 1, videoId: 'v', format, syncType: 'x', submitter: null, lyrics });
		expect(parse_lyrics('UNISON_JSON', 'LINE', row('lrc', '[00:01.00]Hi')).lines[0]).toMatchObject({ text: 'Hi', start_ms: 1000 });
		expect(parse_lyrics('UNISON_JSON', 'NONE', row('plain', 'Hi\nthere')).lines.map(l => l.text)).toEqual(['Hi', 'there']);
		expect(try_parse_lyrics('UNISON_JSON', 'NONE', row('srt', 'x')).ok).toBe(false);
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
	it('keeps a KRC line without word tags as one line', () => {
		expect(parse_lyrics('KRC', 'WORD', '[1000,2000]Hi you').lines[0]).toMatchObject({ text: 'Hi you', start_ms: 1000, end_ms: 3000 });
		expect(parse_lyrics('KRC', 'WORD', '[1000,2000]Hi you').sync_type).toBe('LINE');
	});
	it('finds no plain text in an object without lyrics keys', () => {
		expect(find_ytm_plain_text({ other: 1 })).toBeNull();
	});
});
