/**
 * secret-wrap-window.gate.test.ts — D-14 (Phase 63 plan 17): structural gate over
 * `SecretWrapHelper.kt`, the Android time-bound wrap path.
 *
 * Why this gate exists: there are no Kotlin unit tests in attestation-native, so this structural
 * gate, the Kotlin compile and the debug APK's dex check are the only pre-device evidence for the
 * windowed branch. Real prompt counts come only from 63-18's `prompts` leg on a device.
 *
 * Phase 63 review: WR-04 removed the pre-API-30 time-bound key (`setUserAuthenticationValidityDurationSeconds`
 * admits a PIN), so G2 now pins that setter to ZERO occurrences and G7 pins the below-30 downgrade.
 * CR-02 added exactly one `deleteEntry`, inside the alias-restricted `deleteWrapKey`, so G6 pins
 * that instead of "never delete". The D-14 assertions (G3-G5) are unchanged.
 *
 * Every check runs on COMMENT-STRIPPED text (except G1, which deliberately scans the raw file), so
 * KDoc prose cannot satisfy or trip a structural rule. The checker is a pure function so the planted
 * self-tests below can prove it can fail.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function stripCommentsPreservingLines(src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const PKG = join(REPO_ROOT, 'packages', 'attestation-native')
const HELPER = join(
	PKG,
	'android',
	'src',
	'main',
	'java',
	'org',
	'votetorrent',
	'attestationnative',
	'SecretWrapHelper.kt',
)

/**
 * Brace-balanced body of the function whose declaration matches [signature]. Returns undefined
 * when the declaration is absent. The walk starts at the first `{` after the match.
 */
function functionBody(stripped: string, signature: RegExp): string | undefined {
	const m = signature.exec(stripped)
	if (!m) return undefined
	const open = stripped.indexOf('{', m.index + m[0].length)
	if (open < 0) return undefined
	let depth = 0
	for (let i = open; i < stripped.length; i++) {
		const ch = stripped[i]
		if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) return stripped.slice(open, i + 1)
		}
	}
	return undefined
}

function count(text: string, needle: string): number {
	return text.split(needle).length - 1
}

/** Pure checker: readable violation strings, empty when the file satisfies G1..G6. */
export function checkSecretWrapWindow(kotlinText: string): string[] {
	const violations: string[] = []
	const stripped = stripCommentsPreservingLines(kotlinText)

	// G1: the raw file, comments included, must not mention the removed 63-16 guard.
	if (kotlinText.includes('pass-through' + ' guard')) {
		violations.push('G1: the file still mentions the 63-16 pass-through guard')
	}

	// G2: buildSpec carries the BIOMETRIC_STRONG spec calls and refuses a window below API 30; the
	// pre-30 validity-duration setter (it admits a device PIN, WR-04) occurs nowhere.
	const buildSpec = functionBody(stripped, /private fun buildSpec\(/)
	if (buildSpec === undefined) {
		violations.push('G2: buildSpec not found')
	} else {
		for (const needle of [
			'setUserAuthenticationParameters(authWindowSeconds, KeyProperties.AUTH_BIOMETRIC_STRONG)',
			'setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)',
			'setInvalidatedByBiometricEnrollment(true)',
			'Build.VERSION.SDK_INT < MIN_SDK_FOR_AUTH_WINDOW',
		]) {
			if (!buildSpec.includes(needle)) violations.push(`G2: buildSpec is missing ${needle}`)
		}
	}
	const durationCalls = count(stripped, 'setUserAuthenticationValidityDurationSeconds(')
	if (durationCalls !== 0) {
		violations.push(`G2: setUserAuthenticationValidityDurationSeconds( occurs ${durationCalls} times, expected 0 (WR-04)`)
	}

	// G3: the windowed bodies prompt once, without a CryptoObject, BIOMETRIC_STRONG only.
	for (const name of ['wrapWindowed', 'unwrapWindowed']) {
		const body = functionBody(stripped, new RegExp(`private fun ${name}\\(`))
		if (body === undefined) {
			violations.push(`G3: ${name} not found`)
			continue
		}
		if (!body.includes('UserNotAuthenticatedException')) {
			violations.push(`G3: ${name} does not handle UserNotAuthenticatedException`)
		}
		const withoutCrypto = count(body, '.authenticate(promptInfo)')
		if (withoutCrypto < 1) violations.push(`G3: ${name} is missing .authenticate(promptInfo)`)
		const allAuth = count(body, '.authenticate(')
		if (allAuth !== 1) violations.push(`G3: ${name} has ${allAuth} .authenticate( calls, expected exactly 1`)
		if (!body.includes('setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)')) {
			violations.push(`G3: ${name} is missing setAllowedAuthenticators(BIOMETRIC_STRONG)`)
		}
		if (body.includes('CryptoObject')) violations.push(`G3: ${name} must not use a CryptoObject`)
		// G8 (CR-02, device-measured): a re-init that is STILL unauthenticated right after a successful
		// prompt is how an enrollment-invalidated time-bound key presents; it must be KEY_INVALIDATED.
		const reinit = /catch \(e: UserNotAuthenticatedException\) \{([\s\S]*?)\n\t*\}/g
		let m: RegExpExecArray | null
		let sawPostPrompt = false
		while ((m = reinit.exec(body)) !== null) {
			if (m[1]!.includes('onError(')) {
				sawPostPrompt = true
				if (!m[1]!.includes('onError("KEY_INVALIDATED", e)')) {
					violations.push(`G8: ${name} maps a post-prompt UserNotAuthenticatedException to something other than KEY_INVALIDATED`)
				}
			}
		}
		if (!sawPostPrompt) violations.push(`G8: ${name} has no post-prompt UserNotAuthenticatedException branch`)
	}

	// G4: wrap/unwrap keep the per-use CryptoObject prompt and dispatch to the windowed path once.
	for (const name of ['wrap', 'unwrap']) {
		const body = functionBody(stripped, new RegExp(`\\bfun ${name}\\(`))
		if (body === undefined) {
			violations.push(`G4: fun ${name} not found`)
			continue
		}
		if (count(body, 'authenticate(promptInfo, cryptoObject)') !== 1) {
			violations.push(`G4: ${name} must contain authenticate(promptInfo, cryptoObject) exactly once`)
		}
		const windowedCalls = count(body, 'Windowed(')
		if (windowedCalls !== 1) violations.push(`G4: ${name} has ${windowedCalls} Windowed( calls, expected 1`)
		if (!body.includes('authWindowSeconds > 0')) {
			violations.push(`G4: ${name} does not bound-check authWindowSeconds > 0`)
		}
		// WR-04: the dispatch and the policy check use the EFFECTIVE window, never the raw request.
		if (!body.includes('val window = effectiveAuthWindowSeconds(authWindowSeconds, Build.VERSION.SDK_INT)')) {
			violations.push(`G4: ${name} does not compute the effective window`)
		}
		if (!body.includes('if (requireAuth && window > 0)')) {
			violations.push(`G4: ${name} does not dispatch on the effective window`)
		}
		if (!body.includes('getOrCreateKey(alias, requireAuth, window)')) {
			violations.push(`G4: ${name} does not compare the alias policy against the effective window`)
		}
	}

	// G5: getOrCreateKey compares the observed window under the explicit A3 rule.
	const getOrCreate = functionBody(stripped, /\bfun getOrCreateKey\(/)
	if (getOrCreate === undefined) {
		violations.push('G5: getOrCreateKey not found')
	} else {
		if (!getOrCreate.includes('observedAuthWindowSeconds(')) {
			violations.push('G5: getOrCreateKey does not call observedAuthWindowSeconds(')
		}
		if (!getOrCreate.includes('userAuthenticationValidityDurationSeconds')) {
			violations.push('G5: getOrCreateKey does not read userAuthenticationValidityDurationSeconds')
		}
		if (count(getOrCreate, 'WrapKeyPolicyMismatchException(') < 2) {
			violations.push('G5: getOrCreateKey must throw WrapKeyPolicyMismatchException( at least twice')
		}
	}
	if (
		!stripped.includes(
			'internal fun observedAuthWindowSeconds(isUserAuthenticationRequired: Boolean, rawValiditySeconds: Int): Int',
		)
	) {
		violations.push('G5: observedAuthWindowSeconds is not declared with the agreed signature')
	}

	// G6: exactly one deleteEntry, inside deleteWrapKey, after the vote-record alias guard (CR-02);
	// the bound constant is unchanged.
	const deleteCount = count(stripped, 'deleteEntry')
	const deleteBody = functionBody(stripped, /\bfun deleteWrapKey\(/)
	if (deleteCount !== 1) violations.push(`G6: deleteEntry occurs ${deleteCount} times, expected exactly 1 (inside deleteWrapKey)`)
	if (deleteBody === undefined || !deleteBody.includes('deleteEntry')) {
		violations.push('G6: deleteEntry is not inside deleteWrapKey')
	} else {
		const guard = deleteBody.indexOf('DELETABLE_WRAP_KEY_ALIAS_PATTERN.matches(alias)')
		if (guard < 0 || guard > deleteBody.indexOf('deleteEntry')) violations.push('G6: deleteWrapKey does not check the vote-record alias guard first')
	}
	if (!stripped.includes('internal val DELETABLE_WRAP_KEY_ALIAS_PATTERN = Regex("^VOTETORRENT_VOTE_RECORD_WRAP_KEY_V[0-9]+$")')) {
		violations.push('G6: DELETABLE_WRAP_KEY_ALIAS_PATTERN is not the vote-record family')
	}
	if (!stripped.includes('internal const val MAX_AUTH_WINDOW_SECONDS = 60')) {
		violations.push('G6: MAX_AUTH_WINDOW_SECONDS = 60 is missing')
	}

	// G7 (WR-04): the downgrade below API 30 exists with the agreed shape.
	if (!stripped.includes('internal const val MIN_SDK_FOR_AUTH_WINDOW = 30')) violations.push('G7: MIN_SDK_FOR_AUTH_WINDOW = 30 is missing')
	const effLine = /internal fun effectiveAuthWindowSeconds\(requested: Int, sdkInt: Int\): Int =\s*if \(sdkInt < MIN_SDK_FOR_AUTH_WINDOW\) 0 else requested/.test(stripped)
	if (!effLine) violations.push('G7: effectiveAuthWindowSeconds does not downgrade below MIN_SDK_FOR_AUTH_WINDOW to 0')

	return violations
}

describe('secret-wrap-window gate (D-14, 63-17)', () => {
	it('resolves the real SecretWrapHelper.kt (repo root sanity)', () => {
		const pkgJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { name: string }
		expect(pkgJson.name).toBe('@votetorrent/attestation-native')
		expect(existsSync(HELPER)).toBe(true)
	})

	const real = existsSync(HELPER) ? readFileSync(HELPER, 'utf8') : ''

	it('the real file satisfies G1-G7', () => {
		expect(checkSecretWrapWindow(real)).toEqual([])
	})

	it('G1: no pass-through guard text anywhere, comments included', () => {
		expect(real.includes('pass-through' + ' guard')).toBe(false)
	})

	it('G2: no pre-API-30 validity-duration setter anywhere (WR-04), BIOMETRIC_STRONG window in buildSpec', () => {
		const stripped = stripCommentsPreservingLines(real)
		expect(count(stripped, 'setUserAuthenticationValidityDurationSeconds(')).toBe(0)
		expect(functionBody(stripped, /private fun buildSpec\(/)).toContain(
			'setUserAuthenticationParameters(authWindowSeconds, KeyProperties.AUTH_BIOMETRIC_STRONG)',
		)
	})

	it('G3: both windowed bodies exist and authenticate once without a CryptoObject', () => {
		const stripped = stripCommentsPreservingLines(real)
		for (const name of ['wrapWindowed', 'unwrapWindowed']) {
			const body = functionBody(stripped, new RegExp(`private fun ${name}\\(`))
			expect(body).toBeDefined()
			expect(count(body!, '.authenticate(')).toBe(1)
			expect(body!.includes('CryptoObject')).toBe(false)
		}
	})

	it('G4: the extractors anchor on the exact function name', () => {
		const stripped = stripCommentsPreservingLines(real)
		const wrap = functionBody(stripped, /\bfun wrap\(/)
		const unwrap = functionBody(stripped, /\bfun unwrap\(/)
		expect(wrap).toBeDefined()
		expect(unwrap).toBeDefined()
		expect(wrap).not.toBe(unwrap)
		expect(count(wrap!, 'Windowed(')).toBe(1)
		expect(count(unwrap!, 'Windowed(')).toBe(1)
	})

	it('G6: the only deleteEntry is the guarded one in deleteWrapKey (CR-02)', () => {
		const stripped = stripCommentsPreservingLines(real)
		expect(count(stripped, 'deleteEntry')).toBe(1)
		expect(functionBody(stripped, /\bfun deleteWrapKey\(/)).toContain('deleteEntry')
	})

	describe('planted self-tests (the checker can fail)', () => {
		it('P1: a re-inserted pass-through guard line reports G1', () => {
			const planted = real + '\n// D-14 pass-through' + ' guard (63-16)\n'
			expect(checkSecretWrapWindow(planted).some((v) => v.startsWith('G1'))).toBe(true)
		})

		it('P2: a CryptoObject authenticate inside wrapWindowed reports G3', () => {
			const planted = real.replace(
				/(private fun wrapWindowed\([\s\S]*?)\.authenticate\(promptInfo\)/,
				'$1.authenticate(promptInfo, cryptoObject)',
			)
			expect(planted).not.toBe(real)
			const v = checkSecretWrapWindow(planted)
			expect(v.some((x) => x.startsWith('G3') && x.includes('wrapWindowed'))).toBe(true)
		})

		it('P3: an .authenticate(promptInfo) only inside a // comment reports G3 as missing', () => {
			const planted = real.replace(
				/(private fun wrapWindowed\([\s\S]*?)\.authenticate\(promptInfo\)/,
				'$1.noop() // .authenticate(promptInfo)',
			)
			expect(planted).not.toBe(real)
			const v = checkSecretWrapWindow(planted)
			expect(v.some((x) => x.includes('G3: wrapWindowed is missing .authenticate(promptInfo)'))).toBe(true)
		})

		it('P4: the fun wrap( extractor finds nothing in a text with only wrapWindowed and unwrap', () => {
			const text = 'private fun wrapWindowed(a: Int) { }\nfun unwrap(a: Int) { }\n'
			expect(functionBody(text, /\bfun wrap\(/)).toBeUndefined()
			expect(functionBody(text, /\bfun unwrap\(/)).toBeDefined()
		})

		it('P5: a deleteEntry call outside deleteWrapKey reports G6', () => {
			const planted = real.replace('class SecretWrapHelper', 'class SecretWrapHelper') + '\nfun x() { keyStore.deleteEntry("a") }\n'
			expect(checkSecretWrapWindow(planted).some((v) => v.startsWith('G6'))).toBe(true)
		})

		it('P7: a re-inserted pre-30 validity-duration setter reports G2', () => {
			const planted = real.replace(
				'builder.setUserAuthenticationParameters(authWindowSeconds, KeyProperties.AUTH_BIOMETRIC_STRONG)',
				'builder.setUserAuthenticationValidityDurationSeconds(authWindowSeconds)',
			)
			expect(planted).not.toBe(real)
			expect(checkSecretWrapWindow(planted).some((v) => v.startsWith('G2'))).toBe(true)
		})

		it('P8: dispatching on the raw request instead of the effective window reports G4', () => {
			const planted = real.replace('if (requireAuth && window > 0) {\n\t\t\twrapWindowed(', 'if (requireAuth && authWindowSeconds > 0) {\n\t\t\twrapWindowed(')
			expect(planted).not.toBe(real)
			expect(checkSecretWrapWindow(planted).some((v) => v.includes('G4: wrap does not dispatch on the effective window'))).toBe(true)
		})

		it('P9: removing the below-30 downgrade reports G7', () => {
			const planted = real.replace('if (sdkInt < MIN_SDK_FOR_AUTH_WINDOW) 0 else requested', 'requested')
			expect(planted).not.toBe(real)
			expect(checkSecretWrapWindow(planted).some((v) => v.startsWith('G7'))).toBe(true)
		})

		it('P10: an unguarded deleteWrapKey reports G6', () => {
			const planted = real.replace('if (!DELETABLE_WRAP_KEY_ALIAS_PATTERN.matches(alias)) {', 'if (alias.isEmpty()) {')
			expect(planted).not.toBe(real)
			expect(checkSecretWrapWindow(planted).some((v) => v.startsWith('G6'))).toBe(true)
		})

		it('P11: mapping the post-prompt unauthenticated re-init back to WRAP_FAILED reports G8', () => {
			const planted = real.replace(
				'op=wrap path=reinit-unauthenticated-invalidated")\n\t\t\t\t\t\t\tonError("KEY_INVALIDATED", e)',
				'op=wrap path=reinit-unauthenticated-invalidated")\n\t\t\t\t\t\t\tonError("WRAP_FAILED", e)',
			)
			expect(planted).not.toBe(real)
			expect(checkSecretWrapWindow(planted).some((v) => v.startsWith('G8: wrapWindowed'))).toBe(true)
		})

		it('P6: an empty file reports every group', () => {
			const v = checkSecretWrapWindow('')
			for (const g of ['G2', 'G3', 'G4', 'G5', 'G6', 'G7']) {
				expect(v.some((x) => x.startsWith(g))).toBe(true)
			}
		})
	})
})

/**
 * T-63-17-05: log hygiene for the wrap-window and key-policy tags. Every `Log.*(` call whose tag is
 * TAG_WRAP_WINDOW or TAG_WRAP_KEY_POLICY is a tag plus ONE string literal (no Throwable argument, so
 * no stack trace reaches logcat), and its interpolations are limited to the allowlist of non-secret
 * diagnostics below (never an exception, key bytes, plaintext or AAD).
 *
 * Out of scope on purpose: the TAG_WRAP_KEY_RUNG StrongBox-rejected line (`Log.w(TAG_WRAP_KEY_RUNG, ..., e)`)
 * deliberately passes the Throwable; it is a different tag and a different threat row, so this gate
 * does not assert on it (a test below pins that it exists and is NOT scanned).
 */
const SCOPED_TAGS = ['TAG_WRAP_WINDOW', 'TAG_WRAP_KEY_POLICY']
const ALLOWED_INTERPOLATIONS = ['alias', 'raw', 'observed', 'authWindowSeconds', 'keyInfo.isUserAuthenticationRequired']
const FORBIDDEN_LOG_TEXT = /\$e\b|\$\{\s*e\b|\.message|stackTrace|getStackTraceString|plaintext|\baad\b|keyBytes|\.encoded/i

/** Top-level comma split that respects double-quoted string literals and nested brackets. */
function splitArgs(argText: string): string[] {
	const args: string[] = []
	let depth = 0
	let inStr = false
	let cur = ''
	for (let i = 0; i < argText.length; i++) {
		const ch = argText[i]!
		if (inStr) {
			cur += ch
			if (ch === '\\') cur += argText[++i] ?? ''
			else if (ch === '"') inStr = false
			continue
		}
		if (ch === '"') inStr = true
		else if (ch === '(' || ch === '{' || ch === '[') depth++
		else if (ch === ')' || ch === '}' || ch === ']') depth--
		if (ch === ',' && depth === 0) {
			args.push(cur.trim())
			cur = ''
		} else cur += ch
	}
	if (cur.trim().length > 0) args.push(cur.trim())
	return args
}

/** Every `Log.<level>(<tag>, ...)` call as { tag, args }, found by a paren-balanced, string-aware walk. */
function logCalls(stripped: string): Array<{ tag: string; args: string[] }> {
	const calls: Array<{ tag: string; args: string[] }> = []
	const head = /\bLog\.[a-z]\(/g
	let m: RegExpExecArray | null
	while ((m = head.exec(stripped)) !== null) {
		const start = m.index + m[0].length
		let depth = 1
		let inStr = false
		let i = start
		for (; i < stripped.length && depth > 0; i++) {
			const ch = stripped[i]!
			if (inStr) {
				if (ch === '\\') i++
				else if (ch === '"') inStr = false
			} else if (ch === '"') inStr = true
			else if (ch === '(') depth++
			else if (ch === ')') depth--
		}
		const args = splitArgs(stripped.slice(start, i - 1))
		calls.push({ tag: args[0] ?? '', args })
	}
	return calls
}

/** Pure checker: readable violation strings, empty when every scoped Log call is hygienic. */
export function checkWrapLogHygiene(kotlinText: string): string[] {
	const violations: string[] = []
	const stripped = stripCommentsPreservingLines(kotlinText)
	for (const call of logCalls(stripped)) {
		if (!SCOPED_TAGS.includes(call.tag)) continue
		const label = `${call.tag} ${call.args[1] ?? '(none)'}`
		if (call.args.length !== 2) violations.push(`L1: ${label} has ${call.args.length} arguments, expected tag plus one string`)
		const msg = call.args[1] ?? ''
		if (!(msg.startsWith('"') && msg.endsWith('"') && msg.length >= 2)) violations.push(`L1: ${label} message is not a single string literal`)
		if (FORBIDDEN_LOG_TEXT.test(call.args.join(',')) ) violations.push(`L2: ${label} references an exception, key material or plaintext`)
		for (const interp of msg.matchAll(/\$\{([^}]*)\}|\$([A-Za-z_]\w*)/g)) {
			const expr = (interp[1] ?? interp[2] ?? '').trim()
			if (!ALLOWED_INTERPOLATIONS.includes(expr)) violations.push(`L2: ${label} interpolates "${expr}", not in the diagnostics allowlist`)
		}
	}
	return violations
}

describe('wrap-window log hygiene (T-63-17-05, 63-17)', () => {
	const realKt = existsSync(HELPER) ? readFileSync(HELPER, 'utf8') : ''

	it('every TAG_WRAP_WINDOW / TAG_WRAP_KEY_POLICY log call is one string with no exception or secret', () => {
		expect(checkWrapLogHygiene(realKt)).toEqual([])
	})

	it('the scan is not vacuous: it sees the scoped calls and nothing but diagnostics is interpolated', () => {
		const scoped = logCalls(stripCommentsPreservingLines(realKt)).filter((c) => SCOPED_TAGS.includes(c.tag))
		expect(scoped.length).toBeGreaterThanOrEqual(9)
		expect(scoped.some((c) => c.tag === 'TAG_WRAP_WINDOW')).toBe(true)
		expect(scoped.some((c) => c.tag === 'TAG_WRAP_KEY_POLICY')).toBe(true)
		expect(scoped.every((c) => c.args.length === 2)).toBe(true)
	})

	it('documents the exclusion: the TAG_WRAP_KEY_RUNG StrongBox-rejected call passes a Throwable and is not scanned', () => {
		const rung = logCalls(stripCommentsPreservingLines(realKt)).filter((c) => c.tag === 'TAG_WRAP_KEY_RUNG')
		expect(rung.length).toBeGreaterThan(0)
		expect(rung.some((c) => c.args.length === 3)).toBe(true)
		expect(SCOPED_TAGS).not.toContain('TAG_WRAP_KEY_RUNG')
		const planted = realKt + '\nfun x() { Log.w(TAG_WRAP_KEY_RUNG, "StrongBox rejected", e) }\n'
		expect(checkWrapLogHygiene(planted)).toEqual([])
	})

	describe('planted self-tests (the checker can fail)', () => {
		const plant = (line: string): string[] => checkWrapLogHygiene(realKt + `\nfun x() { ${line} }\n`)

		it('L-P1: a Throwable third argument on TAG_WRAP_WINDOW reports L1', () => {
			expect(plant('Log.w(TAG_WRAP_WINDOW, "alias=$alias op=wrap", e)').some((v) => v.startsWith('L1'))).toBe(true)
		})

		it('L-P2: a Throwable third argument on TAG_WRAP_KEY_POLICY reports L1', () => {
			expect(plant('Log.i(TAG_WRAP_KEY_POLICY, "alias=$alias", e)').some((v) => v.startsWith('L1'))).toBe(true)
		})

		it('L-P3: interpolating ${e.message} reports L2', () => {
			const v = plant('Log.w(TAG_WRAP_WINDOW, "alias=$alias failed ${e.message}")')
			expect(v.some((x) => x.startsWith('L2'))).toBe(true)
		})

		it.each(['$e', '${e}', '${e.stackTraceToString()}', '${e.cause}', '$plaintext', '${aad}', '${keyBytes.size}'])(
			'L-P4: interpolating %s reports L2',
			(interp) => {
				expect(plant(`Log.i(TAG_WRAP_WINDOW, "x=${interp}")`).some((x) => x.startsWith('L2'))).toBe(true)
			},
		)

		it('L-P5: a comma inside the string literal does not fake a third argument', () => {
			expect(plant('Log.i(TAG_WRAP_WINDOW, "alias=$alias a, b, c")')).toEqual([])
		})

		it('L-P6: a bad call only inside a // comment is not reported', () => {
			expect(plant('// Log.w(TAG_WRAP_WINDOW, "x", e)')).toEqual([])
		})

		it('L-P7: a non-literal message (concatenation helper) reports L1', () => {
			expect(plant('Log.i(TAG_WRAP_WINDOW, describe(alias))').some((x) => x.startsWith('L1'))).toBe(true)
		})
	})
})
