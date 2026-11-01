/**
 * sign-cancel-abi.gate.test.ts - the new native cancel export and the busy reject code must agree
 * across the four ABI layers (codegen spec, Kotlin override, Swift selector, ObjC extern) plus the
 * JS barrel, and both platforms' device-key and recovery-key sign paths must reach the busy
 * rejection. On Kotlin that means a `settle.error("PROMPT_BUSY", ...)` call inside the path's own
 * body, in the `if (pending == null)` block that follows `tryReserve(` and in the block that refuses
 * when a BiometricFragment is already attached; a reservation that returns without settling (a
 * hang) does not count (review IN-02). Sibling of review-native-abi.gate.test.ts and secret-wrap-abi.gate.test.ts; same
 * comment-stripping approach. The comparator is pure, so the planted-mismatch self-tests prove
 * the gate can fail, and a pattern that appears only in a comment never satisfies it.
 *
 * `typecheck:ios` compiles only the Swift, never the .m, so a Swift/ObjC selector drift would be an
 * "unrecognized selector" crash on first call; this is the only check on that selector pair.
 * The vault prompts (wrap/unwrap) must stay out of the cancel path on the Kotlin side.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function strip(src: string): string {
	const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))
	return noBlock.replace(/\/\/.*$/gm, '')
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const PKG = join(REPO_ROOT, 'packages', 'attestation-native')
const KOTLIN_DIR = join(PKG, 'android', 'src', 'main', 'java', 'org', 'votetorrent', 'attestationnative')

/** The busy settle a Kotlin sign path must make: the literal code passed to settle-once's error. */
const KOTLIN_BUSY_SETTLE = /\bsettle\.error\(\s*"PROMPT_BUSY"/

interface Texts {
	spec: string
	index: string
	kotlinModule: string
	kotlinHelper: string
	kotlinGate: string
	kotlinSecretWrap: string
	swift: string
	objc: string
}

function load(): Texts {
	const r = (p: string): string => readFileSync(p, 'utf8')
	const gatePath = join(KOTLIN_DIR, 'PendingSignGate.kt')
	return {
		spec: r(join(PKG, 'src', 'specs', 'NativeAttestation.ts')),
		index: r(join(PKG, 'src', 'index.ts')),
		kotlinModule: r(join(KOTLIN_DIR, 'AttestationNativeModule.kt')),
		kotlinHelper: r(join(KOTLIN_DIR, 'KeyAttestationHelper.kt')),
		kotlinGate: existsSync(gatePath) ? r(gatePath) : '',
		kotlinSecretWrap: r(join(KOTLIN_DIR, 'SecretWrapHelper.kt')),
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

/** The JSDoc block that sits directly above the declaration of [methodName], read from RAW text. */
function docBefore(raw: string, methodName: string): string | undefined {
	const decl = new RegExp(`^[ \\t]*${methodName}\\(`, 'm').exec(raw)
	if (!decl) return undefined
	const head = raw.slice(0, decl.index)
	const end = head.lastIndexOf('*/')
	if (end < 0) return undefined
	if (head.slice(end + 2).trim() !== '') return undefined
	const start = head.lastIndexOf('/**', end)
	if (start < 0) return undefined
	return head.slice(start, end + 2)
}

/** Brace-balanced block of the first `if (...)` matching [cond] at or after [from] in [text]. */
function ifBlock(text: string, cond: RegExp, from = 0): string | undefined {
	const tail = text.slice(from)
	const m = cond.exec(tail)
	if (!m) return undefined
	return body(tail.slice(m.index), /^/)
}

/**
 * Problems with one Kotlin sign path's busy handling, read from that path's own function bodies:
 * the body that reserves the gate must settle PROMPT_BUSY in the null branch right after
 * `tryReserve(`, and must settle PROMPT_BUSY when a fragment is already attached.
 */
function kotlinBusyProblems(label: string, bodies: Array<string | undefined>): string[] {
	const own = bodies.find((b) => b?.includes('tryReserve('))
	if (own === undefined) return [`kotlin: the ${label} sign path never reaches the busy rejection (no tryReserve( in its own body)`]
	const out: string[] = []
	const nullBranch = ifBlock(own, /if\s*\(\s*pending\s*==\s*null\s*\)/, own.indexOf('tryReserve('))
	if (nullBranch === undefined || !KOTLIN_BUSY_SETTLE.test(nullBranch)) {
		out.push(`kotlin: the ${label} sign path never reaches the busy rejection (no settle.error("PROMPT_BUSY" in the null branch after tryReserve()`)
	}
	const showing = ifBlock(own, /if\s*\(\s*isBiometricFragmentAttached\(/)
	if (showing === undefined || !KOTLIN_BUSY_SETTLE.test(showing)) {
		out.push(`kotlin: the ${label} sign path never reaches the busy rejection (no settle.error("PROMPT_BUSY" when a fragment is attached)`)
	}
	return out
}

export function compare(raw: Texts): string[] {
	const t = {
		spec: strip(raw.spec),
		index: strip(raw.index),
		kotlinModule: strip(raw.kotlinModule),
		kotlinHelper: strip(raw.kotlinHelper),
		kotlinGate: strip(raw.kotlinGate),
		kotlinSecretWrap: strip(raw.kotlinSecretWrap),
		swift: strip(raw.swift),
		objc: strip(raw.objc),
	}
	const out: string[] = []

	// --- spec ---
	if (!/\bcancelPendingSign\(\): Promise<Object>/.test(t.spec)) out.push('spec: cancelPendingSign(): Promise<Object> not found')
	for (const m of ['signWithDeviceKey', 'signWithRecoveryKey']) {
		const doc = docBefore(raw.spec, m)
		if (doc === undefined) out.push(`spec: ${m} has no doc block directly above it`)
		else if (!doc.includes('PROMPT_BUSY')) out.push(`spec: ${m} reject list lacks PROMPT_BUSY`)
	}

	// --- JS barrel ---
	if (!/export\s*\{[^}]*\bcancelPendingSign\b[^}]*\}\s*from\s*'\.\/sign-cancel'/.test(t.index)) out.push('ts: index does not export cancelPendingSign from ./sign-cancel')
	if (/export\s*\{\s*default\b/.test(t.index) || /export\s+default\b/.test(t.index)) out.push('ts: index re-exports a default (the TurboModule must stay un-exported)')

	// --- Kotlin ---
	const kAll = [t.kotlinModule, t.kotlinHelper, t.kotlinGate].join('\n')
	if (!/override fun cancelPendingSign\(promise: Promise\)\s*\{/.test(t.kotlinModule)) out.push('kotlin: cancelPendingSign override not found')
	if (!kAll.includes('"PROMPT_BUSY"')) out.push('kotlin: no "PROMPT_BUSY" string literal in the Kotlin sources')
	if (!kAll.includes('cancelAuthentication(')) out.push('kotlin: cancelAuthentication( never called')
	out.push(...kotlinBusyProblems('device-key', [body(t.kotlinModule, /override fun signWithDeviceKey\(/), body(t.kotlinHelper, /\bfun signWithDeviceKey\(/)]))
	out.push(
		...kotlinBusyProblems('recovery-key', [
			body(t.kotlinModule, /override fun signWithRecoveryKey\(/),
			body(t.kotlinHelper, /\bfun signWithRecoveryKey\(/),
			body(t.kotlinHelper, /\bfun signRecoveryViaBiometricPrompt\(/),
		]),
	)
	if (!body(t.kotlinGate, /\bfun tryReserve\(/) && !body(t.kotlinHelper, /\bfun tryReserve\(/)) out.push('kotlin: the busy check tryReserve not found')
	if (t.kotlinSecretWrap.includes('cancelAuthentication(')) out.push('kotlin: SecretWrapHelper calls cancelAuthentication (the cancel must never target a vault prompt)')
	if (t.kotlinSecretWrap.includes('cancelPendingSign')) out.push('kotlin: SecretWrapHelper references cancelPendingSign (vault prompts stay out of the cancel path)')

	// --- Swift ---
	const sel = /@objc\((cancelPendingSign:[^)]*)\)/.exec(t.swift)?.[1]
	if (sel !== 'cancelPendingSign:rejecter:') out.push(`swift: cancelPendingSign selector ${String(sel)}`)
	if (!/func cancelPendingSign\([^)]*RCTPromiseResolveBlock[^)]*RCTPromiseRejectBlock[^)]*\)/.test(t.swift)) out.push('swift: func cancelPendingSign( does not take RCTPromiseResolveBlock then RCTPromiseRejectBlock')
	const signWith = body(t.swift, /func signWith\(/)
	if (signWith === undefined) out.push('swift: func signWith( not found')
	else {
		if (!signWith.includes('"PROMPT_BUSY"')) {
			const dev = body(t.swift, /func signWithDeviceKey\(/)
			const rec = body(t.swift, /func signWithRecoveryKey\(/)
			if (!(dev?.includes('"PROMPT_BUSY"') && rec?.includes('"PROMPT_BUSY"'))) out.push('swift: neither signWith nor both public sign entries reject "PROMPT_BUSY"')
		}
		if (!signWith.includes('LAContext(')) out.push('swift: signWith does not create an LAContext')
	}
	const load_ = body(t.swift, /func loadKey\(/)
	if (load_ === undefined || !load_.includes('kSecUseAuthenticationContext')) out.push('swift: loadKey does not pass kSecUseAuthenticationContext')
	const cancel = body(t.swift, /func cancelPendingSign\(/)
	if (cancel === undefined || !cancel.includes('invalidate()')) out.push('swift: cancelPendingSign does not invalidate() the held context')

	// --- ObjC ---
	if (!/RCT_EXTERN_METHOD\(cancelPendingSign:\(RCTPromiseResolveBlock\)resolve\s+rejecter:\(RCTPromiseRejectBlock\)reject\)/.test(t.objc)) out.push('objc: cancelPendingSign extern not found or drifted')

	return out
}

describe('sign cancel ABI: spec, barrel, Kotlin, Swift and ObjC agree', () => {
	it('the real layers agree', () => {
		expect(compare(load())).toEqual([])
	})
})

describe('planted-mismatch self-tests: the gate can fail', () => {
	function plant(k: keyof Texts, from: string | RegExp, to: string): Texts {
		const t = load()
		const next = t[k].replace(from, to)
		if (next === t[k]) throw new Error(`plant on ${k} did not change the text: ${String(from)}`)
		return { ...t, [k]: next }
	}
	function plantAll(k: keyof Texts, from: string, to: string): Texts {
		const t = load()
		const next = t[k].split(from).join(to)
		if (next === t[k]) throw new Error(`plantAll on ${k} did not change the text: ${from}`)
		return { ...t, [k]: next }
	}
	const has = (t: Texts, prefix: string, frag?: string) => compare(t).some((p) => p.startsWith(prefix) && (frag === undefined || p.includes(frag)))

	it('spec method renamed', () => {
		expect(has(plant('spec', /^\s*cancelPendingSign\(\)/m, '\tcancelPendingSigns()'), 'spec:', 'cancelPendingSign()')).toBe(true)
	})
	it('every busy code removed from the spec', () => {
		const t = plantAll('spec', 'PROMPT_BUSY', 'PROMPT_OTHER')
		expect(has(t, 'spec:', 'signWithDeviceKey')).toBe(true)
		expect(has(t, 'spec:', 'signWithRecoveryKey')).toBe(true)
	})
	it('busy code removed from the recovery reject list only', () => {
		const t = load()
		const doc = docBefore(t.spec, 'signWithRecoveryKey') as string
		const planted = { ...t, spec: t.spec.replace(doc, doc.split('PROMPT_BUSY').join('PROMPT_OTHER')) }
		expect(planted.spec).not.toBe(t.spec)
		expect(has(planted, 'spec:', 'signWithRecoveryKey')).toBe(true)
		expect(has(planted, 'spec:', 'signWithDeviceKey')).toBe(false)
	})
	it('barrel export removed', () => {
		expect(has(plant('index', /cancelPendingSign, /, ''), 'ts:')).toBe(true)
	})
	it('Kotlin override renamed to a non-override', () => {
		expect(has(plant('kotlinModule', 'override fun cancelPendingSign(promise: Promise)', 'fun cancelPendingSignX(promise: Promise)'), 'kotlin:', 'override')).toBe(true)
	})
	it('busy literal only in a comment does not count', () => {
		const t = load()
		const planted: Texts = {
			...t,
			kotlinModule: t.kotlinModule.split('"PROMPT_BUSY"').join('"PROMPT_OTHER"'),
			kotlinHelper: t.kotlinHelper.split('"PROMPT_BUSY"').join('"PROMPT_OTHER"') + '\n// "PROMPT_BUSY"\n',
			kotlinGate: t.kotlinGate.split('"PROMPT_BUSY"').join('"PROMPT_OTHER"'),
		}
		expect(planted.kotlinHelper).not.toBe(t.kotlinHelper)
		expect(has(planted, 'kotlin:', 'string literal')).toBe(true)
	})
	it('busy markers removed from the recovery path only', () => {
		const t = load()
		const i = t.kotlinHelper.indexOf('private fun signRecoveryViaBiometricPrompt(')
		expect(i).toBeGreaterThan(0)
		const tail = t.kotlinHelper.slice(i).split('"PROMPT_BUSY"').join('"PROMPT_OTHER"').split('tryReserve(').join('tryReserveX(')
		const planted = { ...t, kotlinHelper: t.kotlinHelper.slice(0, i) + tail }
		expect(has(planted, 'kotlin:', 'recovery-key')).toBe(true)
		expect(has(planted, 'kotlin:', 'device-key')).toBe(false)
	})
	it('busy markers removed from the device path only', () => {
		const t = load()
		const i = t.kotlinHelper.indexOf('\tfun signWithDeviceKey(')
		const j = t.kotlinHelper.indexOf('\tfun signWithRecoveryKey(')
		expect(i).toBeGreaterThan(0)
		expect(j).toBeGreaterThan(i)
		const mid = t.kotlinHelper.slice(i, j).split('"PROMPT_BUSY"').join('"PROMPT_OTHER"').split('tryReserve(').join('tryReserveX(')
		const planted = { ...t, kotlinHelper: t.kotlinHelper.slice(0, i) + mid + t.kotlinHelper.slice(j) }
		expect(has(planted, 'kotlin:', 'device-key')).toBe(true)
	})
	/** Deletes the first `settle.error("PROMPT_BUSY", ...)` line after the [nth] (0-based) match of [anchor] in the helper. */
	function deleteBusySettleAfter(anchor: string, nth = 0): Texts {
		const t = load()
		let a = -1
		for (let k = 0; k <= nth; k++) a = t.kotlinHelper.indexOf(anchor, a + 1)
		expect(a).toBeGreaterThan(0)
		const s = t.kotlinHelper.indexOf('settle.error("PROMPT_BUSY"', a)
		expect(s).toBeGreaterThan(a)
		const e = t.kotlinHelper.indexOf('\n', s)
		const planted = { ...t, kotlinHelper: t.kotlinHelper.slice(0, s) + t.kotlinHelper.slice(e) }
		expect(planted.kotlinHelper).not.toBe(t.kotlinHelper)
		// Only that one call is gone: tryReserve and the other busy settles are still there.
		expect(planted.kotlinHelper.split('tryReserve(').length).toBe(t.kotlinHelper.split('tryReserve(').length)
		expect(planted.kotlinHelper.split('settle.error("PROMPT_BUSY"').length).toBe(t.kotlinHelper.split('settle.error("PROMPT_BUSY"').length - 1)
		return planted
	}
	it('device path: only the busy settle after tryReserve deleted (reserve then hang)', () => {
		const planted = deleteBusySettleAfter('PendingSignKind.DEVICE')
		expect(has(planted, 'kotlin:', 'device-key')).toBe(true)
		expect(has(planted, 'kotlin:', 'recovery-key')).toBe(false)
	})
	it('recovery path: only the busy settle after tryReserve deleted (reserve then hang)', () => {
		const planted = deleteBusySettleAfter('PendingSignKind.RECOVERY')
		expect(has(planted, 'kotlin:', 'recovery-key')).toBe(true)
		expect(has(planted, 'kotlin:', 'device-key')).toBe(false)
	})
	it('device path: only the busy settle for an attached fragment deleted', () => {
		const t = load()
		const dev = t.kotlinHelper.indexOf('\tfun signWithDeviceKey(')
		const first = t.kotlinHelper.indexOf('if (isBiometricFragmentAttached(activity))')
		expect(first).toBeGreaterThan(dev)
		const planted = deleteBusySettleAfter('if (isBiometricFragmentAttached(activity))', 0)
		expect(has(planted, 'kotlin:', 'device-key sign path never reaches the busy rejection (no settle.error("PROMPT_BUSY" when a fragment')).toBe(true)
		expect(has(planted, 'kotlin:', 'recovery-key')).toBe(false)
	})
	it('cancelAuthentication call removed', () => {
		const t = load()
		const planted: Texts = {
			...t,
			kotlinModule: t.kotlinModule.split('cancelAuthentication(').join('cancelAuth('),
			kotlinHelper: t.kotlinHelper.split('cancelAuthentication(').join('cancelAuth('),
			kotlinGate: t.kotlinGate.split('cancelAuthentication(').join('cancelAuth('),
		}
		expect(planted.kotlinHelper).not.toBe(t.kotlinHelper)
		expect(has(planted, 'kotlin:', 'cancelAuthentication')).toBe(true)
	})
	it('a cancel call inside the vault helper', () => {
		expect(has(plant('kotlinSecretWrap', /\n$/, '\nprompt.cancelAuthentication()\n'), 'kotlin:', 'SecretWrapHelper')).toBe(true)
	})
	it('Swift selector drops its rejecter label', () => {
		expect(has(plant('swift', '@objc(cancelPendingSign:rejecter:)', '@objc(cancelPendingSign:)'), 'swift:', 'selector')).toBe(true)
	})
	it('Swift busy literal removed', () => {
		expect(has(plantAll('swift', '"PROMPT_BUSY"', '"PROMPT_OTHER"'), 'swift:', 'PROMPT_BUSY')).toBe(true)
	})
	it('Swift loadKey stops passing the authentication context', () => {
		expect(has(plantAll('swift', 'kSecUseAuthenticationContext', 'kSecUseOther'), 'swift:', 'kSecUseAuthenticationContext')).toBe(true)
	})
	it('Swift cancel stops invalidating the context', () => {
		expect(has(plantAll('swift', 'invalidate()', 'noop()'), 'swift:', 'invalidate')).toBe(true)
	})
	it('ObjC extern present only inside a comment', () => {
		expect(has(plant('objc', /^RCT_EXTERN_METHOD\(cancelPendingSign:/m, '// RCT_EXTERN_METHOD(cancelPendingSign:'), 'objc:')).toBe(true)
	})
	it('ObjC extern with a drifted rejecter label', () => {
		expect(has(plant('objc', /cancelPendingSign:\(RCTPromiseResolveBlock\)resolve rejecter:/, 'cancelPendingSign:(RCTPromiseResolveBlock)resolve rejector:'), 'objc:')).toBe(true)
	})
})
