import { statfs } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { logger } from './log';

const log = logger('disk');
const GB = 1024 ** 3;
const CHECK_INTERVAL_MS = 5 * 60_000;
/** A low-space error is re-sent at most this often per process while the disk stays low. */
const ALERT_EVERY_MS = 6 * 60 * 60_000;

/** Free bytes for unprivileged writers on the filesystem holding MEDIA_DIR (media, artwork, Postgres share it). */
export async function free_bytes(dir = config.MEDIA_DIR): Promise<number> {
	const stats = await statfs(dir);
	return stats.bavail * stats.bsize;
}

let last_alert = 0;
let refusing = false;

function gb(bytes: number): number {
	return Math.round(bytes / GB * 10) / 10;
}

async function check() {
	let free: number;
	try {
		free = await free_bytes();
	} catch (err) {
		log.warn('could not read free disk space', err);
		return;
	}
	if (free >= config.DISK_WARN_FREE_GB * GB) {
		if (last_alert !== 0) log.info(`disk space recovered: ${gb(free)} GB free`);
		last_alert = 0;
		return;
	}
	if (Date.now() - last_alert < ALERT_EVERY_MS) return;
	last_alert = Date.now();
	const refusing_now = free < config.DISK_MIN_FREE_GB * GB;
	log.error(refusing_now ? 'disk full: file uploads are refused' : 'disk space low: upgrade storage soon', {
		free_gb: gb(free),
		warn_below_gb: config.DISK_WARN_FREE_GB,
		uploads_refused_below_gb: config.DISK_MIN_FREE_GB,
		path: config.MEDIA_DIR
	});
}

/** Checks free space every few minutes; below DISK_WARN_FREE_GB it reports an error (to Sentry). */
export function start_disk_monitor(): () => void {
	void check();
	const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/**
 * Middleware for every route that stores a file: below DISK_MIN_FREE_GB free it answers 507 before reading the body,
 * so the remaining space stays for the database. Requests that only write rows are never affected.
 */
export async function require_disk_space(_req: Request, res: Response, next: NextFunction) {
	let free: number;
	try {
		free = await free_bytes();
	} catch (err) {
		// Can't tell: let the upload through rather than fail every one on a stat error.
		log.warn('could not read free disk space', err);
		next();
		return;
	}
	const ok = free >= config.DISK_MIN_FREE_GB * GB;
	if (ok !== !refusing) {
		refusing = !ok;
		if (refusing) log.error('disk full: refusing file uploads', { free_gb: gb(free), min_free_gb: config.DISK_MIN_FREE_GB });
		else log.info(`disk space back above ${config.DISK_MIN_FREE_GB} GB: accepting file uploads`);
	}
	if (ok) {
		next();
		return;
	}
	// Answered here rather than thrown: the transition above is the one error worth reporting, not every refusal.
	// The body is never read; closing the connection stops the client from sending the rest of it.
	res.setHeader('Connection', 'close');
	res.status(507).json({ error: 'server storage is full; try again later' });
}
