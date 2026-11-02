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
 *
 * Phase 65 review round 3 adds the reject-code contract of the two sign paths:
 *   - CR-01: a system cancel rejects `SYSTEM_CANCELED` (Android `ERROR_CANCELED` in each sign
 *     callback; iOS `LAError.systemCancel`/`.appCancel` in `signWith`), the voter's own dismissal
 *     stays `CANCELED`, an app cancel still settles `CANCELED`, and the vault mappings (Kotlin
 *     `SecretWrapHelper`, Swift `mapOSStatusOrLAError`) and `regenerateAttested` never say
 *     `SYSTEM_CANCELED`.
 *   - WR-02: an activity that cannot host a prompt, and a prompt that silently did not start,
 *     settle `NO_ACTIVITY` in each Kotlin sign path.
 *   - WR-05: every `VtSign` trace goes through one debug-gated writer per platform
 *     (`BuildConfig.DEBUG` in Kotlin, `#if DEBUG` in Swift); no ungated line exists.
 *   - WR-06: the Swift sign refuses `PROMPT_BUSY` while an earlier system call is still in flight.
 *   - UAT 65 Run 6 (F3): the Swift sign raises its sheet through a LocalAuthentication evaluation of
 *     the key's access control (`evaluateAccessControl(... operation: .useKeySign ...)`) before
 *     `SecKeyCreateSignature`, so `invalidate()` ends it, a "Face Not Recognized" alert included.
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
/** The settle a Kotlin sign path must make when no activity can host the prompt (round-3 WR-02). */
const KOTLIN_NO_ACTIVITY_SETTLE = /\bsettle\.error\(\s*"NO_ACTIVITY"/
/** CR-01: the system cancel (5) has its own code; the voter's dismissals (10, 13) stay CANCELED. */
const KOTLIN_SYSTEM_CANCEL_MAP = /BiometricPrompt\.ERROR_CANCELED\s*->\s*"SYSTEM_CANCELED"/
const KOTLIN_USER_CANCEL_MAP = /BiometricPrompt\.ERROR_USER_CANCELED\s*,\s*BiometricPrompt\.ERROR_NEGATIVE_BUTTON\s*->\s*"CANCELED"/
/** A `VtSign` line written directly instead of through the gated writer (WR-05). */
const KOTLIN_RAW_SIGN_LOG = /\bLog\.[a-z]+\(\s*TAG_SIGN\s*,/

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

/**
 * Problems with one Kotlin sign path's reject codes (CR-01, round-3 WR-02), read from the body that
 * builds its prompt: the error callback maps 5 to SYSTEM_CANCELED and 10/13 to CANCELED, and both
 * "cannot host" refusals settle NO_ACTIVITY.
 */
function kotlinCodeProblems(label: string, own: string | undefined): string[] {
	if (own === undefined) return [`kotlin: the ${label} sign path body not found`]
	const out: string[] = []
	if (!KOTLIN_SYSTEM_CANCEL_MAP.test(own)) out.push(`kotlin: the ${label} sign path does not map ERROR_CANCELED to "SYSTEM_CANCELED"`)
	if (!KOTLIN_USER_CANCEL_MAP.test(own)) out.push(`kotlin: the ${label} sign path does not map ERROR_USER_CANCELED/ERROR_NEGATIVE_BUTTON to "CANCELED"`)
	const host = ifBlock(own, /if\s*\(\s*!canHostBiometricPrompt\(/)
	if (host === undefined || !KOTLIN_NO_ACTIVITY_SETTLE.test(host)) out.push(`kotlin: the ${label} sign path does not settle "NO_ACTIVITY" when the activity cannot host a prompt`)
	const started = ifBlock(own, /if\s*\(\s*!isBiometricFragmentAttached\(/)
	if (started === undefined || !KOTLIN_NO_ACTIVITY_SETTLE.test(started)) out.push(`kotlin: the ${label} sign path does not settle "NO_ACTIVITY" when the prompt did not start`)
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
		else {
			if (!doc.includes('PROMPT_BUSY')) out.push(`spec: ${m} reject list lacks PROMPT_BUSY`)
			if (!doc.includes('SYSTEM_CANCELED')) out.push(`spec: ${m} reject list lacks SYSTEM_CANCELED`)
		}
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
	// CR-01 / round-3 WR-02: reject codes of the two sign paths, and the fences around them.
	out.push(...kotlinCodeProblems('device-key', body(t.kotlinHelper, /\bfun signWithDeviceKey\(/)))
	out.push(...kotlinCodeProblems('recovery-key', body(t.kotlinHelper, /\bfun signRecoveryViaBiometricPrompt\(/)))
	if (t.kotlinSecretWrap.includes('SYSTEM_CANCELED')) out.push('kotlin: SecretWrapHelper says SYSTEM_CANCELED (the vault mapping must not change)')
	const regen = body(t.kotlinHelper, /\bfun regenerateAttested\(/)
	if (regen === undefined) out.push('kotlin: regenerateAttested not found')
	else if (regen.includes('SYSTEM_CANCELED')) out.push('kotlin: regenerateAttested says SYSTEM_CANCELED (only the sign paths split the cancel)')
	const cancelTaken = body(t.kotlinHelper, /\bfun cancelTaken\(/)
	if (cancelTaken === undefined || !/\.settle\.error\(\s*"CANCELED"/.test(cancelTaken)) out.push('kotlin: cancelTaken does not settle "CANCELED" (an app cancel must stay CANCELED)')
	// WR-05: one gated writer; no direct VtSign line anywhere else.
	const writer = body(t.kotlinGate, /\bfun vtSignLog\(/)
	if (writer === undefined || !/if\s*\(\s*BuildConfig\.DEBUG\s*\)\s*Log\.i\(\s*TAG_SIGN\s*,/.test(writer)) out.push('kotlin: vtSignLog is missing or does not gate its Log.i(TAG_SIGN on BuildConfig.DEBUG')
	const outsideWriter = [t.kotlinModule, t.kotlinHelper, writer === undefined ? t.kotlinGate : t.kotlinGate.replace(writer, '{}')]
	if (outsideWriter.some((x) => KOTLIN_RAW_SIGN_LOG.test(x))) out.push('kotlin: a VtSign line is written outside vtSignLog (it would ship in release builds)')

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
		// CR-01: the system cancel has its own case; the user's cancel case does not include it.
		if (!/case[^:]*LAError\.systemCancel\.rawValue[^:]*:\s*code\s*=\s*"SYSTEM_CANCELED"/.test(signWith)) out.push('swift: signWith does not map LAError.systemCancel to "SYSTEM_CANCELED"')
		if (!/case[^:]*LAError\.appCancel\.rawValue[^:]*:\s*code\s*=\s*"SYSTEM_CANCELED"/.test(signWith)) out.push('swift: signWith does not map LAError.appCancel to "SYSTEM_CANCELED"')
		const userCase = /case([^:]*LAError\.userCancel\.rawValue[^:]*):\s*code\s*=\s*"CANCELED"/.exec(signWith)
		if (userCase === null) out.push('swift: signWith does not map LAError.userCancel to "CANCELED"')
		else if (/systemCancel|appCancel/.test(userCase[1])) out.push('swift: signWith maps a system cancel to "CANCELED" in the userCancel case')
		// WR-06: refuse while an earlier system call is still in flight; count it around the call.
		if (!/if\s+pendingSign\s*!=\s*nil\s*\|\|\s*systemCallsInFlight\s*>\s*0/.test(signWith)) out.push('swift: signWith does not refuse while a system call is in flight (systemCallsInFlight)')
		if (!signWith.includes('systemCallsInFlight += 1') || !signWith.includes('systemCallsInFlight -= 1')) out.push('swift: signWith does not count its system call in systemCallsInFlight')
		const evalAt = signWith.search(/\.evaluateAccessControl\([^)]*operation:\s*\.useKeySign/)
		const signAt = signWith.indexOf('SecKeyCreateSignature(')
		if (evalAt < 0) out.push('swift: signWith does not evaluate the key access control (.useKeySign) before signing')
		else if (signAt >= 0 && signAt < evalAt) out.push('swift: signWith calls SecKeyCreateSignature before it evaluates the key access control')
	}
	const vault = body(t.swift, /func mapOSStatusOrLAError\(/)
	if (vault === undefined) out.push('swift: mapOSStatusOrLAError not found')
	else if (vault.includes('SYSTEM_CANCELED')) out.push('swift: the vault mapping says SYSTEM_CANCELED (it must not change)')
	const finish = body(t.swift, /func finishPendingSign\(/)
	if (finish === undefined || !/wasCanceled\s*\{[^}]*reject\(\s*"CANCELED"/.test(finish)) out.push('swift: finishPendingSign does not reject a cancelled sign "CANCELED"')
	// WR-05: the VtSign writer is compiled only in DEBUG, and nothing else writes a VtSign line.
	const swiftWriter = body(t.swift, /func vtSignLog\(/)
	if (swiftWriter === undefined || !/#if DEBUG\s*NSLog\([^)]*\[VtSign\][^\n]*\n\s*#endif/.test(swiftWriter)) out.push('swift: vtSignLog is missing or its NSLog is not inside #if DEBUG')
	if ((swiftWriter === undefined ? t.swift : t.swift.replace(swiftWriter, '{}')).includes('[VtSign]')) out.push('swift: a [VtSign] line is written outside vtSignLog (it would ship in release builds)')
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
	/** Replaces the [nth] (0-based) occurrence of [from] in [k]. */
	function plantNth(k: keyof Texts, from: string, to: string, nth: number): Texts {
		const t = load()
		let i = -1
		for (let n = 0; n <= nth; n++) {
			i = t[k].indexOf(from, i + 1)
			if (i < 0) throw new Error(`plantNth on ${k}: occurrence ${nth} of ${from} not found`)
		}
		return { ...t, [k]: t[k].slice(0, i) + to + t[k].slice(i + from.length) }
	}

	// --- round 3: CR-01 SYSTEM_CANCELED ---
	it('spec: SYSTEM_CANCELED removed from both sign reject lists', () => {
		const t = plantAll('spec', 'SYSTEM_CANCELED', 'SYSTEM_OTHER')
		expect(has(t, 'spec:', 'signWithDeviceKey reject list lacks SYSTEM_CANCELED')).toBe(true)
		expect(has(t, 'spec:', 'signWithRecoveryKey reject list lacks SYSTEM_CANCELED')).toBe(true)
	})
	const SYS = 'BiometricPrompt.ERROR_CANCELED -> "SYSTEM_CANCELED"'
	it('Kotlin device path: ERROR_CANCELED folded back into CANCELED', () => {
		const planted = plantNth('kotlinHelper', SYS, 'BiometricPrompt.ERROR_CANCELED -> "CANCELED"', 0)
		expect(has(planted, 'kotlin:', 'device-key sign path does not map ERROR_CANCELED')).toBe(true)
		expect(has(planted, 'kotlin:', 'recovery-key sign path does not map ERROR_CANCELED')).toBe(false)
	})
	it('Kotlin recovery path: ERROR_CANCELED folded back into CANCELED', () => {
		const planted = plantNth('kotlinHelper', SYS, 'BiometricPrompt.ERROR_CANCELED -> "CANCELED"', 1)
		expect(has(planted, 'kotlin:', 'recovery-key sign path does not map ERROR_CANCELED')).toBe(true)
		expect(has(planted, 'kotlin:', 'device-key sign path does not map ERROR_CANCELED')).toBe(false)
	})
	it('Kotlin device path: the voter dismissal (10/13) no longer CANCELED', () => {
		const planted = plantNth('kotlinHelper', 'BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"', 'BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "SYSTEM_CANCELED"', 1)
		expect(has(planted, 'kotlin:', 'device-key sign path does not map ERROR_USER_CANCELED')).toBe(true)
	})
	it('Kotlin vault helper starts saying SYSTEM_CANCELED', () => {
		expect(has(plant('kotlinSecretWrap', /\n$/, '\nval x = "SYSTEM_CANCELED"\n'), 'kotlin:', 'SecretWrapHelper says SYSTEM_CANCELED')).toBe(true)
	})
	it('Kotlin regenerateAttested starts saying SYSTEM_CANCELED', () => {
		const planted = plantNth('kotlinHelper', 'BiometricPrompt.ERROR_CANCELED,', 'BiometricPrompt.ERROR_CANCELED -> "SYSTEM_CANCELED"\n\t\t\t\t\t\tBiometricPrompt.ERROR_CANCELED,', 0)
		expect(has(planted, 'kotlin:', 'regenerateAttested says SYSTEM_CANCELED')).toBe(true)
	})
	it('Kotlin app cancel settles something other than CANCELED', () => {
		expect(has(plant('kotlinHelper', 'p.settle.error("CANCELED"', 'p.settle.error("SYSTEM_CANCELED"'), 'kotlin:', 'cancelTaken')).toBe(true)
	})

	// --- round 3: WR-02 NO_ACTIVITY ---
	it('Kotlin device path: host-cannot-show back to BIOMETRIC_ERROR', () => {
		const planted = plantNth('kotlinHelper', 'settle.error("NO_ACTIVITY", IllegalStateException("the activity cannot host', 'settle.error("BIOMETRIC_ERROR", IllegalStateException("the activity cannot host', 0)
		expect(has(planted, 'kotlin:', 'device-key sign path does not settle "NO_ACTIVITY" when the activity cannot host')).toBe(true)
		expect(has(planted, 'kotlin:', 'recovery-key sign path does not settle "NO_ACTIVITY"')).toBe(false)
	})
	it('Kotlin recovery path: prompt-not-started back to BIOMETRIC_ERROR', () => {
		const planted = plantNth('kotlinHelper', 'settle.error("NO_ACTIVITY", IllegalStateException("the biometric prompt was not started', 'settle.error("BIOMETRIC_ERROR", IllegalStateException("the biometric prompt was not started', 1)
		expect(has(planted, 'kotlin:', 'recovery-key sign path does not settle "NO_ACTIVITY" when the prompt did not start')).toBe(true)
		expect(has(planted, 'kotlin:', 'device-key sign path does not settle "NO_ACTIVITY"')).toBe(false)
	})

	// --- round 3: WR-05 release gating ---
	it('Kotlin: the VtSign writer loses its BuildConfig.DEBUG gate', () => {
		expect(has(plant('kotlinGate', 'if (BuildConfig.DEBUG) Log.i(TAG_SIGN, line)', 'Log.i(TAG_SIGN, line)'), 'kotlin:', 'vtSignLog')).toBe(true)
	})
	it('Kotlin: an ungated Log.i(TAG_SIGN line planted in the helper', () => {
		const planted = plantNth('kotlinHelper', 'vtSignLog("sign start kind=DEVICE")', 'Log.i(TAG_SIGN, "sign start kind=DEVICE")', 0)
		expect(has(planted, 'kotlin:', 'outside vtSignLog')).toBe(true)
	})
	it('Kotlin: an ungated line only in a comment does not count', () => {
		expect(has(plant('kotlinHelper', /\n$/, '\n// Log.i(TAG_SIGN, "x")\n'), 'kotlin:', 'outside vtSignLog')).toBe(false)
	})
	it('Swift: the VtSign writer loses its #if DEBUG', () => {
		const t = load()
		const planted = { ...t, swift: t.swift.replace(/#if DEBUG\n(\s*NSLog\("%@", "\[VtSign\] ")/, '$1') }
		expect(planted.swift).not.toBe(t.swift)
		expect(has(planted, 'swift:', 'vtSignLog')).toBe(true)
	})
	it('Swift: a raw [VtSign] NSLog planted outside the writer', () => {
		expect(has(plant('swift', /\n$/, '\nfunc x() { NSLog("%@", "[VtSign] leak") }\n'), 'swift:', 'outside vtSignLog')).toBe(true)
	})

	// --- round 3: CR-01 / WR-06 Swift ---
	it('Swift: systemCancel folded back into the userCancel case', () => {
		const t = load()
		const planted = { ...t, swift: t.swift.replace('LAError.userCancel.rawValue, LAError.userFallback.rawValue:', 'LAError.userCancel.rawValue, LAError.systemCancel.rawValue, LAError.userFallback.rawValue:') }
		expect(planted.swift).not.toBe(t.swift)
		expect(has(planted, 'swift:', 'system cancel to "CANCELED"')).toBe(true)
	})
	it('Swift: systemCancel mapped to CANCELED in its own case', () => {
		expect(has(plant('swift', 'code = "SYSTEM_CANCELED"', 'code = "CANCELED"'), 'swift:', 'systemCancel to "SYSTEM_CANCELED"')).toBe(true)
	})
	it('Swift: the vault mapping starts saying SYSTEM_CANCELED', () => {
		expect(has(plant('swift', 'return .code("CANCELED", "authentication cancelled")', 'return .code("SYSTEM_CANCELED", "authentication cancelled")'), 'swift:', 'vault mapping')).toBe(true)
	})
	it('Swift: a cancelled sign no longer forced to CANCELED', () => {
		expect(has(plant('swift', 'reject("CANCELED", "signing was cancelled", nil)\n    } else {', 'reject("SYSTEM_CANCELED", "signing was cancelled", nil)\n    } else {'), 'swift:', 'finishPendingSign')).toBe(true)
	})
	it('Swift: the in-flight refusal removed', () => {
		expect(has(plant('swift', 'if pendingSign != nil || systemCallsInFlight > 0 {', 'if pendingSign != nil {'), 'swift:', 'in flight')).toBe(true)
	})
	it('Swift: the in-flight counter never decremented', () => {
		expect(has(plant('swift', 'systemCallsInFlight -= 1', 'systemCallsInFlight -= 0'), 'swift:', 'count its system call')).toBe(true)
	})
	it('Swift sign no longer evaluates the key access control (SecKeyCreateSignature would raise the sheet itself)', () => {
		expect(has(plant('swift', 'operation: .useKeySign', 'operation: .useItem'), 'swift:', 'evaluate the key access control')).toBe(true)
	})
	it('Swift sign signs before it evaluates', () => {
		const t = load()
		const sig = t.swift.indexOf('SecKeyCreateSignature(key, .ecdsaSignatureDigestX962SHA256')
		const ev = t.swift.indexOf('pending.context.evaluateAccessControl(')
		expect(sig).toBeGreaterThan(ev)
		const planted = { ...t, swift: t.swift.slice(0, ev) + 'let _early = SecKeyCreateSignature(key, .ecdsaSignatureDigestX962SHA256, digest as CFData, nil)\n' + t.swift.slice(ev) }
		expect(has(planted, 'swift:', 'before it evaluates')).toBe(true)
	})
})
