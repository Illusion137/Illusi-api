/**
 * In-memory priority queue keyed by track id: `compare` orders jobs (negative = sooner), ties go first in, first out.
 * Without `compare` it is a plain FIFO. A key stays "held" from `push` until `release`, so a track that's queued or
 * running is never queued twice. `push_front` re-queues a held job (retry) ahead of everything else.
 */
export class JobQueue<T> {
	private heap: { item: T; seq: number }[] = [];
	private retries: T[] = [];
	private seq = 0;
	private held = new Set<string>();
	private waiters: ((item: T | null) => void)[] = [];
	private closed = false;

	constructor(private readonly key_of: (item: T) => string, private readonly compare: (a: T, b: T) => number = () => 0) {}

	get size() { return this.heap.length + this.retries.length; }
	get held_count() { return this.held.size; }

	has(key: string) { return this.held.has(key); }

	/** Adds by priority. Returns false if the key is already queued/running or the queue is closed. */
	push(item: T): boolean {
		const key = this.key_of(item);
		if (this.closed || this.held.has(key)) return false;
		this.held.add(key);
		const waiter = this.waiters.shift();
		if (waiter) waiter(item);
		else this.heap_push(item);
		return true;
	}

	/** Puts a job that is still held back at the front (retrying the same job). */
	push_front(item: T): void {
		if (this.closed) {
			this.held.delete(this.key_of(item));
			return;
		}
		this.held.add(this.key_of(item));
		const waiter = this.waiters.shift();
		if (waiter) waiter(item);
		else this.retries.unshift(item);
	}

	release(key: string): void {
		this.held.delete(key);
	}

	/** Next job, waiting if empty. Resolves null once closed. */
	next(): Promise<T | null> {
		if (this.closed) return Promise.resolve(null);
		const item = this.retries.shift() ?? this.heap_pop();
		if (item !== undefined) return Promise.resolve(item);
		return new Promise(resolve => this.waiters.push(resolve));
	}

	/** Stops handing out jobs and wakes every waiter with null. Queued jobs are dropped. */
	close(): void {
		this.closed = true;
		for (const { item } of this.heap) this.held.delete(this.key_of(item));
		for (const item of this.retries) this.held.delete(this.key_of(item));
		this.heap = [];
		this.retries = [];
		for (const waiter of this.waiters.splice(0)) waiter(null);
	}

	reopen(): void {
		this.closed = false;
	}

	private before(a: number, b: number): boolean {
		const order = this.compare(this.heap[a].item, this.heap[b].item);
		return order < 0 || (order === 0 && this.heap[a].seq < this.heap[b].seq);
	}

	private swap(a: number, b: number) {
		[this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
	}

	private heap_push(item: T) {
		this.heap.push({ item, seq: this.seq++ });
		for (let i = this.heap.length - 1; i > 0;) {
			const parent = (i - 1) >> 1;
			if (!this.before(i, parent)) break;
			this.swap(i, parent);
			i = parent;
		}
	}

	private heap_pop(): T | undefined {
		if (this.heap.length === 0) return undefined;
		const top = this.heap[0].item;
		const last = this.heap.pop()!;
		if (this.heap.length > 0) {
			this.heap[0] = last;
			for (let i = 0; ;) {
				const left = 2 * i + 1;
				const right = left + 1;
				let first = i;
				if (left < this.heap.length && this.before(left, first)) first = left;
				if (right < this.heap.length && this.before(right, first)) first = right;
				if (first === i) break;
				this.swap(i, first);
				i = first;
			}
		}
		return top;
	}
}
