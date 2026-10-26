import path from 'node:path';
import type { AudioExt } from './sniff';
import { MIME_BY_EXT } from './sniff';

const RESOURCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]{2,5})$/u;

/** The extension of a well-formed `<uuid>.<ext>` resource id, or null. Rejects anything that could escape MEDIA_DIR. */
export function resource_ext(resource_id: string): AudioExt | null {
	const match = RESOURCE_ID_RE.exec(resource_id);
	if (!match) return null;
	const ext = match[1];
	return ext in MIME_BY_EXT ? ext as AudioExt : null;
}

export function is_valid_resource_id(resource_id: string): boolean {
	return resource_ext(resource_id) !== null;
}

/** Absolute path of a resource inside `media_dir`, or null if the id is invalid or would resolve outside it. */
export function resource_path(media_dir: string, resource_id: string): string | null {
	if (!is_valid_resource_id(resource_id)) return null;
	const root = path.resolve(media_dir);
	const full = path.resolve(root, resource_id);
	return path.dirname(full) === root ? full : null;
}
