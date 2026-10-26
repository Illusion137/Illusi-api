/** Shared-data write rules: empty fields are filled (first write wins), differing values are flagged, never applied. */
import { DURATION_TOLERANCE_MS, normalize_name } from '../../core/normalize';

/** How two values of a field are compared. `name` ignores case/punctuation, `duration` allows the ±3 s tolerance. */
export type FieldKind = 'name' | 'text' | 'number' | 'duration' | 'date' | 'bool' | 'enum' | 'id';
export type FieldSpec<T> = { [K in keyof T]?: FieldKind };

export interface FieldConflict { field: string; current: unknown; proposed: unknown }

const as_time = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(v as string).getTime());

export function values_equal(kind: FieldKind, a: unknown, b: unknown): boolean {
	switch (kind) {
		case 'name': return normalize_name(String(a)) === normalize_name(String(b));
		case 'text': return String(a).trim() === String(b).trim();
		case 'duration': return Math.abs(Number(a) - Number(b)) <= DURATION_TOLERANCE_MS;
		case 'date': return as_time(a) === as_time(b);
		case 'number':
		case 'bool':
		case 'enum':
		case 'id':
			return a === b;
	}
}

/**
 * Compares an incoming entity against the stored row. Missing incoming values never null anything out.
 * `existing = null` (a new row) fills everything provided.
 */
export function resolve_shared_fields<T extends Record<string, unknown>>(spec: FieldSpec<T>, existing: Partial<T> | null, incoming: Partial<T>): { fill: Partial<T>; conflicts: FieldConflict[] } {
	const fill: Partial<T> = {};
	const conflicts: FieldConflict[] = [];
	for (const field of Object.keys(spec) as (keyof T & string)[]) {
		const kind = spec[field]!;
		const proposed = incoming[field];
		if (proposed == null) continue;
		const current = existing?.[field];
		if (current == null) {
			fill[field] = proposed;
			continue;
		}
		if (!values_equal(kind, current, proposed)) conflicts.push({ field, current, proposed });
	}
	return { fill, conflicts };
}
