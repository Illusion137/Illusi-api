/**
 * Field conflicts that need no reviewer: the same name written two ways, where one way is plainly the cleaner one.
 * `apply` writes the proposed value, `ignore` keeps the stored one silently, `review` leaves it for an admin.
 */
import { normalize_name, strip_decorations } from '../../core/normalize';
import { strip_artist_prefix } from './fields';

export type Settlement = 'apply' | 'ignore' | 'review';

const AUDIO_EXTENSION_RE = /\.(?:mp3|m4a|wav|flac|aac|ogg|opus)$/iu;

/** `Just_Fine_prod_Quazers (1)`, `Bout my money (louder).mp3`: a file name, never a better title. */
function file_name_like(title: string): boolean {
	if (AUDIO_EXTENSION_RE.test(title.trim())) return true;
	const base = title.replace(/\s*\(\d+\)$/u, '');
	return base.includes('_') && !/\s/u.test(base);
}

/** Control and invisible format characters (`Trippie Redd\u007f`), which no name means to have. */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;

/** A name's letters and digits only: `PierreBourne` and `Pi'erre Bourne` are the same name spaced differently. */
const compact = (name: string) => normalize_name(name).replace(/[^\p{L}\p{N}]/gu, '');
const separators = (name: string) => name.replace(/[\p{L}\p{N}]/gu, '').length;

/** `Chief Keef "Faneto"`: an artist named before the quoted song. */
function strip_quoted_title(title: string, artists: readonly string[]): string {
	const m = /^(.+?)\s+["“](.+?)["”]\s*$/u.exec(title);
	if (!m || artists.length === 0) return title;
	return strip_artist_prefix(`${m[1]} - ${m[2]}`, artists) === m[2] ? m[2] : title;
}

/** The song's title without how an upload dresses it up, and how many dressings came off. */
export function clean_title(title: string, artists: readonly string[]): { text: string; removed: number } {
	let removed = 0;
	let text = title.trim();
	const visible = text.replace(INVISIBLE_RE, '').trim();
	if (visible !== text) { text = visible; removed++; }
	const unquoted = strip_quoted_title(text, artists);
	if (unquoted !== text) { text = unquoted; removed++; }
	const unprefixed = strip_artist_prefix(text, artists);
	if (unprefixed !== text) { text = unprefixed; removed++; }
	const undecorated = strip_decorations(text);
	return { text: undecorated.text, removed: removed + undecorated.removed };
}

/**
 * Two titles of one track that are the same song once uploads' dressing is removed (`Artist - `, `(Official
 * Video)`, `[prod. X]`, `(Full Audio)`, `(unreleased)`, quotes around the title): the plainer one is kept, so a
 * plainer proposal is applied and a fancier one ignored. A file name is never applied. Anything else is reviewed.
 */
export function settle_title(current: string, proposed: string, artists: readonly string[]): Settlement {
	if (file_name_like(proposed)) return 'ignore';
	const c = clean_title(current, artists);
	const p = clean_title(proposed, artists);
	if (normalize_name(c.text) !== normalize_name(p.text) || normalize_name(c.text) === '') return 'review';
	return p.removed < c.removed ? 'apply' : 'ignore';
}

/** `Name (@handle)`, `Name @handle`, `Name Official`, `Official Name`, `Name - Topic`: account names, not artist names. */
const ARTIST_DECORATIONS: readonly RegExp[] = [
	/\s*[([]\s*@[^)\]]*[)\]]/gu,
	/\s+@[\w.]+$/u,
	/\s+-\s+topic$/iu,
	/\s+official$/iu,
	/^official\s+/iu
];

export function clean_artist_name(name: string): { text: string; removed: number } {
	let text = name.trim();
	let removed = 0;
	const visible = text.replace(INVISIBLE_RE, '').trim();
	if (visible !== text && visible !== '') { text = visible; removed++; }
	for (const re of ARTIST_DECORATIONS) {
		const next = text.replace(re, '').trim();
		if (next !== text && next !== '') { text = next; removed++; }
	}
	return { text, removed };
}

/** A joint credit (`A & B`, `A, B & C`, `A x B`, `A feat. B`, `A with B`) as its artists; null for one artist. */
export function credit_parts(name: string): string[] | null {
	if (!/\s(?:&|x|feat\.?|ft\.?|featuring|with)\s|,.*\sand\s/iu.test(name)) return null;
	const parts = name.split(/\s*(?:,\s*(?:&|and)\s+|,|\s&\s|\sx\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\swith\s|\sand\s)\s*/iu).map(p => p.trim()).filter(Boolean);
	return parts.length >= 2 ? parts : null;
}

const same = (a: string, b: string) => normalize_name(a) !== '' && normalize_name(a) === normalize_name(b);

/**
 * An artist's name against a proposed one:
 * - the same once account dressing is removed (`kaisani (@kaisanii)`, `Lil Tony Official`): the plainer one wins;
 * - a joint credit naming the artist (`Young Thug & Travis Scott` for `Young Thug`): a song's credit, ignored;
 * - the stored name is a joint credit led by the proposed artist (`Tory Lanez & Trippie Redd`, then `Tory Lanez`):
 *   the artist was created from a song's credit, so their own name is applied.
 * Anything else (a rename, a different artist) is reviewed.
 */
export function settle_artist_name(current: string, proposed: string): Settlement {
	const c = clean_artist_name(current);
	const p = clean_artist_name(proposed);
	if (same(c.text, p.text)) return p.removed < c.removed ? 'apply' : 'ignore';
	// Spaced or punctuated differently: the stylized way (`Pi'erre Bourne` over `PierreBourne`) is the artist's own
	if (compact(c.text) !== '' && compact(c.text) === compact(p.text)) return separators(p.text) > separators(c.text) ? 'apply' : 'ignore';
	const proposed_parts = credit_parts(proposed);
	if (proposed_parts?.some(part => same(part, c.text))) return 'ignore';
	const current_parts = credit_parts(current);
	if (current_parts && !proposed_parts && same(current_parts[0], p.text)) return 'apply';
	return 'review';
}
