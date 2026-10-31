import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
	request_id: string;
	/** Read lazily: authentication runs after the context is created. */
	user_id: () => string | undefined;
	/** Set by `require_admin`: the rest of the request runs as the table owner instead of under row-level security. */
	privileged?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function run_in_context<T>(context: RequestContext, fn: () => T): T {
	return storage.run(context, fn);
}

/** The request being handled, if any (undefined in background jobs and at startup). */
export function current_context(): RequestContext | undefined {
	return storage.getStore();
}
