import { isIPv4, isIPv6 } from 'node:net';

/** The eight hextets of an IPv6 address, `::` expanded. */
function hextets(ip: string): string[] {
	const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const fill = tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
	return [...left, ...fill, ...right].map(h => (h === '' ? '0' : h.toLowerCase().replace(/^0+(?=.)/u, '')));
}

/**
 * The network an address belongs to, as one household or provider block sees it: the /24 of an IPv4 address and the
 * /48 of an IPv6 one (IPv4-mapped IPv6 counts as IPv4). Null for anything that isn't an IP address.
 */
export function ip_prefix(ip: string | undefined): string | null {
	if (!ip) return null;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(ip);
	const v4 = mapped ? mapped[1] : ip;
	if (isIPv4(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
	if (isIPv6(ip)) return `${hextets(ip.split('%')[0]).slice(0, 3).join(':')}::/48`;
	return null;
}
