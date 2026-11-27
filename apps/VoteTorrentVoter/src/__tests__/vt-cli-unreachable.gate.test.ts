/**
 * vt-cli-unreachable.gate.test.ts — CLI-04's by-construction proof for the Voter (67-CONTEXT "Release
 * fail-closed proof"): the token signer, the token attestation and the file vault live only in the vt CLI
 * package, and no release build of this app can reach them.
 *
 * Jest cannot prove reachability by running modules: moduleNameMapper and mocks stand in for whole packages,
 * so a forbidden edge stays invisible to any test that imports. This gate therefore walks TEXT: the static
 * import graph from the app's `index.js` and `App.tsx` (every platform variant, lazy `require`, dynamic
 * `import()` and `@votetorrent/*` workspace package through its `exports`), plus the four roots of the
 * shared workflows package. It asserts that no file of the CLI package is reached, that no specifier names
 * the CLI package (value or type-only), that no reached file carries either sentinel literal, and that no
 * package.json in the app's dependency closure lists the CLI. Planted shapes in the same file prove each
 * detector fires. The two sentinels are assembled from fragments here; see 67-25-PLAN "Sentinel naming rule".
 *
 * The bundle-level proof (an isolated Metro release bundle per app, with positive and negative controls) is
 * `scripts/assert-vt-cli-release-absence.mjs`.
 */

import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const REPO = realpathSync(resolve(__dirname, '..', '..', '..', '..'));
const APP = realpathSync(resolve(__dirname, '..', '..'));
const APP_LABEL = 'Voter';

/** The app's release entries, relative to `APP`. */
const APP_ROOTS = ['index.js', 'App.tsx'];
const WORKFLOWS_DIR = join(REPO, 'packages', 'workflows');
/** The four subpath roots of the shared package, relative to `WORKFLOWS_DIR`. Both apps walk all four. */
const WORKFLOWS_ROOTS = ['src/index.ts', 'src/authority/index.ts', 'src/voter/index.ts', 'src/platform/index.ts'];

const CLI_DIR = realpathSync(join(REPO, 'packages', 'vote-cli'));
const CLI_PACKAGE = '@votetorrent/vote-cli';

interface Sentinel {
	id: string;
	value: string;
	/** The one file (repo-relative) that holds the literal whole; test 3 pins it. */
	home: string;
}

const SENTINELS: Sentinel[] = [
	{ id: 'marker', value: 'vt-cli-token-' + 'attestation-v1', home: 'packages/vote-cli/src/attestation/marker.ts' },
	{ id: 'token-env', value: 'VT_APPROVAL_' + 'TOKEN', home: 'packages/vote-cli/src/approval/token.ts' },
];

const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
/** Metro resolves `.android`/`.ios` variants first; the walk follows every variant that exists. */
const PLATFORM_INFIXES = ['.android', '.ios', '.native', ''];
/** Resolved (visited) but never parsed. */
const TERMINAL_EXTS = [
	'.json',
	'.css',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.bmp',
	'.svg',
	'.ttf',
	'.otf',
	'.woff',
	'.woff2',
	'.mp3',
	'.mp4',
	'.wav',
];

type Read = (file: string) => string;
const readReal: Read = (f) => readFileSync(f, 'utf8');

/**
 * A TypeScript port of `scripts/lib/strip-comments.mjs`: quote-aware (single, double, backtick, backslash
 * escapes), block comments across lines, whole-line and trailing `//` comments, line count preserved. The
 * leaf guard's regex strip is NOT used: it would delete a specifier that follows a `'https://…'` string on
 * the same line (planted case g).
 */
export function stripComments(source: string): string {
	const out: string[] = [];
	let inBlock = false;
	for (const line of source.split('\n')) {
		let buf = '';
		let i = 0;
		let quote: string | null = null;
		while (i < line.length) {
			const c = line[i]!;
			const c2 = i + 1 < line.length ? line[i + 1]! : '';
			if (inBlock) {
				if (c === '*' && c2 === '/') {
					inBlock = false;
					i += 2;
					continue;
				}
				i += 1;
				continue;
			}
			if (quote !== null) {
				if (c === '\\') {
					buf += c + c2;
					i += 2;
					continue;
				}
				if (c === quote) {
					quote = null;
					buf += c;
					i += 1;
					continue;
				}
				buf += c;
				i += 1;
				continue;
			}
			if (c === '/' && c2 === '*') {
				inBlock = true;
				i += 2;
				continue;
			}
			if (c === '/' && c2 === '/') break;
			if (c === "'" || c === '"' || c === '`') {
				quote = c;
				buf += c;
				i += 1;
				continue;
			}
			buf += c;
			i += 1;
		}
		out.push(buf);
	}
	return out.join('\n');
}

/** An import/export clause: `*`, `* as ns`, `x`, `x, { … }`, `x, * as ns` or `{ … }` (multi-line allowed). */
const CLAUSE = String.raw`(?:\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}'"\x60;=()]*\}|\*\s+as\s+[\w$]+))?|\{[^}'"\x60;=()]*\})`;
const FROM_RE = new RegExp(String.raw`\b(import|export)\s+(type\s+)?${CLAUSE}\s+from\s*['"]([^'"\n]+)['"]`, 'g');
const SIDE_EFFECT_RE = /\bimport\s*['"]([^'"\n]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/**
 * Specifiers of the comment-stripped text. `value`: `import … from`, `export … from` (including `export *`
 * and `export * as ns`), side-effect `import '…'`, `require('…')` and dynamic `import('…')`. `typeOnly`:
 * `import type … from` and `export type … from`.
 */
export function specifiers(src: string): { value: string[]; typeOnly: string[] } {
	const text = stripComments(src);
	const value: string[] = [];
	const typeOnly: string[] = [];
	for (const m of text.matchAll(FROM_RE)) (m[2] === undefined ? value : typeOnly).push(m[3]!);
	for (const m of text.matchAll(SIDE_EFFECT_RE)) value.push(m[1]!);
	for (const m of text.matchAll(REQUIRE_RE)) value.push(m[1]!);
	for (const m of text.matchAll(DYNAMIC_RE)) value.push(m[1]!);
	return { value, typeOnly };
}

type PackageJson = Record<string, unknown> & { name?: string };

function readPackageJson(dir: string): PackageJson {
	return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
}

let workspaceCache: Map<string, string> | undefined;

/** Package name -> real directory, from the `package.json` of every directory under `packages/` that has a `name`. */
export function workspacePackages(): Map<string, string> {
	if (workspaceCache) return workspaceCache;
	const out = new Map<string, string>();
	const packagesDir = join(REPO, 'packages');
	for (const entry of readdirSync(packagesDir)) {
		const dir = join(packagesDir, entry);
		if (!existsSync(join(dir, 'package.json'))) continue;
		const pkg = readPackageJson(dir);
		if (typeof pkg.name === 'string') out.set(pkg.name, realpathSync(dir));
	}
	workspaceCache = out;
	return out;
}

function isFile(p: string): boolean {
	return statSync(p, { throwIfNoEntry: false })?.isFile() === true;
}

function isInside(file: string, dir: string): boolean {
	return file === dir || file.startsWith(dir + sep);
}

const relativeCache = new Map<string, string[]>();

/**
 * Every existing real file (union) for a path-like specifier: the base as given; for a `.js`/`.mjs`/`.cjs`
 * spec the same stem with `.ts`/`.tsx` (the workflows style); every `stem + infix + ext`; and `index` inside a
 * directory with the same combinations.
 */
export function resolveRelative(fromFile: string, spec: string): string[] {
	const base = resolve(dirname(fromFile), spec);
	const cached = relativeCache.get(base);
	if (cached) return cached;
	const candidates = new Set<string>([base]);
	const jsLike = /\.(js|mjs|cjs)$/;
	if (jsLike.test(base)) {
		const stem = base.replace(jsLike, '');
		candidates.add(`${stem}.ts`);
		candidates.add(`${stem}.tsx`);
	}
	for (const infix of PLATFORM_INFIXES) {
		for (const ext of CODE_EXTS) {
			candidates.add(`${base}${infix}${ext}`);
			candidates.add(join(base, `index${infix}${ext}`));
		}
	}
	const found = new Set<string>();
	for (const c of candidates) if (isFile(c)) found.add(realpathSync(c));
	const out = [...found];
	relativeCache.set(base, out);
	return out;
}

/** Every string leaf of an `exports` entry, skipping leaves under a `types` key. */
function exportLeaves(entry: unknown): string[] {
	if (typeof entry === 'string') return [entry];
	if (Array.isArray(entry)) return entry.flatMap(exportLeaves);
	if (entry && typeof entry === 'object') {
		return Object.entries(entry as Record<string, unknown>).flatMap(([k, v]) => (k === 'types' ? [] : exportLeaves(v)));
	}
	return [];
}

/**
 * Targets of a `@votetorrent/<name>[/subpath]` specifier. `undefined` for an unknown package. `files` are
 * real paths; `missing` lists `<spec> -> <package-relative target>` for a target absent on disk (an unbuilt
 * dist), so the walk fails closed instead of skipping.
 */
export function resolveWorkspace(spec: string): { files: string[]; missing: string[] } | undefined {
	const m = /^(@votetorrent\/[^/]+)(\/.+)?$/.exec(spec);
	if (!m) return undefined;
	const dir = workspacePackages().get(m[1]!);
	if (!dir) return undefined;
	const subpath = m[2] ? `.${m[2]}` : '.';
	const pkg = readPackageJson(dir);
	const exportsMap = pkg.exports;
	let targets: string[] | undefined;
	if (exportsMap !== undefined && exportsMap !== null) {
		if (typeof exportsMap === 'string') {
			if (subpath === '.') targets = [exportsMap];
		} else if (typeof exportsMap === 'object' && !Array.isArray(exportsMap) && Object.prototype.hasOwnProperty.call(exportsMap, subpath)) {
			targets = exportLeaves((exportsMap as Record<string, unknown>)[subpath]);
		}
	} else if (subpath === '.') {
		targets = ['react-native', 'module', 'main', 'source', 'browser'].map((k) => pkg[k]).filter((v): v is string => typeof v === 'string');
	}
	if (targets === undefined) {
		// A deep subpath (such as `@votetorrent/attestation-native/src/…`): resolve it as a path inside the package.
		return { files: resolveRelative(join(dir, 'x'), `.${m[2] ?? ''}`), missing: [] };
	}
	const files = new Set<string>();
	const missing: string[] = [];
	for (const t of targets) {
		const found = resolveRelative(join(dir, 'package.json'), `./${t.replace(/^\.\//, '')}`);
		if (found.length === 0) missing.push(`${spec} -> ${t}`);
		for (const f of found) files.add(f);
	}
	return { files: [...files], missing };
}

function isCliSpecifier(spec: string): boolean {
	return spec === CLI_PACKAGE || spec.startsWith(`${CLI_PACKAGE}/`);
}

function isPathLike(spec: string): boolean {
	return spec.startsWith('.') || spec.startsWith('/');
}

/**
 * Depth-first walk over real paths from `roots` (absolute). Hits: `cli-file <chain>` (a reached file inside
 * the CLI package), `cli-file <chain> -> <spec>` (a relative specifier aimed into it, whether or not the
 * target exists), `cli-specifier <chain> -> <spec>` (value or type-only), `sentinel:<id> <file>`,
 * `unbuilt <spec> -> <target>` (a workspace target missing on disk) and `unresolved <file> -> <spec>`.
 * Chains are repo-relative paths joined by ` -> `. Third-party bare specifiers are not followed: no
 * third-party package can depend on a private workspace package.
 */
export function reach(roots: string[], read: Read = readReal): { hits: string[]; visited: Set<string> } {
	const hits: string[] = [];
	const visited = new Set<string>();
	const rel = (f: string) => relative(REPO, f);
	const visit = (file: string, chain: string[]): void => {
		if (visited.has(file)) return;
		visited.add(file);
		if (isInside(file, CLI_DIR)) {
			hits.push(`cli-file ${chain.join(' -> ')}`);
			return;
		}
		if (file.endsWith('.d.ts') || !CODE_EXTS.includes(extname(file))) return;
		const raw = read(file);
		const text = stripComments(raw);
		for (const s of SENTINELS) {
			let at = text.indexOf(s.value);
			while (at !== -1) {
				hits.push(`sentinel:${s.id} ${rel(file)}`);
				at = text.indexOf(s.value, at + s.value.length);
			}
		}
		const { value, typeOnly } = specifiers(raw);
		const chainText = chain.join(' -> ');
		for (const spec of typeOnly) if (isCliSpecifier(spec)) hits.push(`cli-specifier ${chainText} -> ${spec}`);
		for (const spec of value) {
			if (isCliSpecifier(spec)) {
				hits.push(`cli-specifier ${chainText} -> ${spec}`);
				continue;
			}
			if (isPathLike(spec)) {
				if (isInside(resolve(dirname(file), spec), CLI_DIR)) {
					hits.push(`cli-file ${chainText} -> ${spec}`);
					continue;
				}
				const found = resolveRelative(file, spec);
				if (found.length === 0) {
					if (!TERMINAL_EXTS.includes(extname(spec))) hits.push(`unresolved ${rel(file)} -> ${spec}`);
					continue;
				}
				for (const f of found) visit(f, [...chain, rel(f)]);
				continue;
			}
			if (spec.startsWith('@votetorrent/')) {
				const r = resolveWorkspace(spec);
				if (!r) {
					hits.push(`unresolved ${rel(file)} -> ${spec}`);
					continue;
				}
				for (const u of r.missing) hits.push(`unbuilt ${u}`);
				if (r.files.length === 0 && r.missing.length === 0) hits.push(`unresolved ${rel(file)} -> ${spec}`);
				for (const f of r.files) visit(f, [...chain, rel(f)]);
			}
		}
	};
	for (const root of roots) {
		const real = realpathSync(root);
		visit(real, [rel(real)]);
	}
	return { hits, visited };
}

const APP_DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
/** A workspace package's devDependencies never ship, so only these fields are followed below the app. */
const SHIPPED_DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function depNames(pkg: PackageJson, field: string): string[] {
	const v = pkg[field];
	return v && typeof v === 'object' ? Object.keys(v as Record<string, unknown>) : [];
}

/**
 * `dependency <path of names>` for every `@votetorrent/vote-cli` key in the app's four dependency fields and,
 * recursively, in the shipped fields of each `@votetorrent/*` workspace package reached from them.
 */
export function dependencyClosure(pkgJsonByName: Map<string, PackageJson>, appPkg: PackageJson): string[] {
	const hits: string[] = [];
	const seen = new Set<string>();
	const walk = (pkg: PackageJson, fields: string[], path: string[]): void => {
		for (const field of fields) {
			for (const name of depNames(pkg, field)) {
				if (name === CLI_PACKAGE) {
					hits.push(`dependency ${[...path, name].join(' -> ')}`);
					continue;
				}
				if (!name.startsWith('@votetorrent/') || seen.has(name)) continue;
				seen.add(name);
				const next = pkgJsonByName.get(name);
				if (next) walk(next, SHIPPED_DEP_FIELDS, [...path, name]);
			}
		}
	};
	walk(appPkg, APP_DEP_FIELDS, [typeof appPkg.name === 'string' ? appPkg.name : 'app']);
	return hits;
}

function workspacePackageJsons(): Map<string, PackageJson> {
	const out = new Map<string, PackageJson>();
	for (const [name, dir] of workspacePackages()) out.set(name, readPackageJson(dir));
	return out;
}

const ALL_ROOTS = [...APP_ROOTS.map((r) => join(APP, r)), ...WORKFLOWS_ROOTS.map((r) => join(WORKFLOWS_DIR, r))];
const APP_TSX = realpathSync(join(APP, 'App.tsx'));
const APP_TSX_REL = relative(REPO, APP_TSX);
/** The barrel the planted `export * from` goes into; reached from `WORKFLOWS_ROOTS`. */
const PLANTED_BARREL = realpathSync(join(WORKFLOWS_DIR, 'src/voter/reads.ts'));

/** A `read` that appends `plant` to the real text of `file` and reads everything else from disk. */
function appending(file: string, plant: string): Read {
	return (f) => (f === file ? `${readReal(f)}\n${plant}\n` : readReal(f));
}

describe('vt-cli is unreachable from the Voter release graph', () => {
	it('reaches no packages/vote-cli file, no vote-cli specifier and no sentinel from index.js, App.tsx or the workflows roots', () => {
		expect(reach(ALL_ROOTS).hits).toEqual([]);
	}, 60000);

	it('the walk is not vacuous', () => {
		const { visited } = reach(ALL_ROOTS);
		expect(visited.has(APP_TSX)).toBe(true);
		expect(visited.has(realpathSync(join(APP, 'index.js')))).toBe(true);
		const rels = [...visited].map((f) => relative(REPO, f));
		expect(rels.some((f) => f.startsWith('packages/workflows/src/'))).toBe(true);
		expect(rels.some((f) => f.startsWith('packages/workflows/dist/'))).toBe(true);
		expect(rels.some((f) => f.startsWith('packages/vote-engine/'))).toBe(true);
		expect(visited.size).toBeGreaterThanOrEqual(150);
	}, 60000);

	it('each sentinel tracks its home in vote-cli', () => {
		for (const s of SENTINELS) {
			const text = stripComments(readReal(join(REPO, s.home)));
			expect(text.includes(`'${s.value}'`) || text.includes(`"${s.value}"`)).toBe(true);
		}
	}, 60000);

	it('no package.json in the app dependency closure lists @votetorrent/vote-cli', () => {
		expect(APP.endsWith(`VoteTorrent${APP_LABEL}`)).toBe(true);
		expect(dependencyClosure(workspacePackageJsons(), readPackageJson(APP))).toEqual([]);
	}, 60000);

	it('self-test: every planted shape is caught and every inert shape is not', () => {
		// (a) a relative value import into the CLI source
		const a = reach([APP_TSX], appending(APP_TSX, "import { X } from '../../packages/vote-cli/src/attestation/marker';")).hits;
		expect(a).toHaveLength(1);
		expect(a[0]!.startsWith(`cli-file ${APP_TSX_REL} -> `)).toBe(true);

		// (b) a workspace barrel re-exporting the CLI package, reached from the workflows roots
		const workflowsRoots = WORKFLOWS_ROOTS.map((r) => join(WORKFLOWS_DIR, r));
		const b = reach(workflowsRoots, appending(PLANTED_BARREL, `export * from '${CLI_PACKAGE}';`)).hits;
		expect(b).toHaveLength(1);
		expect(b[0]!.startsWith('cli-specifier ')).toBe(true);
		expect(b[0]!.endsWith(` -> ${CLI_PACKAGE}`)).toBe(true);

		// (c) a type-only import still counts
		const c = reach([APP_TSX], appending(APP_TSX, `import type { Y } from '${CLI_PACKAGE}';`)).hits;
		expect(c).toHaveLength(1);
		expect(c[0]!.startsWith('cli-specifier ')).toBe(true);
		expect(c[0]!.endsWith(` -> ${CLI_PACKAGE}`)).toBe(true);

		// (d) a lazy require of a CLI dist file, caught whether or not that file exists
		const dSpec = '../../packages/vote-cli/dist/attestation/marker.js';
		const d = reach([APP_TSX], appending(APP_TSX, `const z = require('${dSpec}');`)).hits;
		expect(d).toEqual([`cli-file ${APP_TSX_REL} -> ${dSpec}`]);

		// (e) comments are inert
		const e = reach([APP_TSX], appending(APP_TSX, `// see packages/vote-cli for the CLI\n/* import '${CLI_PACKAGE}' */`)).hits;
		expect(e).toEqual([]);

		// (f) the whole sentinel is caught; the two-fragment form is not
		const marker = SENTINELS[0]!;
		const f1 = reach([APP_TSX], appending(APP_TSX, `const s = '${marker.value}';`)).hits;
		expect(f1).toEqual([`sentinel:${marker.id} ${APP_TSX_REL}`]);
		const cut = marker.value.indexOf('attestation-v1');
		expect(cut).toBeGreaterThan(0);
		const fragmentForm = `const s = '${marker.value.slice(0, cut)}' + '${marker.value.slice(cut)}';`;
		expect(fragmentForm.includes(marker.value)).toBe(false);
		expect(reach([APP_TSX], appending(APP_TSX, fragmentForm)).hits).toEqual([]);

		// (g) a specifier that follows a URL string on the same line survives the quote-aware strip
		const gSpec = '../../packages/vote-cli/dist/approval/token.js';
		const g = reach([APP_TSX], appending(APP_TSX, `const u = 'https://example.invalid/x'; const w = require('${gSpec}');`)).hits;
		expect(g).toEqual([`cli-file ${APP_TSX_REL} -> ${gSpec}`]);

		// (h) an unresolved relative import is a hit, never a silent stop
		const h = reach([APP_TSX], appending(APP_TSX, "import './does-not-exist-vt25';")).hits;
		expect(h).toEqual([`unresolved ${APP_TSX_REL} -> ./does-not-exist-vt25`]);

		// (i) the CLI in the app's dependencies is a hit; in a workspace package's devDependencies it is not
		const appPkg = readPackageJson(APP);
		const planted: PackageJson = { ...appPkg, dependencies: { ...(appPkg.dependencies as Record<string, string>), [CLI_PACKAGE]: 'workspace:*' } };
		const iHits = dependencyClosure(workspacePackageJsons(), planted);
		expect(iHits).toHaveLength(1);
		expect(iHits[0]!.startsWith('dependency ')).toBe(true);
		expect(iHits[0]!.endsWith(` -> ${CLI_PACKAGE}`)).toBe(true);
		const byName = workspacePackageJsons();
		const workflowsPkg = byName.get('@votetorrent/workflows')!;
		expect(workflowsPkg).toBeDefined();
		byName.set('@votetorrent/workflows', { ...workflowsPkg, devDependencies: { ...((workflowsPkg.devDependencies as Record<string, string> | undefined) ?? {}), [CLI_PACKAGE]: 'workspace:*' } });
		expect(dependencyClosure(byName, appPkg)).toEqual([]);

		// (j) type-only statements yield no value specifier
		expect(specifiers("import type { A } from './a';\nexport type { B } from './b';").value).toEqual([]);
	}, 60000);

	it('this gate file carries neither sentinel whole', () => {
		const raw = readFileSync(__filename, 'utf8');
		for (const s of SENTINELS) expect(raw.indexOf(s.value)).toBe(-1);
	}, 60000);
});
