/**
 * ios-wrap-key-read.gate.test.ts — source contract over the iOS secret-wrap Swift.
 *
 * What it pins (there is no XCTest target and no runnable Swift harness in this repo, so the decision
 * logic is held in place by reading the source):
 *  - unwrapSecret never creates a wrap key (parity with Android SecretWrapHelper.unwrap): it calls the
 *    loader with `createIfMissing: false` and contains no SecItemAdd.
 *  - the loader's create branch (SecRandomCopyBytes + SecItemAdd) is guarded by `createIfMissing`.
 *  - a nil policy marker must NOT throw NO_WRAP_KEY early: the data read decides, so an existing item
 *    whose marker read spuriously returned nil is decrypted, never reported replaceable.
 *  - with a nil marker on unwrap, the loader still learns whether the item exists, through a no-UI
 *    attributes-only probe, so an invalidated item reads as KEY_INVALIDATED, never as the
 *    replaceable NO_WRAP_KEY (REVIEW WR-R4-06).
 *  - the Keychain prompt reason is the caller's promptSubtitle, never a blank literal.
 *  - the KEY_INVALIDATED and WRAP_KEY_POLICY_MISMATCH branches are still present.
 *
 * Extraction runs on comment-stripped text; the checker is pure so the planted self-tests prove the
 * gate can fail.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function stripCommentsPreservingLines(src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const SWIFT_PATH = join(REPO_ROOT, 'packages', 'attestation-native', 'ios', 'AttestationNativeModule.swift')

/** Brace-matched body of `func <name>(`, or undefined. Swift signatures here contain no braces. */
function funcBody(src: string, name: string): string | undefined {
	const head = src.indexOf(`func ${name}(`)
	if (head < 0) return undefined
	const open = src.indexOf('{', head)
	if (open < 0) return undefined
	let depth = 0
	for (let i = open; i < src.length; i++) {
		const ch = src[i]
		if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) return src.slice(open, i + 1)
		}
	}
	return undefined
}

function checkIosWrapKeyRead(rawSwift: string): string[] {
	const swift = stripCommentsPreservingLines(rawSwift)
	const out: string[] = []

	const unwrap = funcBody(swift, 'unwrapSecret')
	const wrap = funcBody(swift, 'wrapSecret')
	const loader = funcBody(swift, 'loadWrapKey')
	if (!unwrap) out.push('unwrapSecret body not found')
	if (!wrap) out.push('wrapSecret body not found')
	if (!loader) out.push('loadWrapKey body not found')

	if (unwrap) {
		if (!/loadWrapKey\([^)]*createIfMissing:\s*false/.test(unwrap)) out.push('unwrapSecret must call loadWrapKey with createIfMissing: false')
		if (unwrap.includes('SecItemAdd')) out.push('unwrapSecret must not contain SecItemAdd')
		if (!/loadWrapKey\([^)]*reason:\s*promptSubtitle/.test(unwrap)) out.push('unwrapSecret must pass reason: promptSubtitle')
	}
	if (wrap) {
		if (!/loadWrapKey\([^)]*createIfMissing:\s*true/.test(wrap)) out.push('wrapSecret must call loadWrapKey with createIfMissing: true')
		if (!/loadWrapKey\([^)]*reason:\s*promptSubtitle/.test(wrap)) out.push('wrapSecret must pass reason: promptSubtitle')
	}

	if (loader) {
		const marker = loader.indexOf('readWrapKeyPolicyMarker(')
		const rand = loader.indexOf('SecRandomCopyBytes')
		const add = loader.indexOf('SecItemAdd')
		const dataRead = loader.indexOf('SecItemCopyMatching(readQuery')
		if (marker < 0) out.push('loader must read the policy marker')
		if (rand < 0 || add < 0) out.push('loader create branch (SecRandomCopyBytes + SecItemAdd) not found')
		const guard = /(else\s+if|if)\s+createIfMissing\b/.exec(loader)
		if (!guard) out.push('loader create branch must be guarded by createIfMissing')
		else if (rand >= 0 && guard.index > rand) out.push('createIfMissing guard must precede SecRandomCopyBytes')
		if (marker >= 0 && dataRead >= 0) {
			if (loader.slice(marker, dataRead).includes('NO_WRAP_KEY')) {
				out.push('NO_WRAP_KEY must not be thrown between the marker read and the data read (a nil marker must reach the data read)')
			}
		} else if (dataRead < 0) {
			out.push('loader data read (SecItemCopyMatching(readQuery) not found')
		}
		const probeCall = /itemExisted\s*=\s*wrapKeyItemExists\(/.exec(loader)
		if (!probeCall) out.push('loader must set itemExisted from wrapKeyItemExists on a nil marker')
		else if (dataRead >= 0 && probeCall.index > dataRead) out.push('the existence probe must run before the data read')
		if (!loader.includes('KEY_INVALIDATED')) out.push('loader lost the KEY_INVALIDATED branch')
		if (!loader.includes('WRAP_KEY_POLICY_MISMATCH')) out.push('loader lost the WRAP_KEY_POLICY_MISMATCH refusal')
		if (!loader.includes('NO_WRAP_KEY')) out.push('loader lost the NO_WRAP_KEY branch')
		if (/localizedReason\s*=\s*""/.test(loader)) out.push('localizedReason is a blank literal')
		if (!/localizedReason\s*=\s*reason\b/.test(loader)) out.push('localizedReason must be assigned from the reason parameter')
	}
	const probe = funcBody(swift, 'wrapKeyItemExists')
	if (!probe) out.push('wrapKeyItemExists body not found')
	else {
		if (probe.includes('kSecReturnData')) out.push('the existence probe must not read the item data')
		if (!probe.includes('kSecReturnAttributes')) out.push('the existence probe must ask for attributes only')
		if (!/interactionNotAllowed\s*=\s*true/.test(probe)) out.push('the existence probe must never show UI (interactionNotAllowed = true)')
		if (!probe.includes('errSecInteractionNotAllowed')) out.push('the existence probe must count errSecInteractionNotAllowed as present')
	}
	return out
}

function loadSwift(): string {
	return readFileSync(SWIFT_PATH, 'utf8')
}

describe('iOS secret-wrap read contract (unwrap never creates; reason forwarded)', () => {
	it('the real Swift satisfies the contract', () => {
		expect(checkIosWrapKeyRead(loadSwift())).toEqual([])
	})

	describe('planted self-tests: the gate can fail', () => {
		it('unwrapSecret asking for creation is reported', () => {
			const src = loadSwift()
			const unwrapAt = src.indexOf('func unwrapSecret(')
			const planted = src.slice(0, unwrapAt) + src.slice(unwrapAt).replace('createIfMissing: false', 'createIfMissing: true')
			expect(planted).not.toBe(src)
			expect(checkIosWrapKeyRead(planted).some((p) => p.includes('createIfMissing: false'))).toBe(true)
		})

		it('a blank localizedReason is reported', () => {
			const src = loadSwift()
			// Anchored at the loader: the device-key sign path sets its own localizedReason earlier in the file.
			const loaderAt = src.indexOf('func loadWrapKey(')
			const planted = src.slice(0, loaderAt) + src.slice(loaderAt).replace(/localizedReason = reason\b/, 'localizedReason = ""')
			expect(planted).not.toBe(src)
			expect(checkIosWrapKeyRead(planted).some((p) => p.includes('localizedReason'))).toBe(true)
		})

		it('an early NO_WRAP_KEY throw on a nil marker is reported', () => {
			const src = loadSwift()
			const planted = src.replace(
				'var itemExisted = false',
				'var itemExisted = false\n    if !createIfMissing && readWrapKeyPolicyMarker(alias: alias) == nil { throw SecretWrapNativeError.code("NO_WRAP_KEY", "x") }',
			)
			expect(planted).not.toBe(src)
			expect(checkIosWrapKeyRead(planted).some((p) => p.includes('between the marker read'))).toBe(true)
		})

		it('a loader that drops the nil-marker existence probe is reported', () => {
			const src = loadSwift()
			const planted = src.replace(/itemExisted = wrapKeyItemExists\(alias: alias\)/, 'itemExisted = false')
			expect(planted).not.toBe(src)
			expect(checkIosWrapKeyRead(planted).some((p) => p.includes('wrapKeyItemExists on a nil marker'))).toBe(true)
		})

		it('an existence probe that reads the item data is reported', () => {
			const src = loadSwift()
			const probeAt = src.indexOf('func wrapKeyItemExists(')
			const planted = src.slice(0, probeAt) + src.slice(probeAt).replace('kSecReturnAttributes as String: true', 'kSecReturnData as String: true')
			expect(planted).not.toBe(src)
			expect(checkIosWrapKeyRead(planted).some((p) => p.includes('must not read the item data'))).toBe(true)
		})

		it('an existence probe that treats a withheld item as absent is reported', () => {
			const src = loadSwift()
			const probeAt = src.indexOf('func wrapKeyItemExists(')
			const planted = src.slice(0, probeAt) + src.slice(probeAt).replace(' || status == errSecInteractionNotAllowed', '')
			expect(planted).not.toBe(src)
			expect(checkIosWrapKeyRead(planted).some((p) => p.includes('errSecInteractionNotAllowed as present'))).toBe(true)
		})

		it('an unguarded create branch in the loader is reported', () => {
			const src = loadSwift()
			const planted = src.replace(/(else\s+if|if)\s+createIfMissing\b/, '$1 true')
			expect(planted).not.toBe(src)
			expect(checkIosWrapKeyRead(planted).some((p) => p.includes('guarded by createIfMissing'))).toBe(true)
		})
	})
})
