import type { PlaylistInheritanceMode, SortType } from '@illusive/types';
import type { inheritance_mode, sort_type } from '../../db/schema';

type DbSortType = typeof sort_type.enumValues[number];
type DbInheritanceMode = typeof inheritance_mode.enumValues[number];

/** DB enum → lib-origin value. Keyed by the DB enum so adding a value on either side fails to compile. */
const SORT_TYPE_MAP: Record<DbSortType, SortType> = {
	ALPHABETICAL: 'ALPHABETICAL',
	ALPHABETICAL_REVERSE: 'ALPHABETICAL_REVERSE',
	NEWEST: 'NEWEST',
	OLDEST: 'OLDEST',
	DURATION_HILOW: 'DURATION_HILOW',
	DURATION_LOWHI: 'DURATION_LOWHI',
	PLAYS_HILOW: 'PLAYS_HILOW',
	PLAYS_LOWHI: 'PLAYS_LOWHI',
	VIEWS_HILOW: 'VIEWS_HILOW',
	VIEWS_LOWHI: 'VIEWS_LOWHI',
	ADDED_DATE_HILOW: 'ADDED_DATE_HILOW',
	ADDED_DATE_LOWHI: 'ADDED_DATE_LOWHI',
	DOWNLOAD_DATE_HILOW: 'DOWNLOAD_DATE_HILOW',
	DOWNLOAD_DATE_LOWHI: 'DOWNLOAD_DATE_LOWHI',
	LAST_PLAYED_DATE_HILOW: 'LAST_PLAYED_DATE_HILOW',
	LAST_PLAYED_DATE_LOWHI: 'LAST_PLAYED_DATE_LOWHI',
	LAST_SAMPLED_DATE_HILOW: 'LAST_SAMPLED_DATE_HILOW',
	LAST_SAMPLED_DATE_LOWHI: 'LAST_SAMPLED_DATE_LOWHI',
	LONGEST_PLAYED_HILOW: 'LONGEST_PLAYED_HILOW',
	LONGEST_PLAYED_LOWHI: 'LONGEST_PLAYED_LOWHI'
};

const INHERITANCE_MODE_MAP: Record<DbInheritanceMode, PlaylistInheritanceMode> = {
	INCLUDE: 'INCLUDE',
	EXCLUDE: 'EXCLUDE',
	MASK: 'MASK',
	INTERSECTION: 'INTERSECTION'
};

export function to_sort_type(value: DbSortType): SortType {
	return SORT_TYPE_MAP[value];
}

/**
 * `mode` is nullable in the DB. A null mode is returned as undefined and the row is skipped, which is what the
 * client does with an unknown mode (`apply_inherited_mode` leaves the tracks unchanged).
 */
export function to_inheritance_mode(value: DbInheritanceMode | null): PlaylistInheritanceMode | undefined {
	return value === null ? undefined : INHERITANCE_MODE_MAP[value];
}
