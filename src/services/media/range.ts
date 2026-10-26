export type RangeResult
	= | { type: 'full' }
		| { type: 'partial'; start: number; end: number }
		| { type: 'unsatisfiable' };

const SINGLE_RANGE_RE = /^bytes=(\d*)-(\d*)$/u;

/**
 * Parses an HTTP `Range` header for a resource of `size` bytes. Only single byte ranges are served;
 * multiple ranges and malformed headers fall back to the full body, which the RFC allows.
 */
export function parse_range(header: string | undefined, size: number): RangeResult {
	if (header === undefined) return { type: 'full' };
	const match = SINGLE_RANGE_RE.exec(header.trim());
	if (!match) return { type: 'full' };
	const [, first, last] = match;
	if (first === '' && last === '') return { type: 'full' };

	if (first === '') {
		const suffix = Number(last);
		if (suffix === 0 || size === 0) return { type: 'unsatisfiable' };
		return { type: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	if (start >= size) return { type: 'unsatisfiable' };
	if (last === '') return { type: 'partial', start, end: size - 1 };
	const end = Number(last);
	if (end < start) return { type: 'full' };
	return { type: 'partial', start, end: Math.min(end, size - 1) };
}
