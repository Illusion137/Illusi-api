import { describe, expect, it } from 'vitest';
import { credit_parts, settle_artist_name, settle_title } from './settle';

describe('settle_title', () => {
	it('applies a plainer title of the same song and ignores a fancier one', () => {
		expect(settle_title('Fantasy (Official 4K Video)', 'Fantasy', [])).toBe('apply');
		expect(settle_title('StanWill x BabyTron - Last Forever', 'Last Forever (feat. BabyTron)', ['StanWill', 'BabyTron'])).toBe('apply');
		expect(settle_title('Chief Keef "Faneto"', 'Faneto', ['Chief Keef'])).toBe('apply');
		expect(settle_title('jaydes - peach crush (unreleased)', 'jaydes - peach crush', ['jaydes'])).toBe('apply');
		expect(settle_title('MIND OF DA CROOK', 'MIND OF DA CROOK [p. SPARKHEEM]', [])).toBe('ignore');
		expect(settle_title('BabyTron - Klarna', 'BabyTron - Klarna (Official Video)', ['BabyTron'])).toBe('ignore');
	});
	it('never applies a file name', () => {
		expect(settle_title('Just Fine (prod.Quazers)', 'Just_Fine_prod_Quazers (1)', [])).toBe('ignore');
	});
	it('reviews different titles', () => {
		expect(settle_title('What\'s What', 'Doves to Vultures (Ywn Anthem)', [])).toBe('review');
		expect(settle_title('Lil Tony - Zelda Freestyle (Full Audio)', 'Zelda', ['Lil Tony'])).toBe('review');
	});
});

describe('settle_artist_name', () => {
	it('ignores a song\'s joint credit that names the artist', () => {
		expect(settle_artist_name('Young Thug', 'Young Thug & Travis Scott')).toBe('ignore');
		expect(settle_artist_name('yungfuego', 'yungfuego, angst!, Salako, and Pr0d.k4y')).toBe('ignore');
	});
	it('applies the leading artist\'s own name over a joint credit', () => {
		expect(settle_artist_name('Tory Lanez & Trippie Redd', 'Tory Lanez')).toBe('apply');
		expect(settle_artist_name('JACKBOYS, Pop Smoke & Travis Scott', 'Travis Scott')).toBe('review');
	});
	it('prefers the name without account dressing', () => {
		expect(settle_artist_name('kaisani (@kaisanii)', 'kaisani')).toBe('apply');
		expect(settle_artist_name('Lil Tony Official', 'Lil Tony')).toBe('apply');
		expect(settle_artist_name('Your Stepdad (@a)', 'Your Stepdad (@b)')).toBe('ignore');
	});
	it('reviews renames and different artists', () => {
		expect(settle_artist_name('Jace!', 'Iayze')).toBe('review');
		expect(settle_artist_name('Concrete Family', 'Concrete Boys, Lil Yachty & KARRAHBOOO')).toBe('review');
		expect(settle_artist_name('Tyler, The Creator', 'Tyler')).toBe('review');
	});
	it('splits joint credits only', () => {
		expect(credit_parts('A, B & C')).toEqual(['A', 'B', 'C']);
		expect(credit_parts('A, B, and C')).toEqual(['A', 'B', 'C']);
		expect(credit_parts('A, B, & C')).toEqual(['A', 'B', 'C']);
		expect(credit_parts('Tyler, The Creator')).toBeNull();
	});
});
