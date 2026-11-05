/**
 * fresh-attestation-abi.gate.test.ts — spike 104 (R1d): `provisionAttestedDeviceKey` and
 * `produceFreshAttestation` must agree across the four ABI layers (codegen spec, Kotlin override,
 * Swift @objc, ObjC extern), and the Android produce path must never touch the voting key: its whole
 * point is that the key which signed the association request is still there to sign the answer.
 * Sibling of current-device-key-abi.gate.test.ts; same comment-stripping approach. The comparator is
 * pure so the planted-mismatch self-tests prove the gate can fail.
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
const PROVISION_SELECTOR = 'provisionAttestedDeviceKey:attestationChallengeBase64:resolver:rejecter:'
const PRODUCE_SELECTOR = 'produceFreshAttestation:boundDigest:boundDigestUtf8Base64:enablePlayIntegrity:resolver:rejecter:'

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

/** Body of `fun attestFresh(...)` up to the next top-level member (indent-1 closing brace). */
function attestFreshBody(kt: string): string | undefined {
	return /fun attestFresh\([^)]*\)[^{]*\{([\s\S]*?)\n\t\}/.exec(kt)?.[1]
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

	if (!/\bprovisionAttestedDeviceKey\(keyAlias: string, attestationChallengeBase64: string\): Promise<Object>/.test(t.spec)) {
		out.push('spec: provisionAttestedDeviceKey(keyAlias, attestationChallengeBase64) not found')
	}
	if (!/\bproduceFreshAttestation\(\s*keyAlias: string,\s*boundDigest: string,\s*boundDigestUtf8Base64: string,\s*enablePlayIntegrity: boolean,?\s*\): Promise<Object>/.test(t.spec)) {
		out.push('spec: produceFreshAttestation(keyAlias, boundDigest, boundDigestUtf8Base64, enablePlayIntegrity) not found')
	}

	if (!/override fun provisionAttestedDeviceKey\(keyAlias: String, attestationChallengeBase64: String, promise: Promise\)\s*\{/.test(t.kotlinModule)) {
		out.push('kotlin: provisionAttestedDeviceKey override not found')
	}
	if (!/override fun produceFreshAttestation\(\s*keyAlias: String,\s*boundDigest: String,\s*boundDigestUtf8Base64: String,\s*enablePlayIntegrity: Boolean,\s*promise: Promise,?\s*\)\s*\{/.test(t.kotlinModule)) {
		out.push('kotlin: produceFreshAttestation override not found')
	}
	for (const code of ['NO_KEY_PROVISIONED', 'KEY_INVALIDATED_REASSOCIATE', 'DEVICE_KEY_NOT_ATTESTED', 'INVALID_CHALLENGE_ENCODING']) {
		if (!t.kotlinModule.includes(`"${code}"`)) out.push(`kotlin: reject code ${code} missing`)
	}

	const swProvision = /@objc\((provisionAttestedDeviceKey:[^)]*)\)/.exec(t.swift)?.[1]
	if (swProvision !== PROVISION_SELECTOR) out.push(`swift: selector ${String(swProvision)} != ${PROVISION_SELECTOR}`)
	const swProduce = /@objc\((produceFreshAttestation:[^)]*)\)/.exec(t.swift)?.[1]
	if (swProduce !== PRODUCE_SELECTOR) out.push(`swift: selector ${String(swProduce)} != ${PRODUCE_SELECTOR}`)
	if (!/func provisionAttestedDeviceKey\(_ keyAlias: String,\s*attestationChallengeBase64: String,\s*resolver resolve: @escaping RCTPromiseResolveBlock,\s*rejecter reject: @escaping RCTPromiseRejectBlock\)/.test(t.swift)) {
		out.push('swift: provisionAttestedDeviceKey func signature mismatch')
	}
	if (!/func produceFreshAttestation\(_ keyAlias: String,\s*boundDigest: String,\s*boundDigestUtf8Base64: String,\s*enablePlayIntegrity: Bool,\s*resolver resolve: @escaping RCTPromiseResolveBlock,\s*rejecter reject: @escaping RCTPromiseRejectBlock\)/.test(t.swift)) {
		out.push('swift: produceFreshAttestation func signature mismatch')
	}

	if (!/RCT_EXTERN_METHOD\(provisionAttestedDeviceKey:\(NSString \*\)keyAlias\s+attestationChallengeBase64:\(NSString \*\)attestationChallengeBase64\s+resolver:\(RCTPromiseResolveBlock\)resolve\s+rejecter:\(RCTPromiseRejectBlock\)reject\)/.test(t.objc)) {
		out.push('objc: provisionAttestedDeviceKey RCT_EXTERN_METHOD not found (or only in a comment)')
	}
	if (!/RCT_EXTERN_METHOD\(produceFreshAttestation:\(NSString \*\)keyAlias\s+boundDigest:\(NSString \*\)boundDigest\s+boundDigestUtf8Base64:\(NSString \*\)boundDigestUtf8Base64\s+enablePlayIntegrity:\(BOOL\)enablePlayIntegrity\s+resolver:\(RCTPromiseResolveBlock\)resolve\s+rejecter:\(RCTPromiseRejectBlock\)reject\)/.test(t.objc)) {
		out.push('objc: produceFreshAttestation RCT_EXTERN_METHOD not found (or only in a comment)')
	}

	// The voting key must survive produce: attestFresh may generate and delete only the throwaway alias.
	const body = attestFreshBody(t.kotlinHelper)
	if (body === undefined) out.push('kotlin: KeyAttestationHelper.attestFresh not found')
	else {
		if (/generateKey\(\s*keyAlias\b/.test(body)) out.push('kotlin: attestFresh regenerates the voting alias')
		if (/deleteEntry\(\s*keyAlias\b/.test(body)) out.push('kotlin: attestFresh deletes the voting alias')
		if (!/generateKey\(\s*freshAlias\b/.test(body)) out.push('kotlin: attestFresh does not generate under the throwaway alias')
		if (!/deleteEntry\(\s*freshAlias\b/.test(body)) out.push('kotlin: attestFresh does not delete the throwaway alias')
		for (const banned of ['BiometricPrompt', 'authenticate(', 'regenerateAttested']) {
			if (body.includes(banned)) out.push(`kotlin: attestFresh must not prompt or rotate but contains ${banned}`)
		}
	}
	return out
}

describe('R1d native ABI parity + produce never touches the voting key (spike 104)', () => {
	it('the real four layers agree and attestFresh only touches the throwaway alias', () => {
		expect(compare(load())).toEqual([])
	})

	describe('planted-mismatch self-tests: the gate can fail', () => {
		it('a drifted ObjC extern label is reported', () => {
			const t = load()
			const planted = t.objc.replace('boundDigestUtf8Base64:(NSString *)boundDigestUtf8Base64', 'boundDigestUtf8:(NSString *)boundDigestUtf8Base64')
			expect(planted).not.toBe(t.objc)
			expect(compare({ ...t, objc: planted }).some((p) => p.startsWith('objc: produceFreshAttestation'))).toBe(true)
		})
		it('a Swift selector that drops a label is reported', () => {
			const t = load()
			const planted = t.swift.replace(`@objc(${PROVISION_SELECTOR})`, '@objc(provisionAttestedDeviceKey:resolver:rejecter:)')
			expect(planted).not.toBe(t.swift)
			expect(compare({ ...t, swift: planted }).some((p) => p.startsWith('swift: selector'))).toBe(true)
		})
		it('dropping a Kotlin override is reported', () => {
			const t = load()
			const planted = t.kotlinModule.replace('override fun produceFreshAttestation(', 'fun produceFreshAttestationX(')
			expect(planted).not.toBe(t.kotlinModule)
			expect(compare({ ...t, kotlinModule: planted }).some((p) => p.startsWith('kotlin: produceFreshAttestation override'))).toBe(true)
		})
		it('attestFresh deleting the voting alias is reported', () => {
			const t = load()
			const planted = t.kotlinHelper.replace('val freshAlias = freshAliasFor(keyAlias)', 'keyStore.deleteEntry(keyAlias)\n\t\tval freshAlias = freshAliasFor(keyAlias)')
			expect(planted).not.toBe(t.kotlinHelper)
			expect(compare({ ...t, kotlinHelper: planted })).toContain('kotlin: attestFresh deletes the voting alias')
		})
		it('attestFresh regenerating the voting alias is reported', () => {
			const t = load()
			const planted = t.kotlinHelper.replace('generateKey(freshAlias, attestationChallenge = attestationChallengeBytes)', 'generateKey(keyAlias, attestationChallenge = attestationChallengeBytes)')
			expect(planted).not.toBe(t.kotlinHelper)
			expect(compare({ ...t, kotlinHelper: planted })).toContain('kotlin: attestFresh regenerates the voting alias')
		})
		it('a selector that appears only inside a comment does not count', () => {
			const t = load()
			const planted = `// RCT_EXTERN_METHOD(provisionAttestedDeviceKey:(NSString *)keyAlias attestationChallengeBase64:(NSString *)attestationChallengeBase64 resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)\n`
			expect(compare({ ...t, objc: planted }).some((p) => p.startsWith('objc: provisionAttestedDeviceKey'))).toBe(true)
		})
	})
})
