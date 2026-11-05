/**
 * hermes-buffer-global.spec.ts — CR-01 (51-REVIEW) regression lock: no source file under
 * `packages/vote-engine/src` may reference the `Buffer` identifier without importing it.
 *
 * `Buffer` is NOT a Hermes global. `metro.config.js` aliases the `buffer` / `node:buffer`
 * SPECIFIERS, which only helps an EXPLICIT import — nothing anywhere in the bundled trees
 * assigns `global.Buffer` / `globalThis.Buffer`. This codebase already states the rule in
 * `apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts`:
 *
 *   "`Buffer` MUST be imported explicitly from the `buffer` module — it is NOT a Hermes global"
 *
 * A bare `Buffer.from(...)` therefore raises `ReferenceError: Buffer is not defined` on device.
 * In the attestation verifiers that ReferenceError is swallowed by the outer FAIL-CLOSED
 * `catch`, so the symptom is not a crash but "every genuine attestation is rejected, with a
 * reason that blames the device" — silent on Node, fatal on hardware.
 *
 * Jest/mocha cannot see this class at runtime because Node HAS a global `Buffer`; the only
 * gate that can is a static one, which is what this file is. It is the same lock class as
 * `schema-type-regression.spec.ts` (scan the artifact, fail CI on the forbidden shape).
 *
 * The fix for a violation is ONE of:
 *   - add `import { Buffer } from 'buffer'` (the convention in `play-integrity-verifier.ts`,
 *     `key-provider.ts`, `app-attest-verifier.ts`, `verifiers/app-identity.ts`,
 *     `verifiers/key-attestation.ts`), or
 *   - drop `Buffer` entirely where it was only adapting bytes — e.g. `timingSafeEqual`
 *     accepts any ArrayBufferView on Node and the RN shim indexes `a[i]`, so a plain
 *     `Uint8Array` is correct on both runtimes.
 */

import { expect } from 'chai'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = join(testDir, '../src')

function collectTypeScriptFiles (dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			out.push(...collectTypeScriptFiles(full))
		} else if (entry.endsWith('.ts')) {
			out.push(full)
		}
	}
	return out
}

/**
 * Strip the lexical contexts in which the word `Buffer` is NOT an identifier reference:
 * block comments, line comments, and single-quoted / template string literals. Double-quoted
 * strings are not stripped — this codebase quotes with single quotes, and leaving them in
 * only makes the lock stricter, never looser.
 */
function stripNonCode (source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '')
		.replace(/'(?:\\.|[^'\\])*'/g, "''")
		.replace(/`(?:\\.|[^`\\])*`/g, '``')
}

/** `\bBuffer\b` deliberately does NOT match `ArrayBuffer` / `SharedArrayBuffer` (no word boundary). */
const BUFFER_IDENTIFIER = /\bBuffer\b/
const BUFFER_IMPORT = /import\s*\{[^}]*\bBuffer\b[^}]*\}\s*from\s*'(?:node:)?buffer'/

describe('Hermes Buffer-global regression lock (CR-01, 51-REVIEW)', () => {
	it('every vote-engine source file that references `Buffer` imports it explicitly', () => {
		const violations: string[] = []

		for (const file of collectTypeScriptFiles(SRC_ROOT)) {
			const source = readFileSync(file, 'utf8')
			if (!BUFFER_IDENTIFIER.test(stripNonCode(source))) continue
			if (BUFFER_IMPORT.test(source)) continue
			violations.push(relative(SRC_ROOT, file))
		}

		expect(
			violations,
			`${violations.length} file(s) reference the \`Buffer\` identifier with no \`import { Buffer } from 'buffer'\`.\n` +
			'`Buffer` is NOT a Hermes global, so each of these throws `ReferenceError: Buffer is not defined` on\n' +
			'device while every Node test passes. Add the explicit import, or drop `Buffer` at the call site:\n  ' +
			violations.join('\n  ')
		).to.deep.equal([])
	})

	it('the three Phase 51 attestation verifiers are covered by the lock', () => {
		// Guards against the lock silently going vacuous if these files move or are renamed:
		// the CR-01 defect lived in exactly these three, so they must be in the scanned set.
		const scanned = collectTypeScriptFiles(SRC_ROOT).map(f => relative(SRC_ROOT, f))
		for (const expected of [
			join('association', 'verifiers', 'app-attest.ts'),
			join('association', 'verifiers', 'app-attest-assertion.ts'),
			join('association', 'verifiers', 'key-attestation.ts')
		]) {
			expect(scanned, `${expected} is not in the scanned set — the CR-01 lock has gone vacuous`).to.include(expected)
		}
	})
})
