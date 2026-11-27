// dkg-kat-probe.ts - the Hermes known-answer test and timing probe for the FROST DKG (PD-14, D-18 as
// amended to 2-of-2).
//
// What it does. It replays a committed, test-only 2-of-2 DKG transcript (dkg-kat-vector.json) through the
// exact module the device DKG runs, compares every check output with the vector by exact string
// equality, and then runs a fresh-randomness 2-of-2 DKG in the same process and reports its timing.
//
// Dev-only. It enters a bundle only through probe-entry.authority.js, which a scratch Metro wrapper
// serves when the probes flag is set. No app source imports this file, and no tracked Metro config
// names it. The gate test rig-probes.gate.test.ts enforces both.
//
// The PD-14 rule for the run plan (64-25): a mismatch is recorded together with the result JSON and
// brought back to the user. No edit to dkg.ts, no regenerated vector, and no retry presented as a pass.
//
// Result shape: a closed set of keys (RESULT_KEYS). Every string value is a short token or a hex digest,
// every number a non-negative integer. Nothing else leaves the app: no secret, no share, no message.

import {
	dkgIdentifierForUser,
	dkgRound1,
	commitRound1,
	verifyRound1Commit,
	verifyRound1Package,
	dkgRound2,
	verifyDealerShare,
	dkgRound3,
	deriveGroupCommitments,
	serializeDkgSecret,
	parseDkgSecret,
	validateReleasedShare,
	reconstructGroupSecret,
	generateDkgReceivingKey,
	encryptShare,
	decryptShare,
} from '../../packages/vote-engine/dist/crypto/dkg.js'

declare const __DEV__: boolean

export const DKG_KAT_PROBE_VERSION = 'dkg-kat-probe/1'

export const KAT_CHECK_NAMES: string[] = [
	'identifier:a',
	'identifier:b',
	'commit:a',
	'commit:b',
	'verify-commit:a',
	'verify-commit:b',
	'verify-commit:wrong-attempt',
	'verify-package:a-checks-b',
	'verify-package:b-checks-a',
	'verify-package:tampered-pok',
	'round2:a-to-b',
	'round2:b-to-a',
	'dealer-share:a-to-b',
	'dealer-share:b-to-a',
	'dealer-share:wrong-recipient',
	'decrypt-share:a-to-b',
	'decrypt-share:b-to-a',
	'round3:a',
	'round3:b',
	'derive-group-commitments',
	'validate-released:a',
	'validate-released:b',
	'validate-released:flipped',
	'reconstruct',
	'secret-roundtrip:a-step1',
	'secret-roundtrip:b-step1',
	'secret-roundtrip:a-step2',
	'secret-roundtrip:b-step2',
]

export const RESULT_KEYS: string[] = [
	'v',
	'probe',
	'state',
	'pass',
	'rounds',
	'checks',
	'mismatches',
	'mismatchIndex',
	'mismatchName',
	'katMs',
	'liveRuns',
	'livePass',
	'liveMs',
	'ms',
	'vectorId',
	'error',
	'ignoredStarts',
]

export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/
export const HEX_RE = /^[0-9a-f]{8,64}$/

const CHECK_COUNT = 28
const LIVE_RUNS_MAX = 3
const RUN_TIMEOUT_MS = 300000

// ---------------------------------------------------------------------------
// Small helpers. None of them builds a closure inside a loop (Hermes rule).
// ---------------------------------------------------------------------------

function hexNibble (code: number): number {
	if (code >= 48 && code <= 57) return code - 48
	if (code >= 97 && code <= 102) return code - 87
	return -1
}

export function hexToBytes (hex: string): Uint8Array {
	if (typeof hex !== 'string' || hex.length % 2 !== 0) throw new TypeError('hex-shape')
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) {
		const hi = hexNibble(hex.charCodeAt(i * 2))
		const lo = hexNibble(hex.charCodeAt(i * 2 + 1))
		if (hi < 0 || lo < 0) throw new TypeError('hex-shape')
		out[i] = hi * 16 + lo
	}
	return out
}

const HEX_DIGITS = '0123456789abcdef'

export function bytesToHex (bytes: Uint8Array): string {
	let out = ''
	for (let i = 0; i < bytes.length; i++) {
		out += HEX_DIGITS.charAt(bytes[i] >> 4) + HEX_DIGITS.charAt(bytes[i] & 15)
	}
	return out
}

export function flipLastNibble (hex: string): string {
	const last = hexNibble(hex.charCodeAt(hex.length - 1))
	if (last < 0) throw new TypeError('hex-shape')
	return hex.slice(0, hex.length - 1) + HEX_DIGITS.charAt(last ^ 1)
}

function yieldNow (): Promise<void> {
	return new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

function errorToken (e: unknown): string {
	try {
		const o = e as { code?: unknown, name?: unknown } | null | undefined
		const code = o !== null && typeof o === 'object' ? o.code : undefined
		if (typeof code === 'string' && code.length <= 64 && /^[a-z][a-z0-9]*([-/][a-z0-9]+)*$/.test(code)) {
			return code.split('/').join('-')
		}
		const name = o !== null && typeof o === 'object' ? o.name : undefined
		if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) return name
	} catch {
		// fall through to the closed token
	}
	return 'unknown'
}

function codedError (code: string): Error {
	const err = new Error('kat') as Error & { code?: string }
	err.code = code
	return err
}

function cloneWire (w: any): any {
	return { identifier: w.identifier, commitment: w.commitment.slice(), proofOfKnowledge: w.proofOfKnowledge }
}

function pairsOf (shares: Record<string, string>): string[][] {
	return Object.keys(shares).sort().map(k => [k, shares[k]])
}

function round3Json (km: any): string {
	return JSON.stringify([
		bytesToHex(km.signingShare),
		km.groupPublicKey,
		km.groupCommitments,
		pairsOf(km.verifyingShares),
		km.identifier,
	])
}

// ---------------------------------------------------------------------------
// One check. Each is computed from params and inputs only, never from another check's output.
// Every check parses a FRESH secret: round2 mutates the step, and round3 wipes its secret.
// ---------------------------------------------------------------------------

export function computeKatCheck (index: number, params: any, inputs: any): string {
	const name = KAT_CHECK_NAMES[index]
	const ctx = params.ctx
	const threshold = params.threshold
	const participants = params.participants
	const ids: string[] = inputs.identifiers
	const r1: any[] = inputs.round1
	switch (name) {
		case 'identifier:a': return dkgIdentifierForUser(params.users[0])
		case 'identifier:b': return dkgIdentifierForUser(params.users[1])
		case 'commit:a': return commitRound1(ctx, cloneWire(r1[0]))
		case 'commit:b': return commitRound1(ctx, cloneWire(r1[1]))
		case 'verify-commit:a': return String(verifyRound1Commit(ctx, cloneWire(r1[0]), inputs.commits[0]))
		case 'verify-commit:b': return String(verifyRound1Commit(ctx, cloneWire(r1[1]), inputs.commits[1]))
		case 'verify-commit:wrong-attempt': {
			const other = { electionId: ctx.electionId, revision: ctx.revision, attempt: ctx.attempt + 1 }
			return String(verifyRound1Commit(other, cloneWire(r1[0]), inputs.commits[0]))
		}
		case 'verify-package:a-checks-b': return String(verifyRound1Package(parseDkgSecret(inputs.secretsStep1[0]), cloneWire(r1[1])))
		case 'verify-package:b-checks-a': return String(verifyRound1Package(parseDkgSecret(inputs.secretsStep1[1]), cloneWire(r1[0])))
		case 'verify-package:tampered-pok': {
			const bad = cloneWire(r1[1])
			bad.proofOfKnowledge = flipLastNibble(bad.proofOfKnowledge)
			return String(verifyRound1Package(parseDkgSecret(inputs.secretsStep1[0]), bad))
		}
		case 'round2:a-to-b': return bytesToHex(dkgRound2(parseDkgSecret(inputs.secretsStep1[0]), [cloneWire(r1[1])])[ids[1]])
		case 'round2:b-to-a': return bytesToHex(dkgRound2(parseDkgSecret(inputs.secretsStep1[1]), [cloneWire(r1[0])])[ids[0]])
		case 'dealer-share:a-to-b': return String(verifyDealerShare(threshold, participants, cloneWire(r1[0]), ids[1], hexToBytes(inputs.round2.aToB)))
		case 'dealer-share:b-to-a': return String(verifyDealerShare(threshold, participants, cloneWire(r1[1]), ids[0], hexToBytes(inputs.round2.bToA)))
		case 'dealer-share:wrong-recipient': return String(verifyDealerShare(threshold, participants, cloneWire(r1[0]), ids[0], hexToBytes(inputs.round2.aToB)))
		case 'decrypt-share:a-to-b': return bytesToHex(decryptShare(ctx, inputs.encryptedShares.aToB, hexToBytes(inputs.receivingKeys[1].privateKey)))
		case 'decrypt-share:b-to-a': return bytesToHex(decryptShare(ctx, inputs.encryptedShares.bToA, hexToBytes(inputs.receivingKeys[0].privateKey)))
		case 'round3:a': {
			const km = dkgRound3(parseDkgSecret(inputs.secretsStep2[0]), [cloneWire(r1[1])], [{ dealer: ids[1], share: hexToBytes(inputs.round2.bToA) }])
			return round3Json(km)
		}
		case 'round3:b': {
			const km = dkgRound3(parseDkgSecret(inputs.secretsStep2[1]), [cloneWire(r1[0])], [{ dealer: ids[0], share: hexToBytes(inputs.round2.aToB) }])
			return round3Json(km)
		}
		case 'derive-group-commitments': return JSON.stringify(deriveGroupCommitments([cloneWire(r1[0]), cloneWire(r1[1])]))
		case 'validate-released:a': return String(validateReleasedShare(threshold, participants, inputs.round3.a.groupCommitments, { identifier: ids[0], signingShare: inputs.round3.a.signingShare }))
		case 'validate-released:b': return String(validateReleasedShare(threshold, participants, inputs.round3.b.groupCommitments, { identifier: ids[1], signingShare: inputs.round3.b.signingShare }))
		case 'validate-released:flipped': return String(validateReleasedShare(threshold, participants, inputs.round3.a.groupCommitments, { identifier: ids[0], signingShare: flipLastNibble(inputs.round3.a.signingShare) }))
		case 'reconstruct': {
			const rec = reconstructGroupSecret({
				threshold,
				participants,
				groupPublicKey: inputs.round3.a.groupPublicKey,
				groupCommitments: inputs.round3.a.groupCommitments,
				shares: [
					{ identifier: ids[0], signingShare: inputs.round3.a.signingShare },
					{ identifier: ids[1], signingShare: inputs.round3.b.signingShare },
				],
			})
			const out = JSON.stringify([bytesToHex(rec.secretKey), rec.usedIdentifiers, rec.rejectedIdentifiers])
			rec.secretKey.fill(0)
			return out
		}
		case 'secret-roundtrip:a-step1': return serializeDkgSecret(parseDkgSecret(inputs.secretsStep1[0]))
		case 'secret-roundtrip:b-step1': return serializeDkgSecret(parseDkgSecret(inputs.secretsStep1[1]))
		case 'secret-roundtrip:a-step2': return serializeDkgSecret(parseDkgSecret(inputs.secretsStep2[0]))
		case 'secret-roundtrip:b-step2': return serializeDkgSecret(parseDkgSecret(inputs.secretsStep2[1]))
		default: throw codedError('unknown-check')
	}
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface KatReplay {
	rounds: number
	checks: number
	mismatches: number
	mismatchIndex: number | null
	mismatchName: string | null
	katMs: number
}

function vectorShapeOk (vector: any): boolean {
	try {
		return vector !== null && typeof vector === 'object' &&
			vector.v === 1 && vector.kind === 'vt64-dkg-kat' &&
			typeof vector.vectorId === 'string' && /^[0-9a-f]{16}$/.test(vector.vectorId) &&
			Array.isArray(vector.checks) && vector.checks.length === CHECK_COUNT &&
			vector.params !== null && typeof vector.params === 'object' &&
			vector.inputs !== null && typeof vector.inputs === 'object'
	} catch {
		return false
	}
}

function checkOutput (index: number, vector: any): string {
	try {
		return computeKatCheck(index, vector.params, vector.inputs)
	} catch (e) {
		return 'threw:' + errorToken(e)
	}
}

export async function replayDkgKat (vector: any, now: () => number = Date.now): Promise<KatReplay> {
	if (!vectorShapeOk(vector)) throw codedError('vector-shape')
	let mismatches = 0
	let mismatchIndex: number | null = null
	let mismatchName: string | null = null
	let katMs = 0
	for (let i = 0; i < CHECK_COUNT; i++) {
		const t0 = now()
		const out = checkOutput(i, vector)
		katMs += now() - t0
		const entry = vector.checks[i]
		const nameOk = entry !== null && typeof entry === 'object' && entry.name === KAT_CHECK_NAMES[i]
		const same = nameOk && out === entry.expect
		if (!same) {
			mismatches += 1
			if (mismatchIndex === null) {
				mismatchIndex = i
				mismatchName = KAT_CHECK_NAMES[i]
			}
		}
		await yieldNow()
	}
	return { rounds: CHECK_COUNT, checks: CHECK_COUNT, mismatches, mismatchIndex, mismatchName, katMs }
}

// ---------------------------------------------------------------------------
// Live fresh-randomness 2-of-2 DKG
// ---------------------------------------------------------------------------

function liveAssert (ok: boolean, code: string): void {
	if (!ok) throw codedError(code)
}

function sameJson (a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

function liveOnce (vector: any): void {
	const p = vector.params
	const ctx = p.ctx
	const t = p.threshold
	const n = p.participants
	const ids = [dkgIdentifierForUser(p.users[0]), dkgIdentifierForUser(p.users[1])]
	const a = dkgRound1(ids[0], t, n)
	const b = dkgRound1(ids[1], t, n)
	const ca = commitRound1(ctx, a.public)
	const cb = commitRound1(ctx, b.public)
	liveAssert(verifyRound1Commit(ctx, a.public, ca) && verifyRound1Commit(ctx, b.public, cb), 'live-commit')
	const ka = generateDkgReceivingKey()
	const kb = generateDkgReceivingKey()
	const outA = dkgRound2(a.secret, [b.public])
	const outB = dkgRound2(b.secret, [a.public])
	const shareAB = outA[ids[1]]
	const shareBA = outB[ids[0]]
	const encAB = encryptShare(ctx, ids[0], ids[1], kb.publicKey, shareAB)
	const encBA = encryptShare(ctx, ids[1], ids[0], ka.publicKey, shareBA)
	liveAssert(bytesToHex(decryptShare(ctx, encAB, kb.privateKey)) === bytesToHex(shareAB), 'live-decrypt')
	liveAssert(bytesToHex(decryptShare(ctx, encBA, ka.privateKey)) === bytesToHex(shareBA), 'live-decrypt')
	const kmA = dkgRound3(a.secret, [b.public], [{ dealer: ids[1], share: shareBA }])
	const kmB = dkgRound3(b.secret, [a.public], [{ dealer: ids[0], share: shareAB }])
	liveAssert(kmA.groupPublicKey === kmB.groupPublicKey, 'live-group-key')
	liveAssert(sameJson(deriveGroupCommitments([a.public, b.public]), kmA.groupCommitments), 'live-commitments')
	const sa = { identifier: ids[0], signingShare: bytesToHex(kmA.signingShare) }
	const sb = { identifier: ids[1], signingShare: bytesToHex(kmB.signingShare) }
	liveAssert(validateReleasedShare(t, n, kmA.groupCommitments, sa) && validateReleasedShare(t, n, kmA.groupCommitments, sb), 'live-released')
	const rec = reconstructGroupSecret({
		threshold: t,
		participants: n,
		groupPublicKey: kmA.groupPublicKey,
		groupCommitments: kmA.groupCommitments,
		shares: [sa, sb],
	})
	rec.secretKey.fill(0)
	ka.privateKey.fill(0)
	kb.privateKey.fill(0)
}

export interface LiveResult {
	livePass: boolean | null
	liveRuns: number
	liveMs: number
	liveError: string | null
}

export async function runLiveDkg (vector: any, runs: number, now: () => number = Date.now): Promise<LiveResult> {
	if (runs <= 0) return { livePass: null, liveRuns: 0, liveMs: 0, liveError: null }
	const t0 = now()
	let done = 0
	let liveError: string | null = null
	for (let i = 0; i < runs; i++) {
		try {
			liveOnce(vector)
			done += 1
		} catch (e) {
			liveError = errorToken(e)
			break
		}
		await yieldNow()
	}
	return { livePass: liveError === null && done === runs, liveRuns: done, liveMs: now() - t0, liveError }
}

// ---------------------------------------------------------------------------
// Closed result
// ---------------------------------------------------------------------------

function closedValueOk (key: string, value: unknown): boolean {
	if (value === null) return true
	if (typeof value === 'boolean') return true
	if (typeof value === 'number') return Number.isInteger(value) && value >= 0
	if (typeof value === 'string') {
		if (key === 'probe') return value === DKG_KAT_PROBE_VERSION
		return TOKEN_RE.test(value) || HEX_RE.test(value)
	}
	return false
}

export function closedJson (obj: Record<string, unknown>): string {
	const out: Record<string, unknown> = {}
	let ok = true
	for (let i = 0; i < RESULT_KEYS.length; i++) {
		const key = RESULT_KEYS[i]
		const value = obj[key]
		if (value === undefined) continue
		if (!closedValueOk(key, value)) { ok = false; break }
		out[key] = value
	}
	if (!ok) {
		return JSON.stringify({ v: 1, probe: DKG_KAT_PROBE_VERSION, state: 'failed', error: 'shape-violation' })
	}
	return JSON.stringify(out)
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let latest: string | null = null
let running = false
let ignoredStarts = 0

function parseArgs (argsJson: string): number {
	let parsed: any
	try {
		parsed = JSON.parse(argsJson)
	} catch {
		throw codedError('bad-args')
	}
	if (parsed === null || typeof parsed !== 'object') throw codedError('bad-args')
	const runs = parsed.liveRuns === undefined ? 1 : parsed.liveRuns
	if (!Number.isInteger(runs) || runs < 0 || runs > LIVE_RUNS_MAX) throw codedError('bad-args')
	return runs
}

function withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => { reject(codedError('timeout')) }, ms)
		p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
	})
}

export function registerDkgKatProbe (vector: any): void {
	if (!(typeof __DEV__ !== 'undefined' && __DEV__)) return

	function startDkgKat (argsJson: string): void {
		try {
			if (running) {
				ignoredStarts += 1
				return
			}
			let liveRunsWanted = 1
			try {
				liveRunsWanted = parseArgs(argsJson)
			} catch (e) {
				latest = closedJson({ v: 1, probe: DKG_KAT_PROBE_VERSION, state: 'failed', error: errorToken(e), ignoredStarts })
				return
			}
			running = true
			const startedAt = Date.now()
			const vectorId = vector !== null && typeof vector === 'object' ? vector.vectorId : undefined
			latest = closedJson({ v: 1, probe: DKG_KAT_PROBE_VERSION, state: 'running', vectorId, ignoredStarts })

			const work = async (): Promise<void> => {
				const kat = await replayDkgKat(vector)
				const live = await runLiveDkg(vector, liveRunsWanted)
				latest = closedJson({
					v: 1,
					probe: DKG_KAT_PROBE_VERSION,
					state: 'done',
					pass: kat.mismatches === 0 && live.livePass !== false,
					rounds: kat.rounds,
					checks: kat.checks,
					mismatches: kat.mismatches,
					mismatchIndex: kat.mismatchIndex,
					mismatchName: kat.mismatchName,
					katMs: kat.katMs,
					liveRuns: live.liveRuns,
					livePass: live.livePass,
					liveMs: live.liveMs,
					ms: Date.now() - startedAt,
					vectorId,
					error: live.liveError === null ? undefined : live.liveError,
					ignoredStarts,
				})
			}
			const runOnce = (): void => {
				withTimeout(work(), RUN_TIMEOUT_MS).then(
					() => { running = false },
					e => {
						running = false
						latest = closedJson({ v: 1, probe: DKG_KAT_PROBE_VERSION, state: 'failed', vectorId, ms: Date.now() - startedAt, error: errorToken(e), ignoredStarts })
					},
				)
			}
			setTimeout(runOnce, 0)
		} catch (e) {
			running = false
			latest = closedJson({ v: 1, probe: DKG_KAT_PROBE_VERSION, state: 'failed', error: errorToken(e), ignoredStarts })
		}
	}

	function resultDkgKat (): string | null {
		return latest
	}

	const g = globalThis as any
	g.__vt64Probes = g.__vt64Probes || {}
	g.__vt64Probes.dkgKat = { start: startDkgKat, result: resultDkgKat }
	console.info('[vt64-probes] dkgKat registered')
}
