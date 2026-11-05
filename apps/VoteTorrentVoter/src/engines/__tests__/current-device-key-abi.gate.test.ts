/**
 * current-device-key-abi.gate.test.ts — 63-18 fix: the read-only `getCurrentDeviceKey` accessor must
 * agree across the four ABI layers (codegen spec, Kotlin override, Swift @objc, ObjC extern), and the
 * read-only path must never call a generating/deleting Keystore API. Sibling of
 * secret-wrap-abi.gate.test.ts; same comment-stripping approach. The comparator is pure so the
 * planted-mismatch self-tests prove the gate can fail.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function strip(src: string): string {
	const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))
	return noBlock.replace(/\/\/.*$/gm, '')
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const PKG = join(REPO_ROOT, 'packages', 'attestation-native')
const KOTLIN_DIR = join(PKG, 'android', 'src', 'main', 'java', 'org', 'votetorrent', 'attestationnative')
const SELECTOR = 'getCurrentDeviceKey:resolver:rejecter:'

interface Texts {
	spec: string
	kotlinModule: string
	kotlinHelper: string
	swift: string
	objc: string
}

function load(): Texts {
	const r = (p: string): string => readFileSync(p, 'utf8')
	return {
		spec: r(join(PKG, 'src', 'specs', 'NativeAttestation.ts')),
		kotlinModule: r(join(KOTLIN_DIR, 'AttestationNativeModule.kt')),
		kotlinHelper: r(join(KOTLIN_DIR, 'KeyAttestationHelper.kt')),
		swift: r(join(PKG, 'ios', 'AttestationNativeModule.swift')),
		objc: r(join(PKG, 'ios', 'AttestationNative.m')),
	}
}

/** Body of `fun readCurrentKey(...)` up to the next top-level member (indent-1 closing brace). */
function readCurrentKeyBody(kt: string): string | undefined {
	const m = /fun readCurrentKey\([^)]*\)[^{]*\{([\s\S]*?)\n\t\}/.exec(kt)
	return m?.[1]
}

function compare(raw: Texts): string[] {
	const t = {
		spec: strip(raw.spec),
		kotlinModule: strip(raw.kotlinModule),
		kotlinHelper: strip(raw.kotlinHelper),
		swift: strip(raw.swift),
		objc: strip(raw.objc),
	}
	const out: string[] = []
	if (!/\bgetCurrentDeviceKey\(keyAlias: string\): Promise<Object>/.test(t.spec)) out.push('spec: getCurrentDeviceKey(keyAlias: string) not found')
	if (!/override fun getCurrentDeviceKey\(keyAlias: String, promise: Promise\)\s*\{/.test(t.kotlinModule)) out.push('kotlin: override not found')
	const sw = /@objc\((getCurrentDeviceKey:[^)]*)\)/.exec(t.swift)?.[1]
	if (sw !== SELECTOR) out.push(`swift: selector ${String(sw)} != ${SELECTOR}`)
	if (!/func getCurrentDeviceKey\(_ keyAlias: String,\s*resolver resolve: @escaping RCTPromiseResolveBlock,\s*rejecter reject: @escaping RCTPromiseRejectBlock\)/.test(t.swift)) {
		out.push('swift: func signature mismatch')
	}
	const oc = /RCT_EXTERN_METHOD\(getCurrentDeviceKey:\(NSString \*\)keyAlias\s+resolver:\(RCTPromiseResolveBlock\)resolve\s+rejecter:\(RCTPromiseRejectBlock\)reject\)/.test(t.objc)
	if (!oc) out.push('objc: RCT_EXTERN_METHOD not found (or only in a comment)')
	for (const code of ['DEVICE_KEY_ABSENT', 'DEVICE_KEY_INVALIDATED']) {
		if (!t.kotlinModule.includes(`"${code}"`)) out.push(`kotlin: reject code ${code} missing`)
		if (!t.swift.includes(`"${code}"`)) out.push(`swift: reject code ${code} missing`)
	}
	const body = readCurrentKeyBody(t.kotlinHelper)
	if (body === undefined) out.push('kotlin: KeyAttestationHelper.readCurrentKey not found')
	else {
		for (const banned of ['generateKeyPair', 'deleteEntry', 'generateKey(', 'BiometricPrompt', 'authenticate(']) {
			if (body.includes(banned)) out.push(`kotlin: readCurrentKey must be read-only but contains ${banned}`)
		}
	}
	const swBody = /func getCurrentDeviceKey\([\s\S]*?\n  \}\n/.exec(t.swift)?.[0]
	if (swBody === undefined) out.push('swift: getCurrentDeviceKey body not found')
	else {
		for (const banned of ['deleteKey', 'createSecureEnclaveKey', 'generateKey', 'SecItemDelete']) {
			if (swBody.includes(banned)) out.push(`swift: getCurrentDeviceKey must be read-only but contains ${banned}`)
		}
	}
	return out
}

describe('getCurrentDeviceKey ABI parity + read-only (63-18 fix)', () => {
	it('the real four layers agree and the read paths are read-only', () => {
		expect(compare(load())).toEqual([])
	})

	describe('planted-mismatch self-tests: the gate can fail', () => {
		it('a drifted ObjC extern label is reported', () => {
			const t = load()
			const planted = t.objc.replace('getCurrentDeviceKey:(NSString *)keyAlias', 'getCurrentDeviceKey:(NSString *)keyAliasX')
			expect(planted).not.toBe(t.objc)
			expect(compare({ ...t, objc: planted }).some((p) => p.startsWith('objc:'))).toBe(true)
		})
		it('a Swift selector that drops a label is reported', () => {
			const t = load()
			const planted = t.swift.replace('@objc(getCurrentDeviceKey:resolver:rejecter:)', '@objc(getCurrentDeviceKey:rejecter:)')
			expect(planted).not.toBe(t.swift)
			expect(compare({ ...t, swift: planted }).some((p) => p.startsWith('swift:'))).toBe(true)
		})
		it('dropping the Kotlin override is reported', () => {
			const t = load()
			const planted = t.kotlinModule.replace('override fun getCurrentDeviceKey(', 'fun getCurrentDeviceKeyX(')
			expect(planted).not.toBe(t.kotlinModule)
			expect(compare({ ...t, kotlinModule: planted }).some((p) => p.startsWith('kotlin: override'))).toBe(true)
		})
		it('a generating call planted into readCurrentKey is reported', () => {
			const t = load()
			const planted = t.kotlinHelper.replace('fun readCurrentKey(keyAlias: String): ProvisionResult {', 'fun readCurrentKey(keyAlias: String): ProvisionResult {\n\t\tgenerateKey(keyAlias, null, KeyAuthenticator.BIOMETRIC_STRONG)')
			expect(planted).not.toBe(t.kotlinHelper)
			expect(compare({ ...t, kotlinHelper: planted }).some((p) => p.includes('must be read-only'))).toBe(true)
		})
		it('a selector that appears only inside a comment does not count', () => {
			const t = load()
			const planted = '// RCT_EXTERN_METHOD(getCurrentDeviceKey:(NSString *)keyAlias resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)\n'
			expect(compare({ ...t, objc: planted }).some((p) => p.startsWith('objc:'))).toBe(true)
		})
	})
})
