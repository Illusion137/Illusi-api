import { describe, expect, it } from 'vitest';
import { current_context, run_in_context } from './context';

describe('request context', () => {
	it('is undefined outside a run', () => {
		expect(current_context()).toBeUndefined();
	});

	it('is visible across awaits and returns the callback result', async () => {
		const context = { request_id: 'r1', user_id: () => 'u1' };
		const seen = await run_in_context(context, async () => {
			await new Promise(resolve => setTimeout(resolve, 1));
			return current_context();
		});
		expect(seen).toBe(context);
	});

	it('isolates concurrent runs and nests', async () => {
		const ids = await Promise.all(['a', 'b'].map(async id => run_in_context({ request_id: id, user_id: () => undefined }, async () => {
			await new Promise(resolve => setTimeout(resolve, id === 'a' ? 5 : 1));
			return current_context()?.request_id;
		})));
		expect(ids).toEqual(['a', 'b']);
		run_in_context({ request_id: 'outer', user_id: () => undefined }, () => {
			run_in_context({ request_id: 'inner', user_id: () => undefined }, () => { expect(current_context()?.request_id).toBe('inner'); });
			expect(current_context()?.request_id).toBe('outer');
		});
	});
});
