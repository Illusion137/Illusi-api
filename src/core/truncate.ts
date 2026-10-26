import { getColumns } from 'drizzle-orm';
import type { Table } from 'drizzle-orm';
import { logger } from './log';

const log = logger('truncate');

/**
 * Truncates string values longer than their `varchar(n)` column and logs it, instead of rejecting
 * the row. Keys are the table's TS column keys.
 */
export function truncate_to_columns<T extends Record<string, unknown>>(table: Table, values: T, context?: string): T {
	const columns = getColumns(table) as Record<string, { length?: number; getSQLType(): string } | undefined>;
	const out: Record<string, unknown> = { ...values };
	for (const [key, value] of Object.entries(values)) {
		if (typeof value !== 'string') continue;
		const column = columns[key];
		const length = column?.length;
		if (!column || !length || !column.getSQLType().startsWith('varchar')) continue;
		const chars = Array.from(value);
		if (chars.length > length) {
			out[key] = chars.slice(0, length).join('');
			log.warn(`truncated ${key} from ${chars.length} to ${length}`, context);
		}
	}
	return out as T;
}
