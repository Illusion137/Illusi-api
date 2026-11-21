'use strict';

const API = '/api/v1';
const REFRESH_KEY = 'illusi_admin_refresh';

// ---- DOM ----

function h(tag, attrs, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v == null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else if (k in el && typeof v !== 'string') el[k] = v;
		else el.setAttribute(k, v === true ? '' : v);
	}
	append(el, children);
	return el;
}

function append(el, children) {
	for (const c of children.flat(Infinity)) {
		if (c == null || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
}

function replace(el, ...children) {
	el.replaceChildren();
	append(el, children);
}

function toast(message, kind = '') {
	const el = h('div', { class: `toast ${kind}` }, message);
	document.body.append(el);
	setTimeout(() => el.remove(), 4000);
}

function json(value) {
	return h('pre', null, JSON.stringify(value, null, 2));
}

function badge(text, kind = '') {
	return h('span', { class: `badge ${kind}` }, text);
}

function status_badge(ok, yes = 'ok', no = 'down') {
	return badge(ok ? yes : no, ok ? 'ok' : 'bad');
}

function kv(pairs) {
	return h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v ?? h('span', { class: 'muted' }, '—'))]));
}

function select(options, value, onchange) {
	return h('select', { onchange: e => onchange(e.target.value) },
		options.map(o => {
			const [v, label] = Array.isArray(o) ? o : [o, o];
			return h('option', { value: v, selected: v === value }, label);
		}));
}

function link_track(id, label) {
	return h('a', { href: `#/tracks/${id}` }, label ?? id);
}

function short_id(id) {
	return id ? String(id).slice(0, 8) : '';
}

// ---- Formatting ----

function ago(value) {
	if (!value) return '—';
	const s = Math.round((Date.now() - new Date(value).getTime()) / 1000);
	if (s < 0) return 'just now';
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function duration(s) {
	const d = Math.floor(s / 86400);
	const hrs = Math.floor(s % 86400 / 3600);
	const m = Math.floor(s % 3600 / 60);
	if (d > 0) return `${d}d ${hrs}h`;
	if (hrs > 0) return `${hrs}h ${m}m`;
	return `${m}m ${s % 60}s`;
}

function bytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function datetime(value) {
	if (!value) return '—';
	const d = new Date(value);
	return h('span', { title: d.toISOString() }, d.toLocaleString());
}

function ms(n) {
	if (n == null) return '—';
	const s = Math.round(n / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function preview(value) {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'string') return value;
	return JSON.stringify(value);
}

// ---- API ----

class ApiError extends Error {
	constructor(status, message, body) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

const auth = {
	access: null,
	refresh: (() => { try { return sessionStorage.getItem(REFRESH_KEY); } catch { return null; } })(),
	set(tokens) {
		this.access = tokens?.access_token ?? null;
		this.refresh = tokens?.refresh_token ?? null;
		try {
			if (this.refresh) sessionStorage.setItem(REFRESH_KEY, this.refresh);
			else sessionStorage.removeItem(REFRESH_KEY);
		} catch { /* storage unavailable: the session lasts until reload */ }
	}
};

let refreshing = null;

function refresh_tokens() {
	refreshing ??= (async () => {
		if (!auth.refresh) throw new ApiError(401, 'signed out');
		const res = await fetch(`${API}/auth/refresh`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refresh_token: auth.refresh })
		});
		if (!res.ok) {
			auth.set(null);
			throw new ApiError(401, 'session expired');
		}
		auth.set(await res.json());
	})().finally(() => { refreshing = null; });
	return refreshing;
}

async function api(method, path, body, retry = true) {
	if (!auth.access && auth.refresh) await refresh_tokens();
	const headers = {};
	if (auth.access) headers.authorization = `Bearer ${auth.access}`;
	if (body !== undefined) headers['content-type'] = 'application/json';
	const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	if (res.status === 401 && retry && auth.refresh) {
		auth.access = null;
		await refresh_tokens();
		return api(method, path, body, false);
	}
	const text = await res.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = text;
	}
	if (res.status === 401) {
		auth.set(null);
		render();
	}
	if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
	return data;
}

function qs(params) {
	const s = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
	const out = s.toString();
	return out ? `?${out}` : '';
}

/** Runs an action from a button: disables it meanwhile and reports failures. */
async function act(button, fn, success) {
	if (button) button.disabled = true;
	try {
		const result = await fn();
		if (success) toast(success);
		return result;
	} catch (err) {
		toast(err.message, 'bad');
		throw err;
	} finally {
		if (button) button.disabled = false;
	}
}

function error_view(err) {
	return h('div', { class: 'card error' }, `${err.status ? `${err.status}: ` : ''}${err.message}`);
}

// ---- Shell ----

const PAGES = [
	['status', 'Status'],
	['logs', 'Logs'],
	['review', 'Review'],
	['backpack', 'Backpack'],
	['tracks', 'Tracks'],
	['users', 'Users'],
	['tables', 'Tables'],
	['audit', 'Audit log']
];

const app = document.getElementById('app');
let me = null;
let cleanup = null;
let nav_counts = {};

async function render() {
	cleanup?.();
	cleanup = null;
	if (!auth.access && !auth.refresh) {
		me = null;
		replace(app, login_view());
		return;
	}
	if (!me) {
		try {
			me = await api('GET', '/auth/me');
			await api('GET', '/admin/status');
		} catch (err) {
			if (err.status === 403) {
				toast(err.body?.code === 'EMAIL_NOT_VERIFIED' ? 'Confirm your email address first' : 'This account is not an admin', 'bad');
				await logout();
				return;
			}
			if (!auth.refresh) {
				replace(app, login_view());
				return;
			}
			replace(app, h('main', null, error_view(err)));
			return;
		}
	}
	const [name, ...params] = location.hash.replace(/^#\/?/u, '').split('/').map(decodeURIComponent);
	const page = PAGES.some(([p]) => p === name) ? name : 'status';
	const main = h('main');
	replace(app, h('div', { class: 'layout' }, sidebar(page), main));
	cleanup = VIEWS[page](main, params.filter(Boolean)) ?? null;
}

function sidebar(active) {
	return h('nav', { class: 'sidebar' },
		h('div', { class: 'brand' }, 'Illusi Admin'),
		PAGES.map(([p, label]) => h('a', { href: `#/${p}`, class: p === active ? 'active' : '' },
			label, nav_counts[p] ? badge(String(nav_counts[p]), p === active ? '' : 'warn') : null)),
		h('div', { class: 'spacer' }),
		h('div', { class: 'who' }, me?.email ?? ''),
		h('a', { href: '#', onclick: (e) => { e.preventDefault(); void logout(); } }, 'Sign out'));
}

async function logout() {
	if (auth.access) await api('POST', '/auth/logout', undefined, false).catch(() => undefined);
	auth.set(null);
	me = null;
	render();
}

function login_view() {
	const error = h('div', { class: 'error small' });
	const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username', required: true });
	const password = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
	const submit = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
	const form = h('form', {
		onsubmit: async (e) => {
			e.preventDefault();
			submit.disabled = true;
			error.textContent = '';
			try {
				const res = await fetch(`${API}/auth/login`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: email.value, password: password.value, device_name: 'Admin dashboard' })
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(body.error ?? `sign-in failed (${res.status})`);
				auth.set(body);
				render();
			} catch (err) {
				error.textContent = err.message;
			} finally {
				submit.disabled = false;
			}
		}
	}, email, password, submit, error);
	setTimeout(() => email.focus());
	return h('div', { class: 'login' }, h('h1', null, 'Illusi Admin'), form);
}

window.addEventListener('hashchange', () => render());

/** Calls `fn` now and every `interval_ms` while the page is visible; returns a stop function. */
function poll(fn, interval_ms) {
	let timer = null;
	let stopped = false;
	const tick = async () => {
		if (stopped) return;
		if (document.visibilityState === 'visible') await fn().catch(() => undefined);
		if (!stopped) timer = setTimeout(tick, interval_ms);
	};
	void tick();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}

function pager(data, page, go) {
	if (!data.total && !data.has_more) return null;
	const pages = data.total != null ? Math.max(1, Math.ceil(data.total / data.limit)) : null;
	return h('div', { class: 'row', style: 'margin-top:12px' },
		h('button', { class: 'small', disabled: page <= 1, onclick: () => go(page - 1) }, '← Prev'),
		h('span', { class: 'muted small' }, pages ? `Page ${page} of ${pages} · ${data.total} total` : `Page ${page}`),
		h('button', { class: 'small', disabled: !data.has_more, onclick: () => go(page + 1) }, 'Next →'));
}

// ---- Status ----

function status_view(main) {
	const body = h('div', { class: 'stack' }, h('div', { class: 'empty' }, 'Loading…'));
	const updated = h('span', { class: 'muted small' });
	main.append(h('h1', null, 'System status', updated), body);
	return poll(async () => {
		try {
			const s = await api('GET', '/admin/status');
			const open_reviews = Object.values(s.queues.review).reduce((a, b) => a + b, 0);
			if (nav_counts.review !== open_reviews || nav_counts.backpack !== s.queues.backpacked_tracks) {
				nav_counts = { review: open_reviews, backpack: s.queues.backpacked_tracks };
				main.parentElement?.querySelector('nav')?.replaceWith(sidebar('status'));
			}
			replace(updated, `updated ${new Date(s.time).toLocaleTimeString()} · refreshes every 15s`);
			replace(body, status_cards(s));
		} catch (err) {
			replace(body, error_view(err));
		}
	}, 15_000);
}

function status_cards(s) {
	const p = s.process;
	const d = s.disk;
	const disk_used = d.total_gb ? (d.total_gb - d.free_gb) / d.total_gb : 0;
	const disk_class = d.uploads_refused ? 'bad' : d.ok ? '' : 'warn';
	const overall = s.database.ok && s.analyzer.ok && d.ok && !p.draining && s.leaders.every(l => l.held || l.role === 'background_services' && !p.background_services);

	return [
		h('div', { class: 'card spread' },
			h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, overall ? 'All systems operational' : 'Attention needed'), status_badge(overall, 'healthy', 'degraded')),
			h('span', { class: 'muted' }, `version ${p.version} · ${p.environment}`)),
		h('div', { class: 'grid' },
			h('div', { class: 'card' },
				h('div', { class: 'spread' }, h('h2', null, 'API process'), p.draining ? badge('draining', 'warn') : badge('serving', 'ok')),
				kv([
					['Host', h('span', { class: 'mono' }, p.host)],
					['Uptime', duration(p.uptime_s)],
					['Node', p.node],
					['Memory', `${p.memory_mb.rss} MB RSS · ${p.memory_mb.heap_used} MB heap`],
					['PID', p.pid]
				]),
				h('p', { class: 'muted small' }, 'The replica that answered this request.')),
			h('div', { class: 'card' },
				h('div', { class: 'spread' }, h('h2', null, 'Database'), status_badge(s.database.ok)),
				kv([
					['Latency', `${s.database.latency_ms} ms`],
					['Size', `${s.database.size_gb} GB`],
					['Pool', `${s.database.pool.total} open · ${s.database.pool.idle} idle · ${s.database.pool.waiting} waiting`],
					s.database.error && ['Error', h('span', { class: 'error' }, s.database.error)]
				])),
			h('div', { class: 'card' },
				h('div', { class: 'spread' }, h('h2', null, 'Analyzer'), status_badge(s.analyzer.ok, 'reachable', 'unreachable')),
				kv([['Latency', `${s.analyzer.latency_ms} ms`], ['URL', h('span', { class: 'mono' }, s.analyzer.url)]])),
			h('div', { class: 'card' },
				h('div', { class: 'spread' }, h('h2', null, 'Disk'), d.error ? badge('unknown', 'bad') : d.uploads_refused ? badge('uploads refused', 'bad') : status_badge(d.ok, 'ok', 'low')),
				d.error ? h('p', { class: 'error' }, d.error) : [
					h('div', { class: `bar ${disk_class}` }, h('div', { style: `width:${Math.round(disk_used * 100)}%` })),
					kv([
						['Free', `${d.free_gb} GB of ${d.total_gb} GB`],
						['Alert below', `${d.warn_below_gb} GB`],
						['Uploads refused below', `${d.uploads_refused_below_gb} GB`],
						['Path', h('span', { class: 'mono' }, d.path)]
					])
				])),
		h('div', { class: 'grid' },
			h('div', { class: 'card' },
				h('h2', null, 'Work queues'),
				kv([
					['Open review items', h('a', { href: '#/review' }, String(Object.values(s.queues.review).reduce((a, b) => a + b, 0)))],
					...Object.entries(s.queues.review).map(([k, n]) => [h('span', { class: 'small' }, `· ${k}`), String(n)]),
					['Service id conflicts', `${s.queues.service_id_conflicts.open ?? 0} open · ${s.queues.service_id_conflicts.deferred ?? 0} deferred`],
					['Backpacked tracks', h('a', { href: '#/backpack' }, String(s.queues.backpacked_tracks))],
					['Exports', `${s.queues.exports.PENDING ?? 0} pending · ${s.queues.exports.RUNNING ?? 0} running · ${s.queues.exports.FAILED ?? 0} failed`],
					['Users', h('a', { href: '#/users' }, `${s.queues.users.total} (${s.queues.users.unverified} unverified)`)]
				])),
			h('div', { class: 'card' },
				h('h2', null, 'Leader roles'),
				h('table', null,
					h('thead', null, h('tr', null, h('th', null, 'Role'), h('th', null, 'Holder'), h('th', null, 'Since'))),
					h('tbody', null, s.leaders.map(l => h('tr', null,
						h('td', null, l.role),
						h('td', null, l.held ? h('span', { class: 'mono' }, l.client_addr ?? 'local') : badge('nobody', 'bad')),
						h('td', null, l.held ? ago(l.since) : '—')))))),
			h('div', { class: 'card' },
				h('h2', null, 'Log activity today'),
				s.logs.length === 0
					? h('p', { class: 'muted' }, 'No log files yet today.')
					: h('table', null,
						h('thead', null, h('tr', null, h('th', null, 'Service'), h('th', null, 'Last write'), h('th', { class: 'num' }, 'Size'))),
						h('tbody', null, s.logs.map((l) => {
							const stale = Date.now() - new Date(l.last_write).getTime() > 30 * 60_000;
							return h('tr', null,
								h('td', null, h('a', { href: `#/logs/${l.service}` }, l.service)),
								h('td', null, stale ? badge(ago(l.last_write), 'warn') : ago(l.last_write)),
								h('td', { class: 'num' }, bytes(l.size)));
						}))))),
		h('div', { class: 'card' },
			h('h2', null, 'Database connections by process'),
			h('div', { style: 'overflow-x:auto' }, h('table', null,
				h('thead', null, h('tr', null, h('th', null, 'Application'), h('th', null, 'Address'), h('th', { class: 'num' }, 'Connections'), h('th', { class: 'num' }, 'Active'), h('th', null, 'Oldest'))),
				h('tbody', null, s.database.connections.map(c => h('tr', null,
					h('td', { class: 'mono' }, c.application_name),
					h('td', { class: 'mono' }, c.client_addr ?? 'local'),
					h('td', { class: 'num' }, c.connections),
					h('td', { class: 'num' }, c.active),
					h('td', null, ago(c.since))))))))
	];
}

// ---- Logs ----

function logs_view(main, [service_param]) {
	const today = new Date().toISOString().slice(0, 10);
	const f = { service: service_param ?? 'api', day: today, level: 'info', access: false, scope: '', request_id: '', user_id: '', q: '' };
	let files = [];
	let rows = [];
	let last_line = null;
	let has_more = false;
	let stop_tail = null;

	const tbody = h('tbody');
	const footer = h('div', { class: 'row', style: 'margin-top:12px' });
	const status = h('span', { class: 'muted small' });
	const controls = h('div', { class: 'toolbar' });

	const input = (key, placeholder, width = '160px') => h('input', {
		value: f[key], placeholder, style: `width:${width}`,
		oninput: (e) => { f[key] = e.target.value.trim(); },
		onkeydown: (e) => { if (e.key === 'Enter') void load(); }
	});

	const draw_controls = () => {
		const services = [...new Set(files.map(x => x.service))];
		if (!services.includes(f.service)) services.unshift(f.service);
		const days = [...new Set(files.filter(x => x.service === f.service).map(x => x.day))];
		if (!days.includes(f.day)) days.unshift(f.day);
		const tail = h('label', { class: 'check' }, h('input', {
			type: 'checkbox', checked: stop_tail !== null, disabled: f.day !== today,
			onchange: (e) => { if (e.target.checked) start_tail(); else stop_tailing(); }
		}), 'Live tail');
		replace(controls,
			select(services, f.service, (v) => { f.service = v; void load(); }),
			select(days, f.day, (v) => { f.day = v; stop_tailing(); void load(); }),
			select([['debug', 'debug+'], ['info', 'info+'], ['warn', 'warn+'], ['error', 'error']], f.level, (v) => { f.level = v; void load(); }),
			h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.access, onchange: (e) => { f.access = e.target.checked; void load(); } }), 'Access log'),
			input('scope', 'scope', '110px'),
			input('request_id', 'request id'),
			input('user_id', 'user id'),
			input('q', 'text contains…', '200px'),
			h('button', { class: 'primary', onclick: () => void load() }, 'Search'),
			tail);
	};

	const level_class = e => e.level === 'error' ? 'lvl-error' : e.level === 'warn' ? 'lvl-warn' : e.level === 'debug' ? 'lvl-debug' : '';

	const message = (e) => {
		if (e.scope === 'access') return `${e.method} ${e.path} → ${e.status} ${e.duration_ms}ms${e.aborted ? ' (aborted)' : ''}`;
		const data = e.data === undefined ? '' : ` ${typeof e.data === 'object' && e.data?.message ? e.data.message : preview(e.data)}`;
		return `${e.msg ?? ''}${data}`;
	};

	const filter_by = (key, value) => (ev) => {
		ev.stopPropagation();
		f[key] = value;
		draw_controls();
		void load();
	};

	const row_el = ({ line, entry: e }) => {
		const tr = h('tr', { class: `log-row clickable ${level_class(e)}` },
			h('td', { class: 'nowrap muted' }, e.time ? new Date(e.time).toLocaleTimeString() : `#${line}`),
			h('td', null, e.level === 'error' ? badge('error', 'bad') : e.level === 'warn' ? badge('warn', 'warn') : e.level),
			h('td', null, e.scope ? h('a', { href: '#', onclick: filter_by('scope', e.scope) }, e.scope) : ''),
			h('td', { class: 'msg' }, message(e)),
			h('td', null, e.request_id ? h('a', { href: '#', class: 'mono', title: e.request_id, onclick: filter_by('request_id', e.request_id) }, short_id(e.request_id)) : ''),
			h('td', null, e.user_id ? h('a', { href: '#', class: 'mono', title: e.user_id, onclick: filter_by('user_id', e.user_id) }, short_id(e.user_id)) : ''));
		tr.addEventListener('click', () => {
			if (tr.nextSibling?.classList?.contains('log-detail')) tr.nextSibling.remove();
			else tr.after(h('tr', { class: 'log-detail' }, h('td', { colspan: 6 }, json(e))));
		});
		return tr;
	};

	const draw_rows = () => {
		replace(tbody, rows.length === 0 ? h('tr', null, h('td', { colspan: 6, class: 'empty' }, 'No matching lines.')) : rows.map(row_el));
		replace(footer, has_more ? h('button', { onclick: () => void load_older() }, 'Load older') : h('span', { class: 'muted small' }, rows.length ? 'Start of file' : ''));
		replace(status, `${rows.length} lines shown`);
	};

	const params = extra => qs({ ...f, access: String(f.access), limit: 200, ...extra });

	async function load() {
		replace(tbody, h('tr', null, h('td', { colspan: 6, class: 'empty' }, 'Loading…')));
		draw_controls();
		try {
			const res = await api('GET', `/admin/logs${params({})}`);
			rows = res.lines;
			has_more = res.has_more;
			last_line = res.last_line;
		} catch (err) {
			rows = [];
			has_more = false;
			replace(tbody, h('tr', null, h('td', { colspan: 6, class: 'empty error' }, err.message)));
			replace(footer);
			return;
		}
		draw_rows();
	}

	async function load_older() {
		const before = rows.at(-1)?.line;
		if (!before) return;
		const res = await act(null, () => api('GET', `/admin/logs${params({ before })}`));
		rows = rows.concat(res.lines);
		has_more = res.has_more;
		draw_rows();
	}

	function start_tail() {
		stop_tail = poll(async () => {
			if (last_line == null) return;
			const res = await api('GET', `/admin/logs${params({ after: last_line })}`);
			if (res.last_line != null) last_line = res.last_line;
			if (res.lines.length === 0) return;
			rows = res.lines.concat(rows).slice(0, 2000);
			draw_rows();
		}, 4000);
	}

	function stop_tailing() {
		stop_tail?.();
		stop_tail = null;
	}

	main.append(
		h('h1', null, 'Logs', status),
		controls,
		h('div', { class: 'table-wrap' }, h('table', null,
			h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Level'), h('th', null, 'Scope'), h('th', null, 'Message'), h('th', null, 'Request'), h('th', null, 'User'))),
			tbody)),
		footer);

	void (async () => {
		try {
			files = (await api('GET', '/admin/logs/files')).files;
		} catch (err) {
			replace(main, h('h1', null, 'Logs'), error_view(err));
			return;
		}
		await load();
	})();
	return stop_tailing;
}

// ---- Review ----

const REVIEW_KINDS = ['FIELD_CONFLICT', 'SERVICE_ID_CONFLICT', 'LYRICS_PARSE_FAILURE', 'GENIUS_MATCH_REJECTED', 'AUTO_MERGE', 'AUTO_SPLIT'];

function entity_label(context) {
	const e = context?.entity;
	if (!e) return context?.entity_id ?? '?';
	return e.title ?? e.name ?? context.entity_id;
}

function entity_link(context) {
	const id = context?.redirected_to ?? context?.entity_id;
	const label = entity_label(context);
	const kind = context?.kind;
	return h('span', null,
		kind === 'track' ? link_track(id, label) : h('strong', null, label),
		' ', kind ? badge(kind) : null,
		' ', h('span', { class: 'mono muted small', title: id }, short_id(id)),
		context?.redirected_to ? h('span', { class: 'muted small' }, ` (merged from ${short_id(context.entity_id)})`) : null);
}

function review_view(main) {
	const f = { status: 'OPEN', kind: '', sort: 'occurrences', page: 1 };
	const list = h('div', { class: 'stack' });
	const controls = h('div', { class: 'toolbar' });
	const count = h('span', { class: 'muted small' });

	const draw_controls = () => replace(controls,
		select([['OPEN', 'Open'], ['APPLIED', 'Applied'], ['DISMISSED', 'Dismissed']], f.status, (v) => { f.status = v; f.page = 1; void load(); }),
		select([['', 'All kinds'], ...REVIEW_KINDS], f.kind, (v) => { f.kind = v; f.page = 1; void load(); }),
		select([['occurrences', 'Most reported'], ['age', 'Oldest first']], f.sort, (v) => { f.sort = v; f.page = 1; void load(); }),
		h('button', { onclick: () => void load() }, 'Reload'));

	async function load() {
		draw_controls();
		replace(list, h('div', { class: 'empty' }, 'Loading…'));
		try {
			const data = await api('GET', `/admin/review${qs({ status: f.status, kind: f.kind, sort: f.sort, page: f.page })}`);
			replace(count, `${data.total} items`);
			if (f.status === 'OPEN') nav_counts.review = f.kind ? nav_counts.review : data.total;
			replace(list,
				data.items.length === 0 ? h('div', { class: 'card empty' }, 'Nothing to review.') : data.items.map(item => review_card(item, load)),
				pager(data, f.page, (p) => { f.page = p; void load(); }));
		} catch (err) {
			replace(list, error_view(err));
		}
	}

	main.append(h('h1', null, 'Review queue', count), controls, list);
	void load();
}

function review_card(item, reload) {
	const proposals = item.proposed_values ?? [];
	const open = item.status === 'OPEN';
	const is_conflict = item.kind === 'SERVICE_ID_CONFLICT';
	const appliable = open && (is_conflict || item.field);
	let selected = default_proposal(item.kind, proposals);
	let custom = null;

	const labels = new Map();
	for (const c of [item.context, ...(item.group ?? [])]) if (c) labels.set(c.redirected_to ?? c.entity_id, c).set(c.entity_id, c);
	const ref = id => labels.has(id) ? entity_link(labels.get(id)) : h('span', { class: 'mono' }, short_id(id));

	const proposals_el = h('div');
	const draw_proposals = () => replace(proposals_el, proposals.map((p, i) => h('label', { class: `proposal ${i === selected && custom === null ? 'selected' : ''}` },
		appliable ? h('input', { type: 'radio', name: `p-${item.id}`, checked: i === selected && custom === null, onchange: () => { selected = i; custom = null; draw_proposals(); } }) : null,
		h('div', { style: 'flex:1;min-width:0' },
			h('div', { class: 'muted small' }, `${p.occurrences} report${p.occurrences === 1 ? '' : 's'} · ${p.source_user_ids?.length ?? 0} user${p.source_user_ids?.length === 1 ? '' : 's'}`),
			is_conflict && p.value?.steps ? p.value.steps.map(s => h('div', { class: 'step' }, plan_step(s, ref))) : json(p.value),
			p.evidence ? h('details', null, h('summary', { class: 'muted small' }, 'Evidence'), json(p.evidence)) : null))));
	draw_proposals();

	const custom_input = item.field && appliable ? h('textarea', {
		rows: 2,
		placeholder: 'Or type a value to apply instead (JSON or plain text)',
		oninput: (e) => {
			custom = e.target.value.trim() === '' ? null : e.target.value;
			draw_proposals();
		}
	}) : null;

	const apply_btn = h('button', {
		class: 'primary',
		disabled: !appliable,
		onclick: async () => {
			const body = {};
			if (custom !== null) {
				try {
					body.value = JSON.parse(custom);
				} catch {
					body.value = custom;
				}
			} else if (selected >= 0) body.proposal_index = selected;
			await act(apply_btn, () => api('POST', `/admin/review/${item.id}/apply`, body), 'Applied');
			reload();
		}
	}, is_conflict ? 'Apply plan' : 'Apply');

	const dismiss_btn = h('button', {
		disabled: !open,
		onclick: async () => {
			await act(dismiss_btn, () => api('POST', `/admin/review/${item.id}/dismiss`), item.kind.startsWith('AUTO_') ? 'Acknowledged' : 'Dismissed');
			reload();
		}
	}, item.kind.startsWith('AUTO_') ? 'Acknowledge' : 'Dismiss');

	return h('div', { class: 'card' },
		h('div', { class: 'spread' },
			h('div', { class: 'row' }, badge(item.kind, is_conflict ? 'warn' : 'info'), entity_link(item.context), item.field ? h('code', null, item.field) : null),
			h('span', { class: 'muted small' }, `#${item.id} · ${item.occurrences}× · ${ago(item.created_at)}`, item.status !== 'OPEN' ? [' · ', badge(item.status)] : null)),
		item.field ? [h('h3', null, 'Current value'), json(item.current_value)] : null,
		proposals.length ? [h('h3', null, is_conflict ? 'Proposed plans' : 'Proposals'), proposals_el] : null,
		custom_input,
		is_conflict && item.conflicts?.length ? [
			h('h3', null, 'Service id conflicts'),
			h('div', { style: 'overflow-x:auto' }, h('table', null,
				h('thead', null, h('tr', null, h('th', null, 'Column'), h('th', null, 'Existing'), h('th', null, 'Incoming'), h('th', null, 'On'), h('th', null, 'Other'), h('th', null, 'Source'), h('th', null, 'Status'))),
				h('tbody', null, item.conflicts.map(c => h('tr', null,
					h('td', { class: 'mono' }, c.column),
					h('td', { class: 'mono' }, c.existing_value ?? '—'),
					h('td', { class: 'mono' }, c.incoming_value),
					h('td', null, ref(c.illusi_id)),
					h('td', null, c.other_illusi_id ? ref(c.other_illusi_id) : '—'),
					h('td', null, c.source),
					h('td', null, badge(c.status)))))))
		] : null,
		h('details', null, h('summary', { class: 'muted small' }, 'Entity context'), json({ context: item.context, group: item.group, details: item.details })),
		open ? h('div', { class: 'row', style: 'margin-top:12px' }, apply_btn, dismiss_btn) : null);
}

function default_proposal(kind, proposals) {
	if (proposals.length === 0) return -1;
	if (kind === 'SERVICE_ID_CONFLICT') return proposals.length - 1;
	let best = 0;
	for (let i = 1; i < proposals.length; i++) if (proposals[i].occurrences > proposals[best].occurrences) best = i;
	return best;
}

function plan_step(s, ref) {
	const values = s.values ? h('code', null, Object.entries(s.values).map(([k, v]) => `${k}=${v}`).join(', ')) : null;
	if (s.type === 'merge') return h('div', null, badge('merge'), ' ', ref(s.loser), ' → into ', ref(s.survivor));
	if (s.type === 'move') return h('div', null, badge('move'), ' ', values, ' from ', ref(s.from), ' to ', ref(s.to));
	return h('div', null, badge('split'), ' ', values, ' off ', ref(s.from), ' into a new entity');
}

// ---- Backpack ----

function backpack_view(main) {
	const f = { sort: 'reports', exhausted: false, page: 1 };
	const body = h('div');
	const controls = h('div', { class: 'toolbar' });
	const count = h('span', { class: 'muted small' });

	const draw_controls = () => replace(controls,
		select([['reports', 'Most reported'], ['age', 'Longest backpacked']], f.sort, (v) => { f.sort = v; f.page = 1; void load(); }),
		h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.exhausted, onchange: (e) => { f.exhausted = e.target.checked; f.page = 1; void load(); } }), 'Stuck (research found nothing anywhere)'),
		h('button', { onclick: () => void load() }, 'Reload'));

	async function load() {
		draw_controls();
		replace(body, h('div', { class: 'empty' }, 'Loading…'));
		try {
			const data = await api('GET', `/admin/backpack${qs({ sort: f.sort, exhausted: f.exhausted ? 'true' : undefined, page: f.page })}`);
			replace(count, `${data.total} tracks`);
			replace(body,
				h('div', { class: 'table-wrap' }, h('table', null,
					h('thead', null, h('tr', null,
						h('th', null, 'Track'), h('th', { class: 'num' }, 'Reports'), h('th', { class: 'num' }, 'Users'), h('th', null, 'Reported on'),
						h('th', null, 'Research'), h('th', null, 'Backpacked'), h('th', null, 'Last report'), h('th'))),
					h('tbody', null, data.items.length === 0
						? h('tr', null, h('td', { colspan: 8, class: 'empty' }, 'No backpacked tracks.'))
						: data.items.map(t => backpack_row(t, load))))),
				pager(data, f.page, (p) => { f.page = p; void load(); }));
		} catch (err) {
			replace(body, error_view(err));
		}
	}

	main.append(h('h1', null, 'Backpack', count),
		h('p', { class: 'muted' }, 'Tracks no client could play or download. They clear when someone uploads media or research finds a playable id.'),
		controls, body);
	void load();
}

function research_badges(research) {
	if (!research) return h('span', { class: 'muted' }, 'not started');
	return h('div', { class: 'row' }, Object.entries(research).map(([service, st]) =>
		badge(`${service}: ${st.toLowerCase().replace('_', ' ')}`, st === 'FOUND' ? 'ok' : st === 'NOT_FOUND' ? 'bad' : '')));
}

function backpack_row(t, reload) {
	const clear = h('button', {
		class: 'small',
		onclick: async (e) => {
			e.stopPropagation();
			if (!confirm(`Clear the backpacked flag on "${t.title}"?`)) return;
			await act(clear, () => api('PATCH', `/admin/entities/tracks/${t.id}`, { backpacked: false }), 'Cleared');
			reload();
		}
	}, 'Clear');
	return h('tr', { class: 'clickable', onclick: () => { location.hash = `#/tracks/${t.id}`; } },
		h('td', null, h('strong', null, t.title), h('div', { class: 'muted small' }, [t.artists.join(', '), t.album].filter(Boolean).join(' · '))),
		h('td', { class: 'num' }, t.reports),
		h('td', { class: 'num' }, t.reporters),
		h('td', null, t.reported_services.join(', ')),
		h('td', null, research_badges(t.research)),
		h('td', { class: 'nowrap' }, ago(t.backpacked_at)),
		h('td', { class: 'nowrap' }, ago(t.last_reported_at)),
		h('td', null, clear));
}

// ---- Tracks ----

function tracks_view(main, [id]) {
	if (id) return track_detail_view(main, id);
	let q = '';
	const results = h('div');
	const search = async () => {
		if (!q) return;
		replace(results, h('div', { class: 'empty' }, 'Searching…'));
		try {
			const data = await api('GET', `/admin/tracks${qs({ q })}`);
			replace(results, h('div', { class: 'table-wrap' }, h('table', null,
				h('thead', null, h('tr', null, h('th', null, 'Title'), h('th', null, 'Artists'), h('th', null, 'Album'), h('th', null, 'Length'), h('th', { class: 'num' }, 'Media'), h('th'))),
				h('tbody', null, data.items.length === 0
					? h('tr', null, h('td', { colspan: 6, class: 'empty' }, 'No tracks found.'))
					: data.items.map(t => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/tracks/${t.id}`; } },
						h('td', null, h('strong', null, t.title)),
						h('td', null, t.artists.join(', ')),
						h('td', null, t.album ?? '—'),
						h('td', null, ms(t.duration_ms)),
						h('td', { class: 'num' }, t.media_count),
						h('td', null, t.backpacked ? badge('backpacked', 'warn') : null)))))));
		} catch (err) {
			replace(results, error_view(err));
		}
	};
	const input = h('input', {
		placeholder: 'Track title or id', style: 'width:min(420px,100%)',
		oninput: (e) => { q = e.target.value.trim(); },
		onkeydown: (e) => { if (e.key === 'Enter') void search(); }
	});
	main.append(h('h1', null, 'Tracks'), h('div', { class: 'toolbar' }, input, h('button', { class: 'primary', onclick: () => void search() }, 'Search')), results);
	setTimeout(() => input.focus());
}

function track_detail_view(main, id) {
	const body = h('div', { class: 'stack' }, h('div', { class: 'empty' }, 'Loading…'));
	main.append(h('h1', null, h('a', { href: '#/tracks' }, 'Tracks'), h('span', { class: 'muted' }, '/'), short_id(id)), body);

	async function load() {
		try {
			const d = await api('GET', `/admin/tracks/${encodeURIComponent(id)}`);
			if (d.redirected_from) history.replaceState(null, '', `#/tracks/${d.track.id}`);
			replace(body, track_sections(d, load));
		} catch (err) {
			replace(body, error_view(err));
		}
	}
	void load();
}

function track_sections(d, reload) {
	const t = d.track;
	const toggle = h('button', {
		onclick: async () => {
			await act(toggle, () => api('PATCH', `/admin/entities/tracks/${t.id}`, { backpacked: !t.backpacked }), t.backpacked ? 'Cleared' : 'Backpacked');
			reload();
		}
	}, t.backpacked ? 'Clear backpacked' : 'Mark backpacked');

	const sids = d.service_ids ?? {};
	const id_columns = Object.keys(sids).filter(k => !['illusi_id', 'created_at', 'modified_at'].includes(k));
	const id_inputs = Object.fromEntries(id_columns.map(c => [c, h('input', { value: sids[c] ?? '', class: 'mono', style: 'width:100%' })]));
	const save_ids = h('button', {
		class: 'primary',
		onclick: async () => {
			const patch = {};
			for (const c of id_columns) {
				const v = id_inputs[c].value.trim();
				if (v !== String(sids[c] ?? '')) patch[c] = v === '' ? null : v;
			}
			if (Object.keys(patch).length === 0) return toast('Nothing changed');
			await act(save_ids, () => api('PATCH', `/admin/entities/service_ids/${t.id}`, patch), 'Service ids saved');
			reload();
		}
	}, 'Save service ids');

	return [
		h('div', { class: 'card' },
			h('div', { class: 'spread' },
				h('div', null, h('h2', { style: 'margin:0' }, t.title), h('div', { class: 'muted' }, [t.artists.join(', '), t.album].filter(Boolean).join(' · '))),
				h('div', { class: 'row' }, t.backpacked ? badge('backpacked', 'warn') : null, t.imported ? badge('imported') : null, toggle)),
			h('div', { style: 'margin-top:12px' }, kv([
				['Id', h('span', { class: 'mono' }, t.id)],
				['Length', ms(t.duration_ms)],
				['Backpacked since', t.backpacked_at ? datetime(t.backpacked_at) : null],
				['Created', datetime(t.created_at)],
				['Modified', datetime(t.modified_at)]
			]))),
		h('div', { class: 'card' },
			h('h2', null, `Media (${d.media.length})`),
			d.media.length === 0 ? h('p', { class: 'muted' }, 'No stored media.') : h('div', { style: 'overflow-x:auto' }, h('table', null,
				h('thead', null, h('tr', null, h('th', null, 'Resource'), h('th', null, 'Quality'), h('th', null, 'Uploaded by'), h('th', null, 'Uploaded'), h('th'))),
				h('tbody', null, d.media.map((m) => {
					const del = h('button', {
						class: 'small danger',
						onclick: async () => {
							if (!confirm(`Delete media ${m.resource_id}? The file is removed from disk and cannot be restored.`)) return;
							await act(del, () => api('DELETE', `/admin/media/${m.id}`), 'Media removed');
							reload();
						}
					}, 'Delete');
					return h('tr', null,
						h('td', { class: 'mono' }, m.resource_id),
						h('td', null, m.quality ?? '—'),
						h('td', null, m.uploader ?? (m.uploaded_by ? short_id(m.uploaded_by) : '—')),
						h('td', null, datetime(m.created_at)),
						h('td', null, del));
				}))))),
		h('div', { class: 'card' },
			h('h2', null, 'Service ids'),
			d.service_ids ? [
				h('div', { class: 'kv', style: 'grid-template-columns:max-content 1fr' }, id_columns.map(c => [h('dt', { class: 'mono' }, c), h('dd', null, id_inputs[c])])),
				h('div', { class: 'row', style: 'margin-top:12px' }, save_ids, h('span', { class: 'muted small' }, 'Setting a youtube, soundcloud, bandlab or audiomack id clears the backpacked flag.'))
			] : h('p', { class: 'muted' }, 'No service ids row.')),
		h('div', { class: 'grid' },
			h('div', { class: 'card' },
				h('h2', null, `Unavailable reports (${d.reports.length})`),
				d.reports.length === 0 ? h('p', { class: 'muted' }, 'None.') : h('table', null,
					h('thead', null, h('tr', null, h('th', null, 'User'), h('th', null, 'Service'), h('th', null, 'Reason'), h('th', null, 'When'))),
					h('tbody', null, d.reports.map(r => h('tr', null,
						h('td', null, r.username ?? short_id(r.user_id)), h('td', null, r.service), h('td', null, r.reason ?? '—'), h('td', { class: 'nowrap' }, ago(r.modified_at))))))),
			h('div', { class: 'card' },
				h('h2', null, 'Research'),
				d.research.length === 0 ? h('p', { class: 'muted' }, 'Not started.') : h('table', null,
					h('thead', null, h('tr', null, h('th', null, 'Service'), h('th', null, 'Status'), h('th', null, 'Found'), h('th', null, 'Checked'))),
					h('tbody', null, d.research.map(r => h('tr', null,
						h('td', null, r.service),
						h('td', null, badge(r.status, r.status === 'FOUND' ? 'ok' : r.status === 'NOT_FOUND' ? 'bad' : '')),
						h('td', { class: 'mono' }, r.found_value ?? '—'),
						h('td', { class: 'nowrap' }, ago(r.checked_at)))))))),
		h('div', { class: 'card' },
			h('h2', null, 'Recent audit entries'),
			d.audit.length === 0 ? h('p', { class: 'muted' }, 'None.') : audit_table(d.audit))
	];
}

// ---- Users ----

function users_view(main) {
	const f = { q: '', role: '', page: 1 };
	const body = h('div');
	const count = h('span', { class: 'muted small' });

	async function load() {
		replace(body, h('div', { class: 'empty' }, 'Loading…'));
		try {
			const data = await api('GET', `/admin/users${qs(f)}`);
			replace(count, `${data.total} users`);
			replace(body,
				h('div', { class: 'table-wrap' }, h('table', null,
					h('thead', null, h('tr', null, h('th', null, 'User'), h('th', null, 'Role'), h('th', null, 'Email'), h('th', { class: 'num' }, 'Sessions'), h('th', null, 'Last seen'), h('th', null, 'Joined'), h('th', null, 'Actions'))),
					h('tbody', null, data.items.length === 0 ? h('tr', null, h('td', { colspan: 7, class: 'empty' }, 'No users found.')) : data.items.map(u => user_row(u, load))))),
				pager(data, f.page, (p) => { f.page = p; void load(); }));
		} catch (err) {
			replace(body, error_view(err));
		}
	}

	const input = h('input', {
		placeholder: 'Email, username or id', style: 'width:min(320px,100%)',
		oninput: (e) => { f.q = e.target.value.trim(); },
		onkeydown: (e) => { if (e.key === 'Enter') { f.page = 1; void load(); } }
	});
	main.append(h('h1', null, 'Users', count),
		h('div', { class: 'toolbar' }, input,
			select([['', 'All roles'], ['ADMIN', 'Admins'], ['USER', 'Users']], f.role, (v) => { f.role = v; f.page = 1; void load(); }),
			h('button', { class: 'primary', onclick: () => { f.page = 1; void load(); } }, 'Search')),
		body);
	void load();
}

function user_row(u, reload) {
	const self = u.id === me?.id;
	const patch = (body, message) => async (e) => {
		await act(e.currentTarget, () => api('PATCH', `/admin/users/${u.id}`, body), message);
		reload();
	};
	const revoke = async (e) => {
		if (!confirm(`Sign ${u.username} out of every device?`)) return;
		await act(e.currentTarget, () => api('POST', `/admin/users/${u.id}/revoke_sessions`), 'Sessions revoked');
		reload();
	};
	const remove = async (e) => {
		const typed = prompt(`Delete ${u.username} and all their personal data? This cannot be undone.\nType their email (${u.email}) to confirm.`);
		if (typed === null) return;
		if (typed.trim().toLowerCase() !== u.email) return toast('Email did not match; nothing deleted', 'bad');
		await act(e.currentTarget, () => api('DELETE', `/admin/users/${u.id}`), 'User deleted');
		reload();
	};
	return h('tr', null,
		h('td', null, h('strong', null, u.username), self ? h('span', { class: 'muted small' }, ' (you)') : null, h('div', { class: 'mono muted small' }, u.id)),
		h('td', null, u.role === 'ADMIN' ? badge('admin', 'info') : badge('user')),
		h('td', null, u.email, ' ', u.email_verified_at ? null : badge('unverified', 'warn')),
		h('td', { class: 'num' }, u.active_sessions),
		h('td', { class: 'nowrap' }, ago(u.last_seen_at)),
		h('td', { class: 'nowrap' }, ago(u.created_at)),
		h('td', null, h('div', { class: 'row' },
			u.role === 'ADMIN'
				? h('button', { class: 'small', disabled: self, onclick: patch({ role: 'USER' }, 'Admin role removed') }, 'Remove admin')
				: h('button', { class: 'small', onclick: patch({ role: 'ADMIN' }, 'Promoted to admin') }, 'Make admin'),
			u.email_verified_at
				? h('button', { class: 'small', onclick: patch({ email_verified: false }, 'Marked unverified') }, 'Unverify')
				: h('button', { class: 'small', onclick: patch({ email_verified: true }, 'Marked verified') }, 'Verify'),
			h('button', { class: 'small', disabled: u.active_sessions === 0, onclick: revoke }, 'Sign out'),
			h('button', { class: 'small danger', disabled: self, onclick: remove }, 'Delete'))));
}

// ---- Tables ----

const FILTER_OPS = [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['is_null', 'is null'], ['not_null', 'is not null']];
const SCALAR_KINDS = ['text', 'uuid', 'enum', 'boolean', 'integer', 'number', 'timestamp', 'date'];
let table_list = null;

function tables_view(main, [name]) {
	const list = h('div', { class: 'db-list' }, h('div', { class: 'empty' }, 'Loading…'));
	const content = h('div', { class: 'db-content' });
	let q = '';
	main.append(h('div', { class: 'db-layout' }, h('div', { class: 'db-side' },
		h('input', { placeholder: 'Find a table…', oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw_list(); } }), list), content));

	const draw_list = () => replace(list, table_list.filter(t => t.name.includes(q)).map(t => h('a', { href: `#/tables/${t.name}`, class: t.name === name ? 'active' : '' },
		h('span', { class: 'ellipsis' }, t.name.replace(/_table$/u, '')),
		t.row_estimate != null ? h('span', { class: 'muted small' }, compact(t.row_estimate)) : null)));

	let close_drawer = null;
	void (async () => {
		try {
			table_list ??= (await api('GET', '/admin/tables')).tables;
		} catch (err) {
			replace(content, error_view(err));
			return;
		}
		draw_list();
		const table = table_list.find(t => t.name === name);
		if (!table) {
			replace(content, h('div', { class: 'card empty' }, name ? `No table named ${name}.` : `Pick one of ${table_list.length} tables.`));
			return;
		}
		close_drawer = table_grid(content, table);
	})();
	return () => close_drawer?.();
}

function compact(n) {
	if (n < 1000) return String(n);
	if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
	return `${(n / 1e6).toFixed(1)}M`;
}

function cell_text(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

function table_grid(content, table) {
	const f = { page: 1, limit: 50, sort: '', dir: 'asc', filters: [] };
	let rows = [];
	let has_more = false;
	let drawer = null;
	const body = h('div');
	const chips = h('div', { class: 'row' });
	const filterable = table.columns.filter(c => !c.redacted);

	const draft = { column: filterable[0]?.name ?? '', op: 'eq', value: '' };
	const value_input = h('input', { placeholder: 'value', style: 'width:180px', oninput: (e) => { draft.value = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') add_filter(); } });
	const add_filter = () => {
		const needs_value = !['is_null', 'not_null'].includes(draft.op);
		if (needs_value && draft.value === '') return toast('Enter a value to filter by', 'bad');
		f.filters.push({ column: draft.column, op: draft.op, ...needs_value ? { value: draft.value } : {} });
		draft.value = '';
		value_input.value = '';
		f.page = 1;
		void load();
	};
	const draw_chips = () => replace(chips, f.filters.map((x, i) => h('span', { class: 'chip' },
		h('span', { class: 'mono' }, `${x.column} ${FILTER_OPS.find(([o]) => o === x.op)[1]}${x.value !== undefined ? ` ${x.value}` : ''}`),
		h('button', { class: 'small', title: 'Remove filter', onclick: () => { f.filters.splice(i, 1); f.page = 1; void load(); } }, '×'))));

	const sortable = c => !c.redacted && SCALAR_KINDS.includes(c.kind);
	const sort_by = (c) => {
		if (!sortable(c)) return;
		if (f.sort !== c.name) Object.assign(f, { sort: c.name, dir: 'asc' });
		else if (f.dir === 'asc') f.dir = 'desc';
		else Object.assign(f, { sort: '', dir: 'asc' });
		f.page = 1;
		void load();
	};

	const header = () => h('tr', null, table.columns.map(c => h('th', { class: sortable(c) ? 'sortable' : '', title: `${c.sql_type}${c.nullable ? '' : ' not null'}`, onclick: () => sort_by(c) },
		c.name, c.primary_key ? h('span', { class: 'key' }, ' 🔑') : null,
		f.sort === c.name ? (f.dir === 'asc' ? ' ▲' : ' ▼') : null,
		h('div', { class: 'type' }, c.sql_type))));

	const cell = (c, row) => {
		if (c.redacted) return h('td', { class: 'cell muted' }, 'hidden');
		const text = cell_text(row[c.name]);
		if (text === null) return h('td', { class: 'cell null' }, 'NULL');
		return h('td', { class: `cell ${c.kind === 'integer' || c.kind === 'number' ? 'num' : ''}`, title: text.length > 60 ? text.slice(0, 2000) : null }, text);
	};

	const open_row = row => show_drawer(Object.fromEntries(table.primary_key.map(k => [k, row[k]])), row);

	const show_drawer = (key, row) => {
		drawer?.remove();
		drawer = row_drawer(table, key, {
			on_saved: (updated) => {
				const i = rows.indexOf(row);
				if (i >= 0) rows[i] = { ...updated, _truncated: [] };
				draw();
			},
			on_created: () => void load(),
			on_deleted: () => void load(),
			on_close: () => { drawer = null; }
		});
		document.body.append(drawer);
	};

	const draw = () => replace(body,
		h('div', { class: 'table-wrap db-grid' }, h('table', null,
			h('thead', null, header()),
			h('tbody', null, rows.length === 0
				? h('tr', null, h('td', { colspan: table.columns.length, class: 'empty' }, f.filters.length ? 'No rows match these filters.' : 'This table is empty.'))
				: rows.map(r => h('tr', { class: 'clickable', onclick: () => open_row(r) }, table.columns.map(c => cell(c, r))))))),
		h('div', { class: 'row', style: 'margin-top:12px' },
			h('button', { class: 'small', disabled: f.page <= 1, onclick: () => { f.page--; void load(); } }, '← Prev'),
			h('span', { class: 'muted small' }, `Page ${f.page} · rows ${rows.length ? (f.page - 1) * f.limit + 1 : 0}–${(f.page - 1) * f.limit + rows.length}`),
			h('button', { class: 'small', disabled: !has_more, onclick: () => { f.page++; void load(); } }, 'Next →'),
			select([['25', '25 rows'], ['50', '50 rows'], ['100', '100 rows'], ['200', '200 rows']], String(f.limit), (v) => { f.limit = Number(v); f.page = 1; void load(); })));

	async function load() {
		draw_chips();
		try {
			const data = await api('GET', `/admin/tables/${encodeURIComponent(table.name)}/rows${qs({
				page: f.page, limit: f.limit, sort: f.sort, dir: f.sort ? f.dir : undefined, filters: f.filters.length ? JSON.stringify(f.filters) : undefined
			})}`);
			rows = data.items;
			has_more = data.has_more;
			draw();
		} catch (err) {
			replace(body, error_view(err));
		}
	}

	replace(content,
		h('h1', null, table.name,
			table.editable ? null : badge('read-only', 'warn'),
			h('span', { class: 'muted small' }, table.row_estimate != null ? `~${table.row_estimate.toLocaleString()} rows` : ''),
			h('span', { class: 'muted small' }, `key: ${table.primary_key.join(', ')}`)),
		h('div', { class: 'toolbar' },
			select(filterable.map(c => c.name), draft.column, (v) => { draft.column = v; }),
			select(FILTER_OPS, draft.op, (v) => { draft.op = v; value_input.disabled = ['is_null', 'not_null'].includes(v); }),
			value_input,
			h('button', { onclick: add_filter }, 'Add filter'),
			h('button', { onclick: () => void load() }, 'Reload'),
			h('span', { class: 'grow' }),
			h('button', { class: 'primary', disabled: Boolean(table.insert_blocked), title: table.insert_blocked ?? '', onclick: () => show_drawer(null, null) }, '+ Insert row')),
		chips,
		body);
	void load();
	return () => drawer?.remove();
}

/** Text in an input for a stored value, and back. */
function field_text(c, v) {
	if (v === null || v === undefined) return '';
	if (c.kind === 'json' || c.kind === 'array' || c.kind === 'vector') return JSON.stringify(v, null, 2);
	return String(v);
}

function field_value(c, text) {
	switch (c.kind) {
		case 'integer': case 'number': {
			if (text.trim() === '') throw new Error(`${c.name}: enter a number or tick NULL`);
			const n = Number(text);
			if (!Number.isFinite(n)) throw new Error(`${c.name}: not a number`);
			return n;
		}
		case 'boolean': return text === 'true';
		case 'json': case 'array':
			try {
				return JSON.parse(text);
			} catch {
				throw new Error(`${c.name}: not valid JSON`);
			}
		default: return text;
	}
}

const table_path = (table, suffix) => `/admin/tables/${encodeURIComponent(table.name)}/${suffix}`;

function delete_summary(table, preview) {
	const lines = [`Delete this row from ${table.name}?`];
	const effects = preview.dependents.filter(d => d.action !== 'blocks');
	if (effects.length) {
		lines.push('', 'This also:');
		for (const d of effects) lines.push(d.action === 'delete' ? `• deletes ${d.rows} row${d.rows === 1 ? '' : 's'} in ${d.table}` : `• clears the link in ${d.rows} row${d.rows === 1 ? '' : 's'} of ${d.table}`);
	}
	if (preview.soft_delete_column) lines.push('', `The apps learn about deletions in this table through its "${preview.soft_delete_column}" column. Setting ${preview.soft_delete_column} = true instead keeps them in sync.`);
	lines.push('', 'The deleted row is kept in the audit log.');
	return lines.join('\n');
}

/** The side panel: edits the row with `key`, or fills in a new row when `key` is null. */
function row_drawer(table, key, { on_saved, on_created, on_deleted, on_close }) {
	const body = h('div', { class: 'stack' });
	const title = h('h2', { style: 'margin:0' });
	const subtitle = h('div', { class: 'mono muted small', style: 'margin:4px 0 16px' });
	const close = () => {
		el.remove();
		on_close();
	};
	const on_key = (e) => { if (e.key === 'Escape') close(); };
	document.addEventListener('keydown', on_key);
	const el = h('aside', { class: 'drawer' }, h('div', { class: 'spread' }, title, h('button', { class: 'small', onclick: close }, 'Close')), subtitle, body);
	el.remove = ((remove) => () => { document.removeEventListener('keydown', on_key); remove(); })(el.remove.bind(el));

	const show_row = (row) => {
		key = Object.fromEntries(table.primary_key.map(k => [k, row[k]]));
		replace(title, table.name);
		replace(subtitle, Object.entries(key).map(([k, v]) => `${k} = ${v}`).join(' · '));
		draw_fields(row);
	};

	if (key) {
		replace(title, table.name);
		replace(subtitle, Object.entries(key).map(([k, v]) => `${k} = ${v}`).join(' · '));
		replace(body, h('div', { class: 'empty' }, 'Loading…'));
		void (async () => {
			try {
				show_row(await api('POST', table_path(table, 'row'), { key }));
			} catch (err) {
				replace(body, error_view(err));
			}
		})();
	} else {
		draw_insert();
	}

	function draw_insert() {
		replace(title, `New row in ${table.name}`);
		replace(subtitle, 'Columns left on "default" get their database default.');
		const fields = table.columns.filter(c => c.insertable).map(c => field_editor(c, undefined, 'insert'));
		const automatic = table.columns.filter(c => !c.insertable).map(c => c.name);
		const insert = h('button', {
			class: 'primary',
			onclick: async () => {
				const values = {};
				try {
					for (const fe of fields) if (fe.changed()) values[fe.column.name] = fe.value();
				} catch (err) {
					return toast(err.message, 'bad');
				}
				const row = await act(insert, () => api('POST', table_path(table, 'rows'), { values }), 'Row inserted');
				on_created(row);
				show_row(row);
			}
		}, 'Insert row');
		replace(body,
			fields.map(fe => fe.el),
			automatic.length ? h('p', { class: 'muted small' }, `Set automatically: ${automatic.join(', ')}`) : null,
			h('div', { class: 'row drawer-actions' }, insert, h('span', { class: 'muted small' }, 'The new row goes to the audit log.')));
	}

	function draw_fields(row) {
		const fields = table.columns.map(c => field_editor(c, row[c.name], 'edit'));
		const save = h('button', {
			class: 'primary',
			onclick: async () => {
				const values = {};
				try {
					for (const fe of fields) if (fe.changed()) values[fe.column.name] = fe.value();
				} catch (err) {
					return toast(err.message, 'bad');
				}
				if (Object.keys(values).length === 0) return toast('Nothing changed');
				const updated = await act(save, () => api('PATCH', table_path(table, 'rows'), { key, values }), 'Row saved');
				on_saved(updated);
				draw_fields(updated);
			}
		}, 'Save changes');
		const remove = h('button', {
			class: 'danger',
			title: table.delete_blocked ?? '',
			disabled: Boolean(table.delete_blocked),
			onclick: async () => {
				const preview = await act(remove, () => api('POST', table_path(table, 'delete_preview'), { key }));
				if (preview.blocked) {
					const blockers = preview.dependents.filter(d => d.action === 'blocks').map(d => `${d.rows} in ${d.table}`).join(', ');
					return toast(`Can't delete: other rows still point to this one (${blockers}). Remove or change them first.`, 'bad');
				}
				if (!confirm(delete_summary(table, preview))) return;
				await act(remove, () => api('DELETE', table_path(table, 'rows'), { key }), 'Row deleted');
				close();
				on_deleted();
			}
		}, 'Delete row');
		replace(body,
			fields.map(fe => fe.el),
			table.editable
				? h('div', { class: 'row drawer-actions' }, save, h('span', { class: 'muted small grow' }, 'Only changed fields are saved; every edit goes to the audit log.'), remove)
				: h('p', { class: 'muted small' }, 'This table is read-only.'),
			table.editable && table.delete_blocked ? h('p', { class: 'muted small' }, table.delete_blocked) : null);
	}

	return el;
}

/**
 * One column in the side panel. Editing, the checkbox is NULL; inserting, it is "default" for columns with a database
 * default (or NULL for other nullable ones) and the column is only sent once unticked.
 */
function field_editor(c, original, mode) {
	const inserting = mode === 'insert';
	const label = h('div', { class: 'field-label' },
		h('span', { class: 'mono' }, c.name), ' ',
		h('span', { class: 'muted small' }, c.sql_type, c.nullable ? '' : ' · not null'),
		c.primary_key ? badge('key') : null,
		!inserting && !c.editable && !c.redacted ? badge('read-only') : null);
	if (c.redacted) return { column: c, el: h('div', { class: 'field' }, label, h('div', { class: 'muted' }, 'Hidden: never sent to the dashboard.')), changed: () => false };
	if (!inserting && !c.editable) {
		const text = field_text(c, original);
		return { column: c, el: h('div', { class: 'field' }, label, original === null ? h('div', { class: 'null' }, 'NULL') : text.includes('\n') || text.length > 80 ? h('pre', null, text) : h('div', { class: 'mono value' }, text)), changed: () => false };
	}

	const initial = inserting ? '' : field_text(c, original);
	let input;
	if (c.kind === 'enum' || c.kind === 'boolean') {
		const options = c.kind === 'enum' ? c.enum_values : ['true', 'false'];
		input = h('select', null, options.map(o => h('option', { value: o, selected: o === initial }, o)));
		if (!initial) input.value = options[0];
	} else if (c.kind === 'json' || c.kind === 'array' || c.sql_type === 'text' || initial.length > 80) {
		input = h('textarea', { rows: Math.min(14, Math.max(2, initial.split('\n').length + 1)) }, initial);
	} else {
		input = h('input', { value: initial, class: c.kind === 'text' ? '' : 'mono', placeholder: c.kind === 'timestamp' ? '2026-01-31T12:00:00Z' : c.kind === 'date' ? '2026-01-31' : '' });
	}

	const toggle_label = inserting ? (c.has_default ? 'default' : c.nullable ? 'NULL' : null) : (c.nullable ? 'NULL' : null);
	const toggle = toggle_label ? h('input', { type: 'checkbox', checked: inserting || original === null, onchange: () => { input.disabled = toggle.checked; } }) : null;
	input.disabled = Boolean(toggle?.checked);

	return {
		column: c,
		el: h('div', { class: 'field' }, label, input, toggle ? h('label', { class: 'check small' }, toggle, toggle_label) : null),
		changed: inserting
			? () => !toggle?.checked
			: () => (toggle?.checked ?? false) !== (original === null) || !toggle?.checked && input.value !== initial,
		value: () => !inserting && toggle?.checked ? null : field_value(c, input.value)
	};
}

// ---- Audit ----

function audit_table(items) {
	return h('div', { style: 'overflow-x:auto' }, h('table', null,
		h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Action'), h('th', null, 'Actor'), h('th', null, 'Entity'), h('th', null, 'Details'))),
		h('tbody', null, items.map(a => h('tr', null,
			h('td', { class: 'nowrap' }, datetime(a.created_at)),
			h('td', null, badge(a.action, a.action.includes('delete') ? 'bad' : 'info')),
			h('td', null, a.actor, a.actor_username ? h('div', { class: 'muted small' }, a.actor_username) : null),
			h('td', null, a.entity_table ? h('div', { class: 'small muted' }, a.entity_table) : null,
				a.entity_id ? (a.entity_table === 'tracks_table' || a.entity_table === 'media_table' ? link_track(a.entity_id, short_id(a.entity_id)) : h('span', { class: 'mono', title: a.entity_id }, short_id(a.entity_id))) : null),
			h('td', { style: 'min-width:280px' }, h('details', null, h('summary', { class: 'small ellipsis' }, preview(a.details)), json(a.details))))))));
}

function audit_view(main) {
	const f = { action: '', actor: '', entity_id: '' };
	let items = [];
	let has_more = false;
	const body = h('div');

	const input = (key, placeholder) => h('input', {
		placeholder, style: 'width:180px',
		oninput: (e) => { f[key] = e.target.value.trim(); },
		onkeydown: (e) => { if (e.key === 'Enter') void load(); }
	});

	const draw = () => replace(body,
		h('div', { class: 'table-wrap' }, items.length === 0 ? h('div', { class: 'empty' }, 'No entries.') : audit_table(items)),
		has_more ? h('div', { style: 'margin-top:12px' }, h('button', { onclick: () => void load(items.at(-1).id) }, 'Load more')) : null);

	async function load(before_id) {
		try {
			const data = await api('GET', `/admin/audit${qs({ ...f, before_id })}`);
			items = before_id ? items.concat(data.items) : data.items;
			has_more = data.has_more;
			draw();
		} catch (err) {
			replace(body, error_view(err));
		}
	}

	main.append(h('h1', null, 'Audit log'),
		h('div', { class: 'toolbar' },
			input('action', 'action (e.g. merge)'),
			input('actor', 'actor (admin, reconcile)'),
			input('entity_id', 'entity id'),
			h('button', { class: 'primary', onclick: () => void load() }, 'Filter')),
		body);
	void load();
}

const VIEWS = {
	status: status_view,
	logs: logs_view,
	review: review_view,
	backpack: backpack_view,
	tracks: tracks_view,
	users: users_view,
	tables: tables_view,
	audit: audit_view
};

render();
