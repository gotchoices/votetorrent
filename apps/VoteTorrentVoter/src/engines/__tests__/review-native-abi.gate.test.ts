/**
 * review-native-abi.gate.test.ts — Phase 63 review (CR-01, CR-02, WR-03): the three new
 * attestation-native methods must agree across the four ABI layers (codegen spec, Kotlin override,
 * Swift @objc, ObjC extern), and the CR-02 deletion must stay restricted to the vote-record alias
 * family on every layer. Sibling of current-device-key-abi.gate.test.ts and
 * secret-wrap-abi.gate.test.ts; same comment-stripping approach. The comparator is pure, so the
 * planted-mismatch self-tests prove the gate can fail.
 *
 * `typecheck:ios` compiles only the Swift, never the .m, so a Swift/ObjC selector drift would be an
 * "unrecognized selector" crash on first call; the Kotlin arity is also proven by the compile.
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

/** The one alias family that may ever be deleted, as a regex SOURCE string on every layer. */
const DELETABLE_SOURCE = '^VOTETORRENT_VOTE_RECORD_WRAP_KEY_V[0-9]+$'

interface Texts {
	spec: string
	secretWrapTs: string
	kotlinModule: string
	kotlinHelper: string
	swift: string
	objc: string
}

function load(): Texts {
	const r = (p: string): string => readFileSync(p, 'utf8')
	return {
		spec: r(join(PKG, 'src', 'specs', 'NativeAttestation.ts')),
		secretWrapTs: r(join(PKG, 'src', 'secret-wrap.ts')),
		kotlinModule: r(join(KOTLIN_DIR, 'AttestationNativeModule.kt')),
		kotlinHelper: r(join(KOTLIN_DIR, 'SecretWrapHelper.kt')),
		swift: r(join(PKG, 'ios', 'AttestationNativeModule.swift')),
		objc: r(join(PKG, 'ios', 'AttestationNative.m')),
	}
}

/** Brace-balanced body starting at the first `{` after [signature]'s match. */
function body(text: string, signature: RegExp): string | undefined {
	const m = signature.exec(text)
	if (!m) return undefined
	const open = text.indexOf('{', m.index + m[0].length)
	if (open < 0) return undefined
	let depth = 0
	for (let i = open; i < text.length; i++) {
		if (text[i] === '{') depth++
		else if (text[i] === '}') {
			depth--
			if (depth === 0) return text.slice(open, i + 1)
		}
	}
	return undefined
}

function count(text: string, needle: string): number {
	return text.split(needle).length - 1
}

export function compare(raw: Texts): string[] {
	const t = {
		spec: strip(raw.spec),
		secretWrapTs: strip(raw.secretWrapTs),
		kotlinModule: strip(raw.kotlinModule),
		kotlinHelper: strip(raw.kotlinHelper),
		swift: strip(raw.swift),
		objc: strip(raw.objc),
	}
	const out: string[] = []

	// --- spec ---
	if (!/\bdeleteWrapKey\(keyAlias: string\): Promise<Object>/.test(t.spec)) out.push('spec: deleteWrapKey(keyAlias: string): Promise<Object> not found')
	if (!/\bsetSecureScreen\(enabled: boolean\): Promise<Object>/.test(t.spec)) out.push('spec: setSecureScreen(enabled: boolean): Promise<Object> not found')
	if (!/\bcopySensitiveText\(text: string\): boolean/.test(t.spec)) out.push('spec: copySensitiveText(text: string): boolean (synchronous) not found')

	// --- Kotlin module overrides ---
	if (!/override fun deleteWrapKey\(keyAlias: String, promise: Promise\)\s*\{/.test(t.kotlinModule)) out.push('kotlin: deleteWrapKey override not found')
	if (!/override fun setSecureScreen\(enabled: Boolean, promise: Promise\)\s*\{/.test(t.kotlinModule)) out.push('kotlin: setSecureScreen override not found')
	if (!/override fun copySensitiveText\(text: String\): Boolean\s*\{/.test(t.kotlinModule)) out.push('kotlin: copySensitiveText override not found')
	const secure = body(t.kotlinModule, /override fun setSecureScreen\(/)
	if (secure !== undefined) {
		if (!secure.includes('UiThreadUtil.runOnUiThread')) out.push('kotlin: setSecureScreen must change the window on the UI thread')
		if (!secure.includes('addFlags(WindowManager.LayoutParams.FLAG_SECURE)')) out.push('kotlin: setSecureScreen never adds FLAG_SECURE')
		if (!secure.includes('clearFlags(WindowManager.LayoutParams.FLAG_SECURE)')) out.push('kotlin: setSecureScreen never clears FLAG_SECURE')
	}
	const copy = body(t.kotlinModule, /override fun copySensitiveText\(/)
	if (copy !== undefined) {
		if (!copy.includes('ClipDescription.EXTRA_IS_SENSITIVE')) out.push('kotlin: copySensitiveText does not set EXTRA_IS_SENSITIVE')
		if (!copy.includes('LEGACY_EXTRA_IS_SENSITIVE')) out.push('kotlin: copySensitiveText has no below-33 sensitive extra')
		if (copy.includes('.primaryClip') && !copy.includes('primaryClipDescription')) out.push('kotlin: copySensitiveText must not read the clip text back')
		if (/\.primaryClip\b(?!Description)/.test(copy)) out.push('kotlin: copySensitiveText reads the clip text back (Android 12+ paste notice)')
	}
	if (!/"android\.content\.extra\.IS_SENSITIVE"/.test(t.kotlinModule)) out.push('kotlin: legacy IS_SENSITIVE literal missing')

	// --- Kotlin helper: deletion restricted, in exactly one place ---
	const kRe = /internal val DELETABLE_WRAP_KEY_ALIAS_PATTERN = Regex\("([^"]*)"\)/.exec(t.kotlinHelper)?.[1]
	if (kRe !== DELETABLE_SOURCE) out.push(`kotlin: DELETABLE_WRAP_KEY_ALIAS_PATTERN ${String(kRe)} != ${DELETABLE_SOURCE}`)
	const del = body(t.kotlinHelper, /\bfun deleteWrapKey\(alias: String\): Boolean/)
	if (del === undefined) out.push('kotlin: SecretWrapHelper.deleteWrapKey not found')
	else {
		const guard = del.indexOf('DELETABLE_WRAP_KEY_ALIAS_PATTERN.matches(alias)')
		const call = del.indexOf('deleteEntry(')
		if (guard < 0) out.push('kotlin: deleteWrapKey does not check DELETABLE_WRAP_KEY_ALIAS_PATTERN')
		if (call < 0) out.push('kotlin: deleteWrapKey does not call deleteEntry')
		if (guard >= 0 && call >= 0 && guard > call) out.push('kotlin: deleteWrapKey deletes before checking the alias')
	}
	const deleteEntries = count(t.kotlinHelper, 'deleteEntry(')
	if (deleteEntries !== 1) out.push(`kotlin: deleteEntry( occurs ${deleteEntries} times in SecretWrapHelper, expected exactly 1 (inside deleteWrapKey)`)
	const delModule = body(t.kotlinModule, /override fun deleteWrapKey\(/)
	if (delModule !== undefined && !delModule.includes('secretWrapHelper.deleteWrapKey(keyAlias)')) out.push('kotlin: module deleteWrapKey bypasses the helper guard')
	if (t.kotlinModule.includes('deleteEntry(')) out.push('kotlin: the module calls deleteEntry directly')

	// --- TS pattern ---
	const tsRe = /export const VOTE_RECORD_WRAP_KEY_ALIAS_PATTERN = \/(.*)\//.exec(t.secretWrapTs)?.[1]
	if (tsRe !== DELETABLE_SOURCE) out.push(`ts: VOTE_RECORD_WRAP_KEY_ALIAS_PATTERN ${String(tsRe)} != ${DELETABLE_SOURCE}`)

	// --- Swift ---
	const swSel = (m: string) => new RegExp(`@objc\\((${m}:[^)]*)\\)`).exec(t.swift)?.[1]
	if (swSel('deleteWrapKey') !== 'deleteWrapKey:resolver:rejecter:') out.push(`swift: deleteWrapKey selector ${String(swSel('deleteWrapKey'))}`)
	if (swSel('setSecureScreen') !== 'setSecureScreen:resolver:rejecter:') out.push(`swift: setSecureScreen selector ${String(swSel('setSecureScreen'))}`)
	if (swSel('copySensitiveText') !== 'copySensitiveText:') out.push(`swift: copySensitiveText selector ${String(swSel('copySensitiveText'))}`)
	if (!/func deleteWrapKey\(_ keyAlias: String,\s*resolver resolve: @escaping RCTPromiseResolveBlock,\s*rejecter reject: @escaping RCTPromiseRejectBlock\)/.test(t.swift)) out.push('swift: deleteWrapKey signature mismatch')
	if (!/func setSecureScreen\(_ enabled: Bool,\s*resolver resolve: @escaping RCTPromiseResolveBlock,\s*rejecter reject: @escaping RCTPromiseRejectBlock\)/.test(t.swift)) out.push('swift: setSecureScreen signature mismatch')
	if (!/func copySensitiveText\(_ text: String\) -> NSNumber/.test(t.swift)) out.push('swift: copySensitiveText must be (String) -> NSNumber (a synchronous value)')
	const swRe = /deletableWrapKeyAliasPattern = try! NSRegularExpression\(pattern: "([^"]*)"\)/.exec(t.swift)?.[1]
	if (swRe !== DELETABLE_SOURCE) out.push(`swift: deletableWrapKeyAliasPattern ${String(swRe)} != ${DELETABLE_SOURCE}`)
	const swDel = body(t.swift, /func deleteWrapKey\(/)
	if (swDel === undefined) out.push('swift: deleteWrapKey body not found')
	else {
		const g = swDel.indexOf('deletableWrapKeyAliasPattern.firstMatch')
		const d = swDel.indexOf('SecItemDelete(')
		if (g < 0 || d < 0 || g > d) out.push('swift: deleteWrapKey must check the alias before SecItemDelete')
	}
	const swCopy = body(t.swift, /func copySensitiveText\(/)
	if (swCopy !== undefined && (!swCopy.includes('.localOnly') || !swCopy.includes('.expirationDate'))) out.push('swift: copySensitiveText must set localOnly and expirationDate')
	// No OTHER Swift function may delete a wrap-key (generic password) item. The pre-existing
	// `deleteKey(tag:)` deletes Secure Enclave EC keys (kSecClassKey) and is out of scope here.
	const funcRe = /func (\w+)\(/g
	let fm: RegExpExecArray | null
	while ((fm = funcRe.exec(t.swift)) !== null) {
		if (fm[1] === 'deleteWrapKey') continue
		const b = body(t.swift, new RegExp(`func ${fm[1]}\\(`))
		if (b !== undefined && b.includes('SecItemDelete(') && b.includes('kSecClassGenericPassword')) {
			out.push(`swift: ${fm[1]} deletes a generic-password (wrap key) item outside deleteWrapKey`)
		}
	}

	// --- ObjC ---
	if (!/RCT_EXTERN_METHOD\(deleteWrapKey:\(NSString \*\)keyAlias\s+resolver:\(RCTPromiseResolveBlock\)resolve\s+rejecter:\(RCTPromiseRejectBlock\)reject\)/.test(t.objc)) out.push('objc: deleteWrapKey extern not found (or only in a comment)')
	if (!/RCT_EXTERN_METHOD\(setSecureScreen:\(BOOL\)enabled\s+resolver:\(RCTPromiseResolveBlock\)resolve\s+rejecter:\(RCTPromiseRejectBlock\)reject\)/.test(t.objc)) out.push('objc: setSecureScreen extern not found (or only in a comment)')
	if (!/RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD\(copySensitiveText:\(NSString \*\)text\)/.test(t.objc)) out.push('objc: copySensitiveText must be a RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD')

	return out
}

describe('Phase 63 review native ABI parity (deleteWrapKey, setSecureScreen, copySensitiveText)', () => {
	it('the real four layers agree, deletion is restricted, and the copy is marked sensitive', () => {
		expect(compare(load())).toEqual([])
	})

	it('the deletable pattern refuses the identity and signing aliases and accepts only the vote-record family', () => {
		const re = new RegExp(DELETABLE_SOURCE)
		for (const alias of [
			'VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1',
			'VOTETORRENT_DEVICE_KEY_V1',
			'VOTETORRENT_AUTHORITY_SIGNING_KEY_V1',
			'VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1',
			'VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1_EXTRA',
			'XVOTETORRENT_VOTE_RECORD_WRAP_KEY_V1',
		]) {
			expect(re.test(alias)).toBe(false)
		}
		expect(re.test('VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1')).toBe(true)
		expect(re.test('VOTETORRENT_VOTE_RECORD_WRAP_KEY_V2')).toBe(true)
	})

	describe('planted-mismatch self-tests: the gate can fail', () => {
		const t = load()
		const plant = (k: keyof Texts, from: string | RegExp, to: string): Texts => {
			const planted = t[k].replace(from, to)
			expect(planted).not.toBe(t[k])
			return { ...t, [k]: planted }
		}
		it('a drifted ObjC deleteWrapKey label is reported', () => {
			expect(compare(plant('objc', 'deleteWrapKey:(NSString *)keyAlias', 'deleteWrapKey:(NSString *)alias')).some((p) => p.startsWith('objc: deleteWrapKey'))).toBe(true)
		})
		it('copySensitiveText declared as an async RCT_EXTERN_METHOD is reported', () => {
			expect(compare(plant('objc', 'RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(copySensitiveText:', 'RCT_EXTERN_METHOD(copySensitiveText:')).some((p) => p.startsWith('objc: copySensitiveText'))).toBe(true)
		})
		it('a Swift setSecureScreen selector that drops a label is reported', () => {
			expect(compare(plant('swift', '@objc(setSecureScreen:resolver:rejecter:)', '@objc(setSecureScreen:rejecter:)')).some((p) => p.startsWith('swift: setSecureScreen'))).toBe(true)
		})
		it('a widened Kotlin deletable pattern (would admit the identity alias) is reported', () => {
			expect(compare(plant('kotlinHelper', 'Regex("^VOTETORRENT_VOTE_RECORD_WRAP_KEY_V[0-9]+$")', 'Regex("^VOTETORRENT_[A-Z0-9_]+_WRAP_KEY_V[0-9]+$")')).some((p) => p.startsWith('kotlin: DELETABLE'))).toBe(true)
		})
		it('a widened Swift deletable pattern is reported', () => {
			expect(compare(plant('swift', 'pattern: "^VOTETORRENT_VOTE_RECORD_WRAP_KEY_V[0-9]+$"', 'pattern: "^VOTETORRENT_.*$"')).some((p) => p.startsWith('swift: deletableWrapKeyAliasPattern'))).toBe(true)
		})
		it('a widened TS deletable pattern is reported', () => {
			expect(compare(plant('secretWrapTs', '/^VOTETORRENT_VOTE_RECORD_WRAP_KEY_V[0-9]+$/', '/^VOTETORRENT_[A-Z0-9_]+_WRAP_KEY_V[0-9]+$/')).some((p) => p.startsWith('ts:'))).toBe(true)
		})
		it('a second deleteEntry outside deleteWrapKey is reported', () => {
			const planted = { ...t, kotlinHelper: t.kotlinHelper + '\nfun nuke(a: String) { KeyStore.getInstance("AndroidKeyStore").deleteEntry(a) }\n' }
			expect(compare(planted).some((p) => p.includes('deleteEntry( occurs 2'))).toBe(true)
		})
		it('dropping the alias guard from deleteWrapKey is reported', () => {
			expect(compare(plant('kotlinHelper', 'if (!DELETABLE_WRAP_KEY_ALIAS_PATTERN.matches(alias)) {', 'if (alias.isEmpty()) {')).some((p) => p.includes('does not check DELETABLE'))).toBe(true)
		})
		it('a sensitive-copy that loses EXTRA_IS_SENSITIVE is reported', () => {
			expect(compare(plant('kotlinModule', 'ClipDescription.EXTRA_IS_SENSITIVE', 'ClipDescription.EXTRA_IS_REMOTE_DEVICE')).some((p) => p.includes('EXTRA_IS_SENSITIVE'))).toBe(true)
		})
		it('a copy that reads the clip text back is reported', () => {
			expect(compare(plant('kotlinModule', 'val desc = clipboard.primaryClipDescription', 'val desc = clipboard.primaryClip?.description')).some((p) => p.includes('reads the clip text back'))).toBe(true)
		})
		it('a FLAG_SECURE change off the UI thread is reported', () => {
			expect(compare(plant('kotlinModule', /UiThreadUtil\.runOnUiThread \{\n\t\t\ttry \{\n\t\t\t\tif \(enabled\)/, 'run {\n\t\t\ttry {\n\t\t\t\tif (enabled)')).some((p) => p.includes('UI thread'))).toBe(true)
		})
		it('a Swift function other than deleteWrapKey that deletes a wrap-key item is reported', () => {
			const planted = {
				...t,
				swift: t.swift + '\nfunc wipeWrap(_ a: String) {\n  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword]\n  SecItemDelete(q as CFDictionary)\n}\n',
			}
			expect(compare(planted).some((p) => p.includes('wipeWrap deletes a generic-password'))).toBe(true)
		})
		it('an extern that appears only inside a comment does not count', () => {
			const planted = { ...t, objc: '// RCT_EXTERN_METHOD(deleteWrapKey:(NSString *)keyAlias resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)\n' }
			expect(compare(planted).some((p) => p.startsWith('objc: deleteWrapKey'))).toBe(true)
		})
		it('dropping a Kotlin override is reported', () => {
			expect(compare(plant('kotlinModule', 'override fun setSecureScreen(', 'fun setSecureScreenX(')).some((p) => p.startsWith('kotlin: setSecureScreen override'))).toBe(true)
		})
	})
})
