import { describe, expect, it } from 'vitest';
import { parse_notification } from './events';

describe('parse_notification', () => {
	it('parses other processes\' events and defaults the payload', () => {
		expect(parse_notification('{"name":"user_library_changed","payload":{"user_id":"u"},"origin":"other"}', 'me'))
			.toEqual({ name: 'user_library_changed', payload: { user_id: 'u' } });
		// Sent by the redirects trigger: no origin, empty payload.
		expect(parse_notification('{"name":"ids_redirected","payload":{}}', 'me')).toEqual({ name: 'ids_redirected', payload: {} });
		expect(parse_notification('{"name":"ids_redirected"}', 'me')).toEqual({ name: 'ids_redirected', payload: {} });
	});
	it('ignores its own and malformed notifications', () => {
		expect(parse_notification('{"name":"user_library_changed","payload":{},"origin":"me"}', 'me')).toBeNull();
		expect(parse_notification('not json', 'me')).toBeNull();
		expect(parse_notification('{"payload":{}}', 'me')).toBeNull();
		expect(parse_notification(undefined, 'me')).toBeNull();
	});
});
