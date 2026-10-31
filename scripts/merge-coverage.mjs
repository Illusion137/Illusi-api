// Merges line coverage of the unit run, the in-process integration run and the API process (all istanbul json) and
// fails when a file under src/ is below the threshold. Usage: node scripts/merge-coverage.mjs [dir] [threshold]
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv.slice(2).find(a => !a.startsWith('--') && Number.isNaN(Number(a))) ?? 'coverage-merged';
const threshold = Number(process.argv.slice(2).find(a => a !== '--lines' && !Number.isNaN(Number(a))) ?? 80);
const root = process.cwd() + path.sep;
const lines = new Map(); // file -> Map(line -> covered)

for (const part of ['unit', 'inproc', 'api'] /* api last */) {
	const file = path.join(dir, part, 'coverage-final.json');
	if (!existsSync(file)) { console.warn(`missing ${file}`); continue; }
	for (const [abs, cov] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
		const rel = path.isAbsolute(abs) ? abs.replace(root, '') : abs;
		if (!rel.startsWith('src/') || rel.endsWith('.test.ts')) continue;
		// The API process (c8) only marks lines the vitest runs know about: its line numbers include unmapped generated code.
		if (part === 'api' && !lines.has(rel)) continue;
		const map = lines.get(rel) ?? new Map();
		for (const [id, loc] of Object.entries(cov.statementMap)) {
			const n = loc.start.line;
			if (part === 'api' && !map.has(n)) continue;
			map.set(n, (map.get(n) ?? false) || cov.s[id] > 0);
		}
		lines.set(rel, map);
	}
}

let total = 0, covered = 0;
const rows = [];
for (const [file, map] of lines) {
	const c = [...map.values()].filter(Boolean).length;
	total += map.size; covered += c;
	rows.push([file, map.size, map.size ? (100 * c / map.size) : 100, [...map].filter(([, ok]) => !ok).map(([n]) => n).sort((a, b) => a - b)]);
}
rows.sort((a, b) => a[2] - b[2]);
const detail = process.argv.includes('--lines');
for (const [f, n, p, miss] of rows) if (p < 100) console.log(`${p.toFixed(1).padStart(6)}%  ${String(n).padStart(4)} lines  ${f}${detail ? `\n        uncovered: ${miss.join(',')}` : ''}`);
console.log(`\nTotal ${(100 * covered / total).toFixed(2)}% of ${total} lines`);
const bad = rows.filter(r => r[2] < threshold);
if (bad.length) { console.error(`${bad.length} file(s) below ${threshold}%`); process.exit(1); }
