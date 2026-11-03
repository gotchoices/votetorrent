/**
 * keyholder-session-leaf.guard.test.ts — the keyholder modules the host lean driver loads under plain Node
 * (64-lean `lean-part2.ts`: keyholder-accept, keyholder-dkg-driver, key-release-ceremony, keyholder-identity) must
 * never VALUE-import, directly or through a relative import, anything that pulls in the native module or
 * react-native. bcbf1902 broke the driver that way: the callers imported `withKeyholderSession` from
 * `keyholder-seat-vault.ts`, which value-imports `./key-vault` -> `@votetorrent/attestation-native`.
 *
 * Jest cannot catch it by running the modules (moduleNameMapper and mocks supply react-native), so this walks
 * the static import graph. `import type` / `export type` are erased at compile time and are skipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..', '..');

const ROOTS = [
	'screens/keyholder/keyholder-accept.ts',
	'screens/keyholder/keyholder-dkg-driver.ts',
	'screens/keyholder/key-release-ceremony.ts',
	'engines/keyholder-identity.ts',
];

/** Packages Node cannot load on the host. */
const FORBIDDEN_PACKAGES = ['@votetorrent/attestation-native', 'react-native'];
/** App files that value-import the native module or react-native. */
const FORBIDDEN_FILES = ['engines/key-vault.ts', 'engines/keyholder-seat-vault.ts', 'utils/dismissKeyboardForSystemPrompt.ts'];

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

function resolveRelative(fromFile: string, spec: string): string | undefined {
	const base = resolve(dirname(fromFile), spec);
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
		if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
	}
	return undefined;
}

/** Every forbidden hit reachable from `roots`, as `<chain> -> <target>`. */
export function forbiddenReach(roots: string[], read: (file: string) => string = (f) => readFileSync(f, 'utf8')): string[] {
	const hits: string[] = [];
	const seen = new Set<string>();
	const walk = (file: string, chain: string[]) => {
		if (seen.has(file)) return;
		seen.add(file);
		const rel = relative(SRC, file);
		if (FORBIDDEN_FILES.includes(rel)) {
			hits.push(chain.join(' -> '));
			return;
		}
		for (const spec of valueSpecifiers(read(file))) {
			if (FORBIDDEN_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
				hits.push([...chain, spec].join(' -> '));
				continue;
			}
			if (!spec.startsWith('.')) continue;
			const target = resolveRelative(file, spec);
			if (target !== undefined) walk(target, [...chain, relative(SRC, target)]);
		}
	};
	for (const r of roots) walk(join(SRC, r), [r]);
	return hits;
}

describe('host-loaded keyholder modules stay Node-loadable', () => {
	it('no root reaches the native module, react-native, key-vault or the seat vault through a value import', () => {
		expect(forbiddenReach(ROOTS)).toEqual([]);
	});

	it('keyholder-session.ts has no value import at all', () => {
		expect(valueSpecifiers(readFileSync(join(SRC, 'engines/keyholder-session.ts'), 'utf8'))).toEqual([]);
	});

	it('self-test: the bcbf1902 import shape is caught, and a type-only import is not', () => {
		const driver = join(SRC, 'screens/keyholder/keyholder-dkg-driver.ts');
		const real = readFileSync(driver, 'utf8');
		const planted = real.replace("from '../../engines/keyholder-session'", "from '../../engines/keyholder-seat-vault'");
		expect(planted).not.toBe(real);
		const readPlanted = (f: string) => (f === driver ? planted : readFileSync(f, 'utf8'));
		expect(forbiddenReach(['screens/keyholder/keyholder-dkg-driver.ts'], readPlanted)).toEqual([
			'screens/keyholder/keyholder-dkg-driver.ts -> engines/keyholder-seat-vault.ts',
		]);
		expect(valueSpecifiers("import type { X } from './key-vault';\nexport type { Y } from './key-vault';")).toEqual([]);
	});
});
