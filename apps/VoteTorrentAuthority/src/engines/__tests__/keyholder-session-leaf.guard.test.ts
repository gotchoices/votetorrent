/**
 * keyholder-session-leaf.guard.test.ts — the keyholder modules the `vt` CLI (`packages/vote-cli`) loads under plain Node
 * (keyholder-accept, keyholder-dkg-driver, key-release-ceremony, keyholder-identity) must
 * never VALUE-import, directly or through a relative import, anything that pulls in the native module or
 * react-native. bcbf1902 broke the driver that way: the callers imported `withKeyholderSession` from
 * `keyholder-seat-vault.ts`, which value-imports `./key-vault` -> `@votetorrent/attestation-native`.
 *
 * Jest cannot catch it by running the modules (moduleNameMapper and mocks supply react-native), so this walks
 * the static import graph. `import type` / `export type` are erased at compile time and are skipped.
 *
 * Phase 67 (plans 05 and 14): the three drivers and the four leaf modules now live in `@votetorrent/workflows`
 * (`packages/workflows/src/authority/`), and the app paths are thin bindings that only supply the app's store.
 * The guard therefore walks the SHARED files as its roots (the CLI keyholder daemon loads them under plain Node,
 * with no hook): `.js` specifiers resolve to `.ts`, an unresolved relative import is a hit, any file reached
 * outside `packages/workflows/src` is a hit, the reached set is pinned exactly, and each binding's value
 * specifiers are pinned exactly. The shared package's own purity spec (67-04) guards the rest of
 * `packages/workflows/src`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..', '..');
/** `apps/VoteTorrentAuthority/src` -> the repository root. */
const REPO = resolve(SRC, '..', '..', '..');
/** The shared package's authority sources. */
const WORKFLOWS_AUTHORITY = join(REPO, 'packages/workflows/src/authority');
/** Every file a root may reach relatively must live under this repo-relative prefix. */
const SHARED_SRC_PREFIX = 'packages/workflows/src/';

const ROOTS = [
	'packages/workflows/src/authority/keyholder-accept.ts',
	'packages/workflows/src/authority/keyholder-dkg-driver.ts',
	'packages/workflows/src/authority/key-release-ceremony.ts',
	'packages/workflows/src/authority/keyholder-identity.ts',
];

/** Packages Node cannot load on the host, or that would make the shared code depend on the CLI. */
const FORBIDDEN_PACKAGES = [
	'@votetorrent/attestation-native',
	'react-native',
	'@react-native-async-storage/async-storage',
	'rn-leveldb',
	'@quereus/plugin-react-native-leveldb',
	'@votetorrent/vote-cli',
];
/** The whole react-native family. */
const FORBIDDEN_PREFIXES = ['@react-native-', '@react-native/'];

const APP_DRIVER_BINDINGS = [
	'screens/keyholder/keyholder-accept.ts',
	'screens/keyholder/keyholder-dkg-driver.ts',
	'screens/keyholder/key-release-ceremony.ts',
];

function strip(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
}

/** Value specifiers only: `import x from`, `import {..} from`, `import '..'`, `export {..} from`, `require('..')`. */
export function valueSpecifiers(src: string): string[] {
	const text = strip(src);
	const out: string[] = [];
	for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
		if (m[2] !== undefined) continue;
		out.push(m[4]!);
	}
	for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
	for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
	return out;
}

function isForbiddenPackage(spec: string): boolean {
	return FORBIDDEN_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`)) || FORBIDDEN_PREFIXES.some((p) => spec.startsWith(p));
}

/** Tries the bare path, `.ts`, `.tsx`, `index.ts`, and a trailing `.js` rewritten to `.ts` (ESM sources). */
function resolveRelative(fromFile: string, spec: string): string | undefined {
	const base = resolve(dirname(fromFile), spec);
	const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
	if (base.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'));
	for (const candidate of candidates) {
		if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
	}
	return undefined;
}

/**
 * Walks the value-import graph from `roots` (repo-relative). `hits` are `<chain> -> <target>` strings: a
 * forbidden package, a relatively reached file outside `packages/workflows/src/` (such as the app's
 * `engines/key-vault.ts`, `engines/keyholder-seat-vault.ts` or `utils/dismissKeyboardForSystemPrompt.ts`),
 * or `<chain> -> UNRESOLVED <spec>` for a relative import that resolves to no file (fail closed: an
 * unresolvable edge can never shorten the walk silently). `visited` is every file reached, sorted.
 */
export function walkValueGraph(roots: string[], read: (file: string) => string = (f) => readFileSync(f, 'utf8')): { hits: string[]; visited: string[] } {
	const hits: string[] = [];
	const seen = new Set<string>();
	const walk = (file: string, chain: string[]) => {
		if (seen.has(file)) return;
		seen.add(file);
		const rel = relative(REPO, file);
		if (!rel.startsWith(SHARED_SRC_PREFIX)) {
			hits.push(chain.join(' -> '));
			return;
		}
		for (const spec of valueSpecifiers(read(file))) {
			if (isForbiddenPackage(spec)) {
				hits.push([...chain, spec].join(' -> '));
				continue;
			}
			if (!spec.startsWith('.')) continue;
			const target = resolveRelative(file, spec);
			if (target === undefined) {
				hits.push(`${chain.join(' -> ')} -> UNRESOLVED ${spec}`);
				continue;
			}
			walk(target, [...chain, relative(REPO, target)]);
		}
	};
	for (const r of roots) walk(join(REPO, r), [r]);
	return { hits, visited: [...seen].map((f) => relative(REPO, f)).sort() };
}

/** Every forbidden hit reachable from `roots`, as `<chain> -> <target>`. */
export function forbiddenReach(roots: string[], read?: (file: string) => string): string[] {
	return walkValueGraph(roots, read).hits;
}

const SHARED_DKG_DRIVER = join(WORKFLOWS_AUTHORITY, 'keyholder-dkg-driver.ts');
const SHARED_DKG_DRIVER_ROOT = 'packages/workflows/src/authority/keyholder-dkg-driver.ts';

describe('host-loaded keyholder modules stay Node-loadable', () => {
	it('no shared root reaches react-native, AsyncStorage, the native module or any app file through a value import', () => {
		expect(forbiddenReach(ROOTS)).toEqual([]);
	});

	it('the walk reaches exactly the shared keyholder files', () => {
		expect(walkValueGraph(ROOTS).visited).toEqual(
			[
				'invite-share.ts',
				'key-release-ceremony.ts',
				'keyholder-accept.ts',
				'keyholder-deps.ts',
				'keyholder-dkg-driver.ts',
				'keyholder-identity.ts',
				'keyholder-session.ts',
				'peer-read-unavailable.ts',
			]
				.map((f) => `packages/workflows/src/authority/${f}`)
				.sort()
		);
	});

	it('app driver bindings value-import only AsyncStorage and the shared package', () => {
		for (const binding of APP_DRIVER_BINDINGS) {
			expect([...new Set(valueSpecifiers(readFileSync(join(SRC, binding), 'utf8')))].sort()).toEqual([
				'@react-native-async-storage/async-storage',
				'@votetorrent/workflows/authority',
			]);
		}
	});

	it('shared keyholder-session.ts has no value import at all', () => {
		expect(valueSpecifiers(readFileSync(join(WORKFLOWS_AUTHORITY, 'keyholder-session.ts'), 'utf8'))).toEqual([]);
	});

	it('app keyholder-session.ts binding value-imports only @votetorrent/workflows/authority', () => {
		expect(valueSpecifiers(readFileSync(join(SRC, 'engines/keyholder-session.ts'), 'utf8'))).toEqual(['@votetorrent/workflows/authority']);
	});

	it('app keyholder-identity.ts binding value-imports only AsyncStorage and the shared package', () => {
		expect([...new Set(valueSpecifiers(readFileSync(join(SRC, 'engines/keyholder-identity.ts'), 'utf8')))].sort()).toEqual([
			'@react-native-async-storage/async-storage',
			'@votetorrent/workflows/authority',
		]);
	});

	it('self-test: a value import planted into the shared keyholder-session.ts text is caught', () => {
		const sharedSession = readFileSync(join(WORKFLOWS_AUTHORITY, 'keyholder-session.ts'), 'utf8');
		expect(valueSpecifiers(sharedSession)).toEqual([]);
		const plantedShared = "import { putSecret } from './keyholder-seat-vault.js'\n" + sharedSession;
		expect(valueSpecifiers(plantedShared)).toEqual(['./keyholder-seat-vault.js']);
	});

	it('self-test: the bcbf1902 import shape is caught across the package boundary, and a type-only import is not', () => {
		const real = readFileSync(SHARED_DKG_DRIVER, 'utf8');
		const planted = real.replace("from './keyholder-session.js'", "from '../../../../apps/VoteTorrentAuthority/src/engines/keyholder-seat-vault.js'");
		expect(planted).not.toBe(real);
		const readPlanted = (f: string) => (f === SHARED_DKG_DRIVER ? planted : readFileSync(f, 'utf8'));
		expect(forbiddenReach([SHARED_DKG_DRIVER_ROOT], readPlanted)).toEqual([
			'packages/workflows/src/authority/keyholder-dkg-driver.ts -> apps/VoteTorrentAuthority/src/engines/keyholder-seat-vault.ts',
		]);
		expect(valueSpecifiers("import type { X } from './key-vault';\nexport type { Y } from './key-vault';")).toEqual([]);
	});

	it('self-test: an AsyncStorage import planted into the shared dkg driver is caught', () => {
		const real = readFileSync(SHARED_DKG_DRIVER, 'utf8');
		const planted = "import AsyncStorage from '@react-native-async-storage/async-storage'\n" + real;
		const readPlanted = (f: string) => (f === SHARED_DKG_DRIVER ? planted : readFileSync(f, 'utf8'));
		const hits = forbiddenReach([SHARED_DKG_DRIVER_ROOT], readPlanted);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.endsWith(' -> @react-native-async-storage/async-storage')).toBe(true);
	});

	it('self-test: an unresolved relative import planted into the shared dkg driver is a hit, never a silent stop', () => {
		const real = readFileSync(SHARED_DKG_DRIVER, 'utf8');
		const planted = "import { x } from './does-not-exist.js'\n" + real;
		const readPlanted = (f: string) => (f === SHARED_DKG_DRIVER ? planted : readFileSync(f, 'utf8'));
		const hits = forbiddenReach([SHARED_DKG_DRIVER_ROOT], readPlanted);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toContain('UNRESOLVED ./does-not-exist.js');
	});

	it('self-test: the two-line no-semicolon shape keeps a type import out and a value import in', () => {
		expect(valueSpecifiers("import type { A } from './a.js'\nimport { b } from './b.js'")).toEqual(['./b.js']);
	});
});
