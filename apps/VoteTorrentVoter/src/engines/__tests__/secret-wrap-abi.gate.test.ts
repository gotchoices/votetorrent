/**
 * secret-wrap-abi.gate.test.ts — D-14 (Phase 63 plan 16): the `wrapSecret`/`unwrapSecret` ABI must
 * agree across FOUR layers, in lockstep: the codegen spec (TS), the Kotlin TurboModule, the Swift
 * `@objc(...)` selectors, and the ObjC `RCT_EXTERN_METHOD` externs.
 *
 * Why this gate exists: `typecheck:ios` compiles only the Swift, never the .m. A Swift/ObjC
 * selector mismatch is not a compile error; it is an "unrecognized selector" crash on the first JS
 * call (see AttestationNative.m's header comment). The Android override arity is proven separately
 * by the Kotlin compile (codegen regenerates the Java spec from the TS spec).
 *
 * Every extraction runs on COMMENT-STRIPPED text, because the .m's own comment quotes selectors.
 * The comparator is a pure function so the planted-mismatch self-tests below can prove the gate
 * can actually fail.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Comment stripping (same approach as no-vrg-ceremony.gate.test.ts), line preserving.
// ---------------------------------------------------------------------------

function stripCommentsPreservingLines(src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const PKG = join(REPO_ROOT, 'packages', 'attestation-native')
const KOTLIN_DIR = join(PKG, 'android', 'src', 'main', 'java', 'org', 'votetorrent', 'attestationnative')

interface AbiTexts {
	spec: string
	secretWrapTs: string
	kotlinModule: string
	kotlinHelper: string
	swift: string
	objc: string
}

const METHODS = ['wrapSecret', 'unwrapSecret'] as const
type Method = (typeof METHODS)[number]

const EXPECTED_SELECTOR: Record<Method, string> = {
	wrapSecret:
		'wrapSecret:plaintextBase64:aadBase64:requireAuth:promptTitle:promptSubtitle:promptNegativeButton:authWindowSeconds:resolver:rejecter:',
	unwrapSecret:
		'unwrapSecret:ciphertextBase64:ivBase64:aadBase64:requireAuth:promptTitle:promptSubtitle:promptNegativeButton:authWindowSeconds:resolver:rejecter:',
}

function readRepo(path: string): string {
	return readFileSync(path, 'utf8')
}

function loadTexts(): AbiTexts {
	return {
		spec: readRepo(join(PKG, 'src', 'specs', 'NativeAttestation.ts')),
		secretWrapTs: readRepo(join(PKG, 'src', 'secret-wrap.ts')),
		kotlinModule: readRepo(join(KOTLIN_DIR, 'AttestationNativeModule.kt')),
		kotlinHelper: readRepo(join(KOTLIN_DIR, 'SecretWrapHelper.kt')),
		swift: readRepo(join(PKG, 'ios', 'AttestationNativeModule.swift')),
		objc: readRepo(join(PKG, 'ios', 'AttestationNative.m')),
	}
}

// ---------------------------------------------------------------------------
// Extractors. Anchored: `unwrapSecret` contains `wrapSecret`, so each extractor pins a word
// boundary or a full prefix.
// ---------------------------------------------------------------------------

function splitParams(raw: string): string[] {
	return raw
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
}

/** TS spec: `name: type` pairs of `<method>(...): Promise<Object>`. */
function specParams(spec: string, method: Method): Array<{ name: string; type: string }> | undefined {
	const m = new RegExp(`\\b${method}\\(([\\s\\S]*?)\\):\\s*Promise<Object>`).exec(spec)
	if (!m) return undefined
	return splitParams(m[1]!).map((p) => {
		const [name, type] = p.split(':').map((s) => s.trim())
		return { name: name!, type: type! }
	})
}

/** Kotlin module override: `name: Type` pairs of `override fun <method>(...) {`. */
function kotlinParams(kt: string, method: Method): Array<{ name: string; type: string }> | undefined {
	const m = new RegExp(`override fun ${method}\\(([\\s\\S]*?)\\)\\s*\\{`).exec(kt)
	if (!m) return undefined
	return splitParams(m[1]!).map((p) => {
		const [name, type] = p.split(':').map((s) => s.trim())
		return { name: name!, type: type! }
	})
}

function swiftSelector(swift: string, method: Method): string | undefined {
	return new RegExp(`@objc\\((${method}:[^)]*)\\)`).exec(swift)?.[1]
}

/** Swift func params: external label + type. `_ keyAlias: String` has external label `_`. */
function swiftParams(swift: string, method: Method): Array<{ label: string; type: string }> | undefined {
	const m = new RegExp(`func ${method}\\(([\\s\\S]*?)\\)\\s*\\{`).exec(swift)
	if (!m) return undefined
	return splitParams(m[1]!).map((p) => {
		const idx = p.indexOf(':')
		const left = p.slice(0, idx).trim().split(/\s+/)
		return { label: left[0]!, type: p.slice(idx + 1).trim() }
	})
}

/** Balanced-parenthesis walk from `RCT_EXTERN_METHOD(<method>:` to its matching close. */
function objcBody(objc: string, method: Method): string | undefined {
	const head = `RCT_EXTERN_METHOD(${method}:`
	const start = objc.indexOf(head)
	if (start < 0) return undefined
	let depth = 0
	for (let i = start + 'RCT_EXTERN_METHOD'.length; i < objc.length; i++) {
		const ch = objc[i]
		if (ch === '(') depth++
		else if (ch === ')') {
			depth--
			if (depth === 0) return objc.slice(start + 'RCT_EXTERN_METHOD('.length, i)
		}
	}
	return undefined
}

function objcParts(objc: string, method: Method): { selector: string; pairs: Array<{ label: string; type: string }> } | undefined {
	const body = objcBody(objc, method)
	if (body === undefined) return undefined
	const pairs: Array<{ label: string; type: string }> = []
	const re = /(\w+):\(([^)]*)\)\s*\w+/g
	let m: RegExpExecArray | null
	while ((m = re.exec(body)) !== null) pairs.push({ label: m[1]!, type: m[2]!.trim() })
	return { selector: pairs.map((p) => `${p.label}:`).join(''), pairs }
}

/** Balanced-paren call block `<callee>(` ... `)`. */
function callBlock(src: string, callee: string): string | undefined {
	const start = src.indexOf(`${callee}(`)
	if (start < 0) return undefined
	let depth = 0
	for (let i = start + callee.length; i < src.length; i++) {
		const ch = src[i]
		if (ch === '(') depth++
		else if (ch === ')') {
			depth--
			if (depth === 0) return src.slice(start, i + 1)
		}
	}
	return undefined
}

function kotlinConst(src: string, pattern: RegExp): number | undefined {
	const m = pattern.exec(src)
	return m ? Number(m[1]) : undefined
}

// ---------------------------------------------------------------------------
// The comparator: human-readable mismatch strings; [] means the four layers agree.
// ---------------------------------------------------------------------------

function compareSecretWrapAbi(raw: AbiTexts): string[] {
	const t: AbiTexts = {
		spec: stripCommentsPreservingLines(raw.spec),
		secretWrapTs: stripCommentsPreservingLines(raw.secretWrapTs),
		kotlinModule: stripCommentsPreservingLines(raw.kotlinModule),
		kotlinHelper: stripCommentsPreservingLines(raw.kotlinHelper),
		swift: stripCommentsPreservingLines(raw.swift),
		objc: stripCommentsPreservingLines(raw.objc),
	}
	const out: string[] = []

	for (const method of METHODS) {
		const spec = specParams(t.spec, method)
		const kt = kotlinParams(t.kotlinModule, method)
		const swSel = swiftSelector(t.swift, method)
		const swParams = swiftParams(t.swift, method)
		const oc = objcParts(t.objc, method)

		if (!spec) out.push(`${method}: spec declaration not found`)
		if (!kt) out.push(`${method}: Kotlin override not found`)
		if (!swSel) out.push(`${method}: Swift @objc selector not found`)
		if (!swParams) out.push(`${method}: Swift func not found`)
		if (!oc) out.push(`${method}: ObjC RCT_EXTERN_METHOD not found (or only present in a comment)`)

		const expected = EXPECTED_SELECTOR[method]
		if (swSel !== undefined && swSel !== expected) out.push(`${method}: Swift selector ${swSel} != expected ${expected}`)
		if (oc && oc.selector !== expected) out.push(`${method}: ObjC selector ${oc.selector} != expected ${expected}`)
		if (swSel !== undefined && oc && swSel !== oc.selector) out.push(`${method}: Swift selector != ObjC selector`)

		if (spec && kt) {
			const ktNames = kt.map((p) => p.name)
			if (ktNames[ktNames.length - 1] !== 'promise') out.push(`${method}: Kotlin override must end with promise`)
			const a = spec.map((p) => p.name).join(',')
			const b = ktNames.slice(0, -1).join(',')
			if (a !== b) out.push(`${method}: spec params [${a}] != Kotlin params [${b}]`)
			const last = spec[spec.length - 1]
			if (!last || last.name !== 'authWindowSeconds' || last.type !== 'number') {
				out.push(`${method}: last spec param must be authWindowSeconds: number`)
			}
			const ktLast = kt[kt.length - 2]
			if (!ktLast || ktLast.name !== 'authWindowSeconds' || ktLast.type !== 'Double') {
				out.push(`${method}: Kotlin last param before promise must be authWindowSeconds: Double`)
			}
		}

		if (spec && swSel !== undefined) {
			// Selector labels minus the method head and minus resolver/rejecter == spec names from the 2nd on.
			const labels = swSel.split(':').filter((s) => s.length > 0).slice(1).filter((l) => l !== 'resolver' && l !== 'rejecter')
			const specTail = spec.slice(1).map((p) => p.name)
			if (labels.join(',') !== specTail.join(',')) {
				out.push(`${method}: Swift selector labels [${labels.join(',')}] != spec params [${specTail.join(',')}]`)
			}
		}

		if (swParams && swSel !== undefined) {
			const swiftLabels = swParams.slice(1).map((p) => p.label).join(',')
			const selLabels = swSel.split(':').filter((s) => s.length > 0).slice(1).join(',')
			if (swiftLabels !== selLabels) out.push(`${method}: Swift func labels [${swiftLabels}] != selector labels [${selLabels}]`)
			const awIdx = swParams.findIndex((p) => p.label === 'authWindowSeconds')
			if (awIdx < 0 || swParams[awIdx]!.type !== 'Double' || swParams[awIdx + 1]?.label !== 'resolver') {
				out.push(`${method}: Swift must declare authWindowSeconds: Double directly before resolver`)
			}
		}

		if (oc) {
			const aw = oc.pairs.find((p) => p.label === 'authWindowSeconds')
			if (!aw || aw.type !== 'double') out.push(`${method}: ObjC must declare authWindowSeconds:(double)authWindowSeconds`)
			const body = objcBody(t.objc, method)!
			if (!body.includes('authWindowSeconds:(double)authWindowSeconds')) {
				out.push(`${method}: ObjC extern lacks authWindowSeconds:(double)authWindowSeconds`)
			}
		}
	}

	// Kotlin helper signatures and the module's named-argument pass-through.
	for (const [fn, callee] of [
		['wrap', 'secretWrapHelper.wrap'],
		['unwrap', 'secretWrapHelper.unwrap'],
	] as const) {
		const decl = new RegExp(`fun ${fn}\\(([\\s\\S]*?)\\)\\s*\\{`).exec(t.kotlinHelper)
		if (!decl) out.push(`SecretWrapHelper.${fn}: declaration not found`)
		else if (!splitParams(decl[1]!).some((p) => p.replace(/\s+/g, ' ') === 'authWindowSeconds: Int')) {
			out.push(`SecretWrapHelper.${fn}: must declare authWindowSeconds: Int`)
		}
		const call = callBlock(t.kotlinModule, callee)
		if (!call) out.push(`AttestationNativeModule: ${callee}( call not found`)
		else if (!call.includes('authWindowSeconds = ')) out.push(`AttestationNativeModule: ${callee}( call lacks authWindowSeconds = `)
	}

	// The JS and Kotlin bounds must be the same number.
	const tsMax = kotlinConst(t.secretWrapTs, /export const MAX_AUTH_WINDOW_SECONDS\s*=\s*(\d+)/)
	const ktMax = kotlinConst(t.kotlinHelper, /internal const val MAX_AUTH_WINDOW_SECONDS\s*=\s*(\d+)/)
	if (tsMax === undefined) out.push('secret-wrap.ts: MAX_AUTH_WINDOW_SECONDS not found')
	if (ktMax === undefined) out.push('SecretWrapHelper.kt: MAX_AUTH_WINDOW_SECONDS not found')
	if (tsMax !== undefined && ktMax !== undefined && tsMax !== ktMax) {
		out.push(`MAX_AUTH_WINDOW_SECONDS differs: TS ${tsMax} vs Kotlin ${ktMax}`)
	}

	return out
}

describe('secret-wrap ABI parity across spec, Kotlin, Swift and ObjC (D-14)', () => {
	it('is reading the attestation-native package (path sanity)', () => {
		const pkgJson = join(PKG, 'package.json')
		expect(existsSync(pkgJson)).toBe(true)
		expect((JSON.parse(readRepo(pkgJson)) as { name: string }).name).toBe('@votetorrent/attestation-native')
	})

	it('the real four layers agree: no mismatches', () => {
		expect(compareSecretWrapAbi(loadTexts())).toEqual([])
	})

	it.each(METHODS)('%s: the Swift @objc selector and the ObjC extern selector equal the expected literal', (method) => {
		const t = loadTexts()
		const swift = swiftSelector(stripCommentsPreservingLines(t.swift), method)
		const objc = objcParts(stripCommentsPreservingLines(t.objc), method)?.selector
		expect(swift).toBe(EXPECTED_SELECTOR[method])
		expect(objc).toBe(EXPECTED_SELECTOR[method])
	})

	it.each(METHODS)('%s: the spec ends authWindowSeconds: number and Kotlin ends authWindowSeconds: Double', (method) => {
		const t = loadTexts()
		const spec = specParams(stripCommentsPreservingLines(t.spec), method)!
		expect(spec[spec.length - 1]).toEqual({ name: 'authWindowSeconds', type: 'number' })
		const kt = kotlinParams(stripCommentsPreservingLines(t.kotlinModule), method)!
		expect(kt[kt.length - 2]).toEqual({ name: 'authWindowSeconds', type: 'Double' })
		expect(kt[kt.length - 1]!.name).toBe('promise')
	})

	it('the TS and Kotlin MAX_AUTH_WINDOW_SECONDS are the same number (60)', () => {
		const t = loadTexts()
		expect(kotlinConst(t.secretWrapTs, /export const MAX_AUTH_WINDOW_SECONDS\s*=\s*(\d+)/)).toBe(60)
		expect(kotlinConst(t.kotlinHelper, /internal const val MAX_AUTH_WINDOW_SECONDS\s*=\s*(\d+)/)).toBe(60)
	})

	describe('planted-mismatch self-tests: the gate can fail', () => {
		it('dropping authWindowSeconds from the ObjC wrapSecret extern reports a wrapSecret mismatch', () => {
			const t = loadTexts()
			const body = objcBody(t.objc, 'wrapSecret')!
			const planted = t.objc.replace(body, body.replace(/\s*authWindowSeconds:\(double\)authWindowSeconds\s*\n/, '\n'))
			expect(planted).not.toBe(t.objc)
			const problems = compareSecretWrapAbi({ ...t, objc: planted })
			expect(problems.some((p) => p.startsWith('wrapSecret:'))).toBe(true)
		})

		it('an ObjC text whose correct selector appears ONLY inside a comment reports a mismatch', () => {
			const t = loadTexts()
			const onlyComment = `// RCT_EXTERN_METHOD(wrapSecret:(NSString *)keyAlias plaintextBase64:(NSString *)p authWindowSeconds:(double)authWindowSeconds)\n/* RCT_EXTERN_METHOD(unwrapSecret:(NSString *)keyAlias) */\n`
			const problems = compareSecretWrapAbi({ ...t, objc: onlyComment })
			expect(problems.some((p) => p.startsWith('wrapSecret:') && p.includes('not found'))).toBe(true)
			expect(problems.some((p) => p.startsWith('unwrapSecret:') && p.includes('not found'))).toBe(true)
		})

		it('removing authWindowSeconds: Double from the Kotlin unwrapSecret override reports an unwrapSecret mismatch', () => {
			const t = loadTexts()
			const start = t.kotlinModule.indexOf('override fun unwrapSecret(')
			expect(start).toBeGreaterThan(-1)
			const head = t.kotlinModule.slice(0, start)
			const tail = t.kotlinModule.slice(start).replace(/\s*authWindowSeconds: Double,/, '')
			const planted = head + tail
			expect(planted).not.toBe(t.kotlinModule)
			const problems = compareSecretWrapAbi({ ...t, kotlinModule: planted })
			expect(problems.some((p) => p.startsWith('unwrapSecret:'))).toBe(true)
			expect(problems.some((p) => p.startsWith('wrapSecret:'))).toBe(false)
		})

		it('a Swift selector that drifts from the ObjC selector is reported', () => {
			const t = loadTexts()
			const planted = t.swift.replace('promptNegativeButton:authWindowSeconds:resolver:rejecter:)', 'promptNegativeButton:resolver:rejecter:)')
			expect(planted).not.toBe(t.swift)
			expect(compareSecretWrapAbi({ ...t, swift: planted }).length).toBeGreaterThan(0)
		})

		it('a differing Kotlin MAX_AUTH_WINDOW_SECONDS is reported', () => {
			const t = loadTexts()
			const planted = t.kotlinHelper.replace(/(internal const val MAX_AUTH_WINDOW_SECONDS\s*=\s*)\d+/, '$199')
			expect(planted).not.toBe(t.kotlinHelper)
			expect(compareSecretWrapAbi({ ...t, kotlinHelper: planted }).some((p) => p.includes('MAX_AUTH_WINDOW_SECONDS differs'))).toBe(true)
		})

		it('the wrapSecret extractor never matches inside unwrapSecret', () => {
			const specOnlyUnwrap = 'unwrapSecret(\n\t\tkeyAlias: string,\n\t\tauthWindowSeconds: number,\n\t): Promise<Object>\n'
			expect(specParams(specOnlyUnwrap, 'wrapSecret')).toBeUndefined()
			const kotlinOnlyUnwrap = 'override fun unwrapSecret(keyAlias: String, promise: Promise) {'
			expect(kotlinParams(kotlinOnlyUnwrap, 'wrapSecret')).toBeUndefined()
			const swiftOnlyUnwrap = '@objc(unwrapSecret:a:resolver:rejecter:)\nfunc unwrapSecret(_ a: String) {'
			expect(swiftSelector(swiftOnlyUnwrap, 'wrapSecret')).toBeUndefined()
			expect(swiftParams(swiftOnlyUnwrap, 'wrapSecret')).toBeUndefined()
			expect(objcBody('RCT_EXTERN_METHOD(unwrapSecret:(NSString *)a)', 'wrapSecret')).toBeUndefined()
		})
	})
})
