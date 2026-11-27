// association-capture-probe.ts - read-only capture of the attestation rows the dev stub verifier accepted
// (D-22 as amended), so the offline replay (64-22) can run the real verifier on them.
//
// It reads the Authority's private association table with ONE select statement and returns, through the
// registry result, only counts, booleans, a sha256 and short id prefixes. The raw rows leave the app through
// the chunk accessor of the registry entry, which only read-association-capture.mjs calls. They never go to
// logcat and never into a result string.
//
// Dev-only. It enters a bundle only through probe-entry.authority.js, which a scratch Metro wrapper serves
// when the probes flag is set. No app source imports it. The gate test rig-probes.gate.test.ts enforces both
// and pins the exact set of calls this file makes.
//
// This probe reads no device-key API of any kind: on Android even a read through a key-minting call
// rotates the key, and nothing here needs one.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

declare const __DEV__: boolean

export const ASSOCIATION_CAPTURE_PROBE_VERSION = 'association-capture-probe/1'
export const CHUNK = 16384

export const RESULT_KEYS: string[] = [
	'v',
	'probe',
	'state',
	'rows',
	'devices',
	'chunks',
	'rawSha256',
	'ms',
	'error',
	'ignoredStarts',
]

export const DEVICE_KEYS: string[] = ['deviceIdPrefix', 'registrantIdPrefix', 'type', 'hasChains']

export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/
export const HEX_RE = /^[0-9a-f]{8,64}$/

const COLUMNS: string[] = ['Cid', 'RegistrantId', 'DeviceKey', 'DeviceId', 'AttestationTime', 'Nonce', 'AttestationDetails', 'Expiration']
const CAPTURE_TIMEOUT_MS = 120000

// ---------------------------------------------------------------------------
// Helpers (no closure is built inside any loop: Hermes rule)
// ---------------------------------------------------------------------------

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
	const err = new Error('capture') as Error & { code?: string }
	err.code = code
	return err
}

function propsValue (fiber: any): any {
	try {
		const props = fiber.memoizedProps
		return props === null || props === undefined ? undefined : props.value
	} catch {
		return undefined
	}
}

function isAppContext (v: any): boolean {
	try {
		return v !== null && v !== undefined &&
			typeof v.getEngine === 'function' &&
			typeof v.hasEngine === 'function' &&
			typeof v.isAttestationVerifierProvisioned === 'function'
	} catch {
		return false
	}
}

function collectRoots (hook: any): any[] {
	const out: any[] = []
	const renderers = hook.renderers
	if (renderers === undefined || renderers === null || typeof renderers.keys !== 'function') return out
	const ids = Array.from(renderers.keys())
	for (let i = 0; i < ids.length; i++) {
		const set = hook.getFiberRoots(ids[i])
		if (set === undefined || set === null) continue
		const roots = Array.from(set)
		for (let j = 0; j < roots.length; j++) out.push(roots[j])
	}
	return out
}

function findAppContext (): any {
	const g = globalThis as any
	const hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__
	if (hook === undefined || hook === null) throw codedError('no-devtools-hook')
	const roots = collectRoots(hook)
	const stack: any[] = []
	for (let i = 0; i < roots.length; i++) stack.push(roots[i].current)
	while (stack.length > 0) {
		const fiber = stack.pop()
		if (fiber === null || fiber === undefined) continue
		const value = propsValue(fiber)
		if (isAppContext(value)) return value
		if (fiber.sibling) stack.push(fiber.sibling)
		if (fiber.child) stack.push(fiber.child)
	}
	throw codedError('no-app-context')
}

// A short prefix that is always a valid closed-shape token: characters outside the token set become '_', and a
// leading non-alphanumeric becomes 'x'.
function tokenPrefix (text: string): string {
	const cut = String(text).slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_')
	if (cut.length === 0) return 'x'
	return /^[A-Za-z0-9]/.test(cut) ? cut : 'x' + cut.slice(1)
}

function nonEmptyArray (v: unknown): boolean {
	return Array.isArray(v) && v.length > 0
}

// type: android | ios | unknown, and whether the chain material the verifier needs is present.
function classifyRow (row: any): { deviceIdPrefix: string, registrantIdPrefix: string, type: string, hasChains: boolean } {
	let type = 'unknown'
	let hasChains = false
	try {
		const details = JSON.parse(String(row.AttestationDetails))
		const platform = details !== null && typeof details === 'object' ? details.platformDetails : undefined
		const platformType = platform !== null && typeof platform === 'object' ? platform.type : undefined
		if (platformType === 'Android') {
			type = 'android'
			hasChains = nonEmptyArray(details.certificateChain) && nonEmptyArray(platform.deviceKeyCertificateChain)
		} else if (platformType === 'iOS') {
			type = 'ios'
			hasChains = typeof details.attestationStatement === 'string' && details.attestationStatement.length > 0
		}
	} catch {
		type = 'unknown'
		hasChains = false
	}
	return {
		deviceIdPrefix: bytesToHex(sha256(utf8ToBytes(String(row.DeviceId)))).slice(0, 8),
		registrantIdPrefix: tokenPrefix(row.RegistrantId),
		type,
		hasChains,
	}
}

function copyRow (row: any): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (let i = 0; i < COLUMNS.length; i++) out[COLUMNS[i]] = row[COLUMNS[i]]
	return out
}

// ---------------------------------------------------------------------------
// Closed result
// ---------------------------------------------------------------------------

function scalarOk (key: string, value: unknown): boolean {
	if (value === null) return true
	if (typeof value === 'boolean') return true
	if (typeof value === 'number') return Number.isInteger(value) && value >= 0
	if (typeof value === 'string') {
		if (key === 'probe') return value === ASSOCIATION_CAPTURE_PROBE_VERSION
		return TOKEN_RE.test(value) || HEX_RE.test(value)
	}
	return false
}

function deviceOk (d: any): boolean {
	if (d === null || typeof d !== 'object') return false
	for (let i = 0; i < DEVICE_KEYS.length; i++) {
		if (!scalarOk(DEVICE_KEYS[i], d[DEVICE_KEYS[i]])) return false
	}
	return Object.keys(d).length === DEVICE_KEYS.length
}

export function closedJson (obj: Record<string, unknown>): string {
	const out: Record<string, unknown> = {}
	let ok = true
	for (let i = 0; i < RESULT_KEYS.length; i++) {
		const key = RESULT_KEYS[i]
		const value = obj[key]
		if (value === undefined) continue
		if (key === 'devices') {
			if (!Array.isArray(value)) { ok = false; break }
			for (let j = 0; j < value.length; j++) {
				if (!deviceOk(value[j])) { ok = false; break }
			}
			if (!ok) break
		} else if (!scalarOk(key, value)) {
			ok = false
			break
		}
		out[key] = value
	}
	if (!ok) {
		return JSON.stringify({ v: 1, probe: ASSOCIATION_CAPTURE_PROBE_VERSION, state: 'failed', error: 'shape-violation' })
	}
	return JSON.stringify(out)
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

let latest: string | null = null
let running = false
let ignoredStarts = 0
let chunkCount = 0
let rawJson: string | null = null

function withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => { reject(codedError('timeout')) }, ms)
		p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
	})
}

async function runCapture (startedAt: number): Promise<void> {
	const ctx = findAppContext()
	if (ctx.isInitialized !== true || ctx.hasNetwork !== true) throw codedError('app-not-ready')
	const engine = await ctx.getEngine('association')
	const db = engine !== null && engine !== undefined && engine.ctx !== undefined ? engine.ctx.db : undefined
	if (db === undefined || db === null || typeof db.eval !== 'function') throw codedError('no-db-handle')
	const rows: Array<Record<string, unknown>> = []
	for await (const row of db.eval('select Cid, RegistrantId, DeviceKey, DeviceId, AttestationTime, Nonce, AttestationDetails, Expiration from AssociationPrivate', {})) {
		rows.push(copyRow(row))
	}
	const doc = { v: 1, probe: ASSOCIATION_CAPTURE_PROBE_VERSION, capturedAtMs: Date.now(), rows }
	rawJson = JSON.stringify(doc)
	const rawSha256 = bytesToHex(sha256(utf8ToBytes(rawJson)))
	const chunks = Math.ceil(rawJson.length / CHUNK)
	chunkCount = chunks
	const devices = rows.map(classifyRow)
	latest = closedJson({
		v: 1,
		probe: ASSOCIATION_CAPTURE_PROBE_VERSION,
		state: 'done',
		rows: rows.length,
		devices,
		chunks,
		rawSha256,
		ms: Date.now() - startedAt,
		ignoredStarts,
	})
}

export function registerAssociationCaptureProbe (): void {
	if (!(typeof __DEV__ !== 'undefined' && __DEV__)) return

	function startAssociationCapture (argsJson: string): void {
		try {
			let action = ''
			try {
				const parsed = JSON.parse(argsJson)
				action = parsed !== null && typeof parsed === 'object' && typeof parsed.action === 'string' ? parsed.action : ''
			} catch {
				action = ''
			}
			if (action === 'clear') {
				rawJson = null
				chunkCount = 0
				return
			}
			if (action !== 'capture') {
				latest = closedJson({ v: 1, probe: ASSOCIATION_CAPTURE_PROBE_VERSION, state: 'failed', error: 'bad-args', ignoredStarts })
				return
			}
			if (running) {
				ignoredStarts += 1
				return
			}
			running = true
			const startedAt = Date.now()
			latest = closedJson({ v: 1, probe: ASSOCIATION_CAPTURE_PROBE_VERSION, state: 'running', ignoredStarts })
			const runOnce = (): void => {
				withTimeout(runCapture(startedAt), CAPTURE_TIMEOUT_MS).then(
					() => { running = false },
					e => {
						running = false
						latest = closedJson({ v: 1, probe: ASSOCIATION_CAPTURE_PROBE_VERSION, state: 'failed', ms: Date.now() - startedAt, error: errorToken(e), ignoredStarts })
					},
				)
			}
			setTimeout(runOnce, 0)
		} catch (e) {
			running = false
			latest = closedJson({ v: 1, probe: ASSOCIATION_CAPTURE_PROBE_VERSION, state: 'failed', error: errorToken(e), ignoredStarts })
		}
	}

	function resultAssociationCapture (): string | null {
		return latest
	}

	function rawChunkAssociationCapture (i: number): string | null {
		if (rawJson === null) return null
		if (!Number.isInteger(i) || i < 0 || i >= chunkCount) return null
		return rawJson.slice(i * CHUNK, (i + 1) * CHUNK)
	}

	const g = globalThis as any
	g.__vt64Probes = g.__vt64Probes || {}
	g.__vt64Probes.associationCapture = {
		start: startAssociationCapture,
		result: resultAssociationCapture,
		rawChunk: rawChunkAssociationCapture,
	}
	console.info('[vt64-probes] associationCapture registered')
}
