/**
 * In-memory FIFO keyed by track id. A key stays "held" from `push` until `release`, so a
 * track that's queued or running is never queued twice. `push_front` re-queues a held job (retry).
 */
export class JobQueue<T> {
	private items: T[] = [];
	private held = new Set<string>();
	private waiters: ((item: T | null) => void)[] = [];
	private closed = false;

	constructor(private readonly key_of: (item: T) => string) {}

	get size() { return this.items.length; }
	get held_count() { return this.held.size; }

	has(key: string) { return this.held.has(key); }

	/** Adds to the back. Returns false if the key is already queued/running or the queue is closed. */
	push(item: T): boolean {
		const key = this.key_of(item);
		if (this.closed || this.held.has(key)) return false;
		this.held.add(key);
		this.deliver(item, false);
		return true;
	}

	/** Puts a job that is still held back at the front (retrying the same job). */
	push_front(item: T): void {
		if (this.closed) {
			this.held.delete(this.key_of(item));
			return;
		}
		this.held.add(this.key_of(item));
		this.deliver(item, true);
	}

	release(key: string): void {
		this.held.delete(key);
	}

	/** Next job, waiting if empty. Resolves null once closed. */
	next(): Promise<T | null> {
		if (this.closed) return Promise.resolve(null);
		const item = this.items.shift();
		if (item !== undefined) return Promise.resolve(item);
		return new Promise(resolve => this.waiters.push(resolve));
	}

	/** Stops handing out jobs and wakes every waiter with null. Queued jobs are dropped. */
	close(): void {
		this.closed = true;
		for (const item of this.items) this.held.delete(this.key_of(item));
		this.items = [];
		for (const waiter of this.waiters.splice(0)) waiter(null);
	}

	reopen(): void {
		this.closed = false;
	}

	private deliver(item: T, front: boolean) {
		const waiter = this.waiters.shift();
		if (waiter) waiter(item);
		else if (front) this.items.unshift(item);
		else this.items.push(item);
	}
}
