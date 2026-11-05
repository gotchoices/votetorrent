// decrypt-probe.ts - the Voter's pre- and post-release decrypt probe (D-18).
//
// Before the key release it reports the key-release phase and the committed block and entry counts, how many
// blocks are not reconstructable, and whether any caller-supplied needle appears in a raw block ciphertext
// (it must not: the blocks are ciphertext only until the release). After the release it reconstructs the
// election key, opens every vote entry, and returns only the opened count and the sha256 of the canonical
// preimage of the opened set, the same function the host uses. The reconstructed key is zeroed in a finally.
//
// Dev-only. It enters a bundle only through probe-entry.voter.js, which a scratch Metro wrapper serves when the
// probes flag is set. No app source imports it. The gate test decrypt-probe.gate.test.ts enforces both and
// pins the exact set of calls this file makes.
//
// No vote text, nonce, answer, needle or key ever reaches a result string or a log line.

import { openElectionBlock, openVoteEntries } from '@votetorrent/vote-engine/rn'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { openedSetPreimage } from './opened-set-preimage'

declare const __DEV__: boolean

export const DECRYPT_PROBE_VERSION = 'decrypt-probe/1'

export const RESULT_KEYS: string[] = [
	'v',
	'probe',
	'state',
	'electionIdPrefix',
	'phase',
	'reconstructable',
	'releasedCount',
	'threshold',
	'blocks',
	'entries',
	'notReconstructable',
	'openedCount',
	'openFailures',
	'openedSetSha256',
	'needlesChecked',
	'needleFound',
	'needleInOpened',
	'ms',
	'error',
	'ignoredStarts',
]

export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/
export const HEX_RE = /^[0-9a-f]{8,64}$/

const RUN_TIMEOUT_MS = 180000

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
	const err = new Error('decrypt') as Error & { code?: string }
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
			typeof v.setClockOffsetMs === 'function'
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

// A short prefix that is always a valid closed-shape token.
function tokenPrefix (text: string): string {
	const cut = String(text).slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_')
	if (cut.length === 0) return 'x'
	return /^[A-Za-z0-9]/.test(cut) ? cut : 'x' + cut.slice(1)
}

function hexOfText (text: string): string {
	return bytesToHex(utf8ToBytes(text))
}

// True if any caller string appears raw, or as lowercase hex of its UTF-8, in the text.
function anyMarkerIn (text: string, raws: string[], hexes: string[]): boolean {
	for (let i = 0; i < raws.length; i++) {
		if (text.includes(raws[i]) || text.includes(hexes[i])) return true
	}
	return false
}

function toBlockInput (row: any): { blockId: string, ciphertext: string } {
	return { blockId: row.Id, ciphertext: row.Ciphertext }
}

interface DecryptArgs {
	electionId: string | undefined
	needles: string[]
}

function parseArgs (argsJson: string): DecryptArgs {
	let parsed: any
	try {
		parsed = JSON.parse(argsJson)
	} catch {
		throw codedError('bad-args')
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw codedError('bad-args')
	let electionId: string | undefined
	if (parsed.electionId !== undefined) {
		const id = parsed.electionId
		if (typeof id !== 'string' || id.length < 1 || id.length > 128 || /\s/.test(id)) throw codedError('bad-args')
		electionId = id
	}
	const needles: string[] = []
	if (parsed.needles !== undefined) {
		const list = parsed.needles
		if (!Array.isArray(list) || list.length > 8) throw codedError('bad-args')
		for (let i = 0; i < list.length; i++) {
			if (typeof list[i] !== 'string' || list[i].length < 8 || list[i].length > 128) throw codedError('bad-args')
			needles.push(list[i])
		}
	}
	return { electionId, needles }
}

// ---------------------------------------------------------------------------
// Closed result
// ---------------------------------------------------------------------------

function scalarOk (key: string, value: unknown): boolean {
	if (value === null) return true
	if (typeof value === 'boolean') return true
	if (typeof value === 'number') return Number.isInteger(value) && value >= 0
	if (typeof value === 'string') {
		if (key === 'probe') return value === DECRYPT_PROBE_VERSION
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
		if (!scalarOk(key, value)) {
			ok = false
			break
		}
		out[key] = value
	}
	if (!ok) {
		return JSON.stringify({ v: 1, probe: DECRYPT_PROBE_VERSION, state: 'failed', error: 'shape-violation' })
	}
	return JSON.stringify(out)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

let latest: string | null = null
let running = false
let ignoredStarts = 0

function withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => { reject(codedError('timeout')) }, ms)
		p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
	})
}

async function resolveElectionId (ctx: any, given: string | undefined): Promise<string> {
	if (given !== undefined) return given
	const elections = await ctx.getEngine('elections')
	const list = await elections.getElections()
	if (!Array.isArray(list) || list.length === 0) throw codedError('no-election')
	if (list.length > 1) throw codedError('election-ambiguous')
	return String(list[0].id)
}

async function readRows (kr: any, electionId: string, revision: number): Promise<any[]> {
	const db = kr.ctx !== undefined ? kr.ctx.db : undefined
	if (db === undefined || db === null || typeof db.eval !== 'function') throw codedError('no-db-handle')
	const rows: any[] = []
	for await (const row of db.eval('select Cid, Id, BallotId, EntryCount, Ciphertext from VoteBlock where ElectionId = :electionId and ElectionRevision = :revision', { electionId, revision })) {
		rows.push(row)
	}
	return rows
}

// Opens every block and vote entry; returns counts and the digest of the opened set. The key is zeroed in a finally.
async function openAll (kr: any, electionId: string, rows: any[], raws: string[], hexes: string[]): Promise<Record<string, unknown>> {
	const recon = await kr.reconstructElectionKey(electionId)
	const out: Record<string, unknown> = {}
	try {
		const ek = { electionId, revision: recon.revision, jointPublicKey: recon.jointPublicKey }
		const projected: Array<{ ballotId: string, answers: any[] }> = []
		let openFailures = 0
		let inOpened = false
		for (let i = 0; i < rows.length; i++) {
			const opened = openElectionBlock(recon.secretKey, ek, { blockId: rows[i].Id, ciphertext: rows[i].Ciphertext })
			if (!opened.ok) {
				openFailures += 1
				continue
			}
			const entries = openVoteEntries(recon.secretKey, ek, rows[i].BallotId, opened.payload)
			for (let j = 0; j < entries.length; j++) {
				const entry = entries[j]
				if (!entry.ok) {
					openFailures += 1
					continue
				}
				if (anyMarkerIn(entry.voteEntryJson, raws, hexes)) inOpened = true
				try {
					const parsed = JSON.parse(entry.voteEntryJson)
					projected.push({ ballotId: parsed.ballotId, answers: parsed.answers })
				} catch {
					openFailures += 1
				}
			}
		}
		out.openedCount = projected.length
		out.openFailures = openFailures
		out.needleInOpened = inOpened
		out.openedSetSha256 = bytesToHex(sha256(utf8ToBytes(openedSetPreimage(projected))))
		projected.length = 0
	} finally {
		recon.secretKey.fill(0)
	}
	return out
}

async function runDecrypt (args: DecryptArgs, startedAt: number): Promise<void> {
	const ctx = findAppContext()
	if (ctx.isInitialized !== true || ctx.hasNetwork !== true) throw codedError('app-not-ready')
	const electionId = await resolveElectionId(ctx, args.electionId)
	const kr = await ctx.getEngine('keyRelease')
	const status = await kr.getKeyReleaseStatus(electionId)
	const reconstructable = status.phase === 'reconstructable'

	const raws = args.needles
	const hexes = raws.map(hexOfText)
	const cur: Record<string, unknown> = {
		v: 1,
		probe: DECRYPT_PROBE_VERSION,
		state: 'done',
		electionIdPrefix: tokenPrefix(electionId),
		phase: status.phase,
		reconstructable,
		releasedCount: status.releasedCount,
		threshold: status.threshold,
		blocks: 0,
		entries: 0,
		notReconstructable: 0,
		needlesChecked: raws.length,
		needleFound: false,
		ignoredStarts,
	}

	let rows: any[] = []
	if (status.revision !== null) rows = await readRows(kr, electionId, status.revision)
	let entryTotal = 0
	let found = false
	for (let i = 0; i < rows.length; i++) {
		entryTotal += Number(rows[i].EntryCount)
		if (anyMarkerIn(String(rows[i].Ciphertext), raws, hexes)) found = true
	}
	cur.blocks = rows.length
	cur.entries = entryTotal
	cur.needleFound = found

	const results = await kr.decryptElectionBlocks(electionId, rows.map(toBlockInput))
	let notReconstructable = 0
	for (let i = 0; i < results.length; i++) {
		if (results[i].ok === false && results[i].reason === 'not-reconstructable') notReconstructable += 1
	}
	cur.notReconstructable = notReconstructable

	if (reconstructable) {
		const opened = await openAll(kr, electionId, rows, raws, hexes)
		cur.openedCount = opened.openedCount
		cur.openFailures = opened.openFailures
		cur.openedSetSha256 = opened.openedSetSha256
		cur.needleInOpened = opened.needleInOpened
	} else {
		cur.openedSetSha256 = null
		cur.needleInOpened = null
	}
	cur.ms = Date.now() - startedAt
	latest = closedJson(cur)
}

export function registerDecryptProbe (): void {
	if (!(typeof __DEV__ !== 'undefined' && __DEV__)) return

	function startDecrypt (argsJson: string): void {
		try {
			if (running) {
				ignoredStarts += 1
				return
			}
			let args: DecryptArgs
			try {
				args = parseArgs(argsJson)
			} catch (e) {
				latest = closedJson({ v: 1, probe: DECRYPT_PROBE_VERSION, state: 'failed', error: errorToken(e), ignoredStarts })
				return
			}
			running = true
			const startedAt = Date.now()
			latest = closedJson({ v: 1, probe: DECRYPT_PROBE_VERSION, state: 'running', ignoredStarts })
			const runOnce = (): void => {
				withTimeout(runDecrypt(args, startedAt), RUN_TIMEOUT_MS).then(
					() => { running = false },
					e => {
						running = false
						latest = closedJson({ v: 1, probe: DECRYPT_PROBE_VERSION, state: 'failed', ms: Date.now() - startedAt, error: errorToken(e), ignoredStarts })
					},
				)
			}
			setTimeout(runOnce, 0)
		} catch (e) {
			running = false
			latest = closedJson({ v: 1, probe: DECRYPT_PROBE_VERSION, state: 'failed', error: errorToken(e), ignoredStarts })
		}
	}

	function resultDecrypt (): string | null {
		return latest
	}

	const g = globalThis as any
	g.__vt64Probes = g.__vt64Probes || {}
	g.__vt64Probes.decrypt = { start: startDecrypt, result: resultDecrypt }
	console.info('[vt64-probes] decrypt registered')
}
