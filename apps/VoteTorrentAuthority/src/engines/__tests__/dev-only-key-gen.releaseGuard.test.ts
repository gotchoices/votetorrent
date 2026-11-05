/**
 * dev-only-key-gen.releaseGuard.test.ts — D-12 source-shape guard (Phase 49).
 *
 * Mirrors `attestation-keys.secretGuard.test.ts`'s convention: reads the file as TEXT rather
 * than importing it, so it fails on what is ACTUALLY on disk (and therefore what `git add`
 * would stage / what Metro would bundle), not on what some build step might have substituted.
 *
 * This test proves only the SOURCE SHAPE: that `device-user.ts` references
 * `dev-only-key-gen.ts` exactly once, via a CommonJS `require()` lexically nested inside a
 * literal `if (__DEV__)` block, and that no other file under
 * `apps/VoteTorrentAuthority/src` references it at all. It does NOT prove bundle absence — that
 * is 49-13's release-bundle grep for `DEV_ONLY_PLAINTEXT_KEYGEN_FINGERPRINT_49`, which this test
 * cannot substitute for.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const SRC_ROOT = path.join(__dirname, '../..');
const DEVICE_USER_PATH = path.join(__dirname, '../device-user.ts');
const DEV_ONLY_KEY_GEN_PATH = path.join(__dirname, '../dev-only-key-gen.ts');

describe('D-12 source-shape guard: dev-only-key-gen.ts is reachable only via a __DEV__-lexically-guarded require', () => {
	const deviceUserSource = fs.readFileSync(DEVICE_USER_PATH, 'utf8');

	it('device-user.ts has no static `import` referencing dev-only-key-gen', () => {
		const importLines = deviceUserSource
			.split('\n')
			.filter((line) => /^import.*dev-only-key-gen/.test(line));
		expect(importLines).toEqual([]);
	});

	it('device-user.ts references dev-only-key-gen exactly once, via require(...)', () => {
		const requireMatches = deviceUserSource.match(/require\('\.\/dev-only-key-gen'\)/g) ?? [];
		expect(requireMatches).toHaveLength(1);
	});

	it('the require(...) call is lexically nested inside a literal `if (__DEV__)` block', () => {
		const requireIndex = deviceUserSource.indexOf("require('./dev-only-key-gen')");
		expect(requireIndex).toBeGreaterThan(-1);
		// The nearest preceding `if (__DEV__)` within the same function body must appear BEFORE
		// the require call, with no intervening closing brace at the same nesting level that
		// would take us back out of that block. A precise brace-matcher is unnecessary here: the
		// function this require lives in (`generateSoftwareKeyForDev`) contains exactly one
		// `if (__DEV__)` and the require is its first statement, so a simple "appears before, and
		// is the nearest one" check is sufficient and matches this file's actual shape.
		const guardIndex = deviceUserSource.lastIndexOf('if (__DEV__)', requireIndex);
		expect(guardIndex).toBeGreaterThan(-1);
		expect(guardIndex).toBeLessThan(requireIndex);
		// No literal top-level `if (__DEV__) {` closing brace (a bare `}` at column 0) between the
		// guard and the require — i.e. the require is still inside that same block.
		const between = deviceUserSource.slice(guardIndex, requireIndex);
		expect(between).not.toMatch(/\n}\n/);
	});

	it('dev-only-key-gen.ts exports generateSoftwareDeviceKey and the fingerprint constant', () => {
		const devOnlySource = fs.readFileSync(DEV_ONLY_KEY_GEN_PATH, 'utf8');
		expect(devOnlySource).toMatch(/export function generateSoftwareDeviceKey/);
		const fingerprintMatches = devOnlySource.match(/DEV_ONLY_PLAINTEXT_KEYGEN_FINGERPRINT_49/g) ?? [];
		expect(fingerprintMatches.length).toBeGreaterThanOrEqual(2);
	});

	it('no other file under apps/VoteTorrentAuthority/src references dev-only-key-gen', () => {
		// ripgrep/grep -r over the app's src tree, excluding this test file and device-user.ts
		// (both intentional, asserted above) and dev-only-key-gen.ts itself (self-reference from
		// its own file header comment does not count).
		const output = execSync(
			`grep -rln "dev-only-key-gen" "${SRC_ROOT}" --include="*.ts" --include="*.tsx"`,
			{ encoding: 'utf8' },
		);
		const files = output
			.split('\n')
			.filter(Boolean)
			.map((f) => path.relative(SRC_ROOT, f));
		const allowed = new Set([
			path.relative(SRC_ROOT, DEVICE_USER_PATH),
			path.relative(SRC_ROOT, DEV_ONLY_KEY_GEN_PATH),
			path.relative(SRC_ROOT, path.join(__dirname, 'dev-only-key-gen.releaseGuard.test.ts')),
			// 49-16: this suite's own D-12 boundary re-check duplicates this guard's assertion, so
			// it necessarily contains the literal string too — an intentional second witness, not a
			// violation.
			path.relative(SRC_ROOT, path.join(__dirname, 'device-user.provisioning.test.ts')),
		]);
		const unexpected = files.filter((f) => !allowed.has(f));
		expect(unexpected).toEqual([]);
	});
});
