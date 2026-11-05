// read-association-capture.mjs - host-side reader for the Authority association-capture probe.
//
// It owns the raw channel: it starts the capture over CDP, polls the closed result, reads every raw chunk,
// checks the sha256, and writes the rows to ONE new file outside the repo (mode 0600, never overwritten).
// It then asks the app to drop its raw copy. It prints counts and id prefixes only, never a row.
//
// usage:
//   node read-association-capture.mjs --port <n> (--target-id <cdp id> | --app-id <appId>) \
//        --out-dir <abs dir outside the repo> --label <[a-z0-9][a-z0-9-]{0,47}> [--timeout-s <n>]
//   node read-association-capture.mjs --selftest
//
// A Metro that serves several installs of the Authority lists several targets with one app id: --app-id then
// refuses (ambiguous-target) and the caller passes the exact --target-id instead.
//
// Exit codes: 0 ok, 1 probe failed, 2 target not found or ambiguous, 3 timeout, 4 integrity mismatch,
// 5 usage or refused path, 6 other instrument error.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

const PROBE_VERSION = 'association-capture-probe/1'
const RESULT_KEYS = ['v', 'probe', 'state', 'rows', 'devices', 'chunks', 'rawSha256', 'ms', 'error', 'ignoredStarts']
const DEVICE_KEYS = ['deviceIdPrefix', 'registrantIdPrefix', 'type', 'hasChains']
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

// ---------------------------------------------------------------------------
// Pure helpers (also exercised by --selftest)
// ---------------------------------------------------------------------------

const PRELUDE = '(function(){try{var r=globalThis.__vt64Probes;var p=r&&r.associationCapture;if(!p)return \'absent\';'
const POSTLUDE = '}catch(e){return \'threw\';}})()'

export function exprStart (action) {
	if (action !== 'capture' && action !== 'clear') throw new Error('bad-action')
	return PRELUDE + 'p.start(\'{"action":"' + action + '"}\');return \'sent\';' + POSTLUDE
}

export function exprResult () {
	return PRELUDE + 'return String(p.result());' + POSTLUDE
}

// Prefixed with C so that an empty chunk ('C') is told apart from null ('N').
export function exprChunk (i) {
	if (!Number.isInteger(i) || i < 0) throw new Error('bad-index')
	return PRELUDE + 'var c=p.rawChunk(' + String(i) + ');return c===null?\'N\':\'C\'+c;' + POSTLUDE
}

export function parseClosedResult (text) {
	const obj = JSON.parse(text)
	if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('shape')
	for (const key of Object.keys(obj)) {
		if (!RESULT_KEYS.includes(key)) throw new Error('unknown-key')
	}
	if (obj.devices !== undefined) {
		if (!Array.isArray(obj.devices)) throw new Error('shape')
		for (const d of obj.devices) {
			if (d === null || typeof d !== 'object') throw new Error('shape')
			for (const key of Object.keys(d)) {
				if (!DEVICE_KEYS.includes(key)) throw new Error('unknown-key')
			}
		}
	}
	return obj
}

export function sha256Hex (text) {
	return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

// Joins the chunks and checks the digest. Returns the raw text, or throws integrity-mismatch.
export function reassemble (chunks, expectedSha256) {
	const raw = chunks.join('')
	if (sha256Hex(raw) !== expectedSha256) throw new Error('integrity-mismatch')
	return raw
}

function realOf (p) {
	return fs.realpathSync(p)
}

// Refuses any path inside the repo, resolving symlinks on the nearest existing ancestor.
export function assertOutsideRepo (dir) {
	const abs = path.resolve(dir)
	let existing = abs
	const rest = []
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing)
		if (parent === existing) break
		rest.unshift(path.basename(existing))
		existing = parent
	}
	const full = path.join(realOf(existing), ...rest)
	const rel = path.relative(realOf(REPO), full)
	if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
		throw new Error('inside-repo')
	}
	return full
}

// ---------------------------------------------------------------------------
// Self-test (no network)
// ---------------------------------------------------------------------------

function selftest () {
	const failed = []
	// S1: chunk reassembly accepts the right digest and rejects one flipped character
	{
		const raw = JSON.stringify({ v: 1, probe: PROBE_VERSION, rows: [{ a: 'x'.repeat(40000) }, { b: '😀' }] })
		const chunks = []
		for (let i = 0; i < raw.length; i += 16384) chunks.push(raw.slice(i, i + 16384))
		const digest = sha256Hex(raw)
		let okGood = false
		let okBad = false
		try { okGood = reassemble(chunks, digest) === raw } catch { okGood = false }
		const flipped = chunks.slice()
		flipped[1] = flipped[1].slice(0, 5) + (flipped[1][5] === 'x' ? 'y' : 'x') + flipped[1].slice(6)
		try { reassemble(flipped, digest) } catch (e) { okBad = e.message === 'integrity-mismatch' }
		if (!(okGood && okBad)) failed.push('S1')
	}
	// S2: assertOutsideRepo refuses the repo and its planning dir, and accepts the system temp dir
	{
		let refusedRepo = false
		let refusedPlanning = false
		let acceptedTmp = false
		try { assertOutsideRepo(path.join(REPO, 'x')) } catch (e) { refusedRepo = e.message === 'inside-repo' }
		try { assertOutsideRepo(path.join(REPO, '.planning', 'x')) } catch (e) { refusedPlanning = e.message === 'inside-repo' }
		try { assertOutsideRepo(path.join(os.tmpdir(), 'x')); acceptedTmp = true } catch { acceptedTmp = false }
		if (!(refusedRepo && refusedPlanning && acceptedTmp)) failed.push('S2')
	}
	// S3: every expression is a synchronous IIFE written with function: no arrow, no async
	{
		const exprs = [exprStart('capture'), exprStart('clear'), exprResult(), exprChunk(0), exprChunk(12)]
		const bad = exprs.some(e => !e.startsWith('(function(){') || e.includes('=>') || e.includes('async'))
		if (bad) failed.push('S3')
	}
	// S4: parseClosedResult refuses a key outside the closed set, and accepts a closed one
	{
		let refused = false
		let accepted = false
		try { parseClosedResult('{"v":1,"state":"done","extra":1}') } catch (e) { refused = e.message === 'unknown-key' }
		try { accepted = parseClosedResult('{"v":1,"probe":"' + PROBE_VERSION + '","state":"done","rows":0,"devices":[]}').rows === 0 } catch { accepted = false }
		if (!(refused && accepted)) failed.push('S4')
	}
	if (failed.length > 0) {
		console.log('SELFTEST FAIL ' + failed[0])
		return 1
	}
	console.log('SELFTEST PASS 4/4')
	return 0
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

function usage () {
	console.error('usage: read-association-capture.mjs --port <n> (--target-id <id> | --app-id <appId>) --out-dir <abs dir> --label <label> [--timeout-s <n>]')
	console.error('       read-association-capture.mjs --selftest')
	return 5
}

function parseArgs (argv) {
	const out = {}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--selftest') { out.selftest = true; continue }
		if (!['--port', '--target-id', '--app-id', '--out-dir', '--label', '--timeout-s'].includes(a)) return null
		const v = argv[i + 1]
		if (v === undefined || v.startsWith('--')) return null
		out[a.slice(2)] = v
		i += 1
	}
	return out
}

class Cdp {
	constructor (url, port) {
		this.id = 0
		this.pending = new Map()
		this.ws = new WebSocket(url, { headers: { Origin: 'http://localhost:' + String(port) } })
		this.ready = new Promise((resolve, reject) => {
			this.ws.onopen = () => resolve()
			this.ws.onerror = () => reject(new Error('ws-error'))
		})
		this.ws.onmessage = (m) => {
			const d = JSON.parse(m.data)
			if (d.id !== undefined && this.pending.has(d.id)) {
				this.pending.get(d.id)(d)
				this.pending.delete(d.id)
			}
		}
	}

	send (method, params) {
		return new Promise((resolve) => {
			this.id += 1
			this.pending.set(this.id, resolve)
			this.ws.send(JSON.stringify({ id: this.id, method, params }))
		})
	}

	async evalString (expression) {
		const r = await this.send('Runtime.evaluate', { expression, returnByValue: true })
		if (r.result === undefined || r.result.exceptionDetails !== undefined || r.result.result === undefined) throw new Error('eval-failed')
		const value = r.result.result.value
		if (typeof value !== 'string') throw new Error('eval-failed')
		return value
	}

	close () {
		try { this.ws.close() } catch { /* ignore */ }
	}
}

function sleep (ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pickTarget (port, args) {
	const res = await fetch('http://localhost:' + String(port) + '/json/list')
	const list = await res.json()
	if (args['target-id'] !== undefined) {
		const t = list.find((x) => x.id === args['target-id'] && x.webSocketDebuggerUrl)
		if (t === undefined) return { code: 2, token: 'no-target' }
		return { target: t }
	}
	const matches = list.filter((x) => x.appId === args['app-id'] && x.webSocketDebuggerUrl)
	if (matches.length === 0) return { code: 2, token: 'no-target' }
	if (matches.length > 1) return { code: 2, token: 'ambiguous-target' }
	return { target: matches[0] }
}

async function run (args) {
	const port = Number(args.port)
	const timeoutS = args['timeout-s'] === undefined ? 120 : Number(args['timeout-s'])
	if (!Number.isInteger(port) || port < 1 || port > 65535) return usage()
	if (!Number.isInteger(timeoutS) || timeoutS < 1) return usage()
	if ((args['target-id'] === undefined) === (args['app-id'] === undefined)) return usage()
	if (args['out-dir'] === undefined || !path.isAbsolute(args['out-dir'])) return usage()
	if (args.label === undefined || !LABEL_RE.test(args.label)) return usage()

	let outDir
	try {
		outDir = assertOutsideRepo(args['out-dir'])
	} catch {
		console.error('REFUSED out-dir-inside-repo')
		return 5
	}

	const picked = await pickTarget(port, args)
	if (picked.target === undefined) {
		console.error(picked.token)
		return picked.code
	}
	const cdp = new Cdp(picked.target.webSocketDebuggerUrl, port)
	try {
		await cdp.ready
		await cdp.send('Runtime.enable', {})
		const sent = await cdp.evalString(exprStart('capture'))
		if (sent !== 'sent') { console.error('start-' + sent); return 6 }
		const deadline = Date.now() + timeoutS * 1000
		let result = null
		for (;;) {
			const text = await cdp.evalString(exprResult())
			if (text !== 'null' && text !== 'absent' && text !== 'threw') {
				const parsed = parseClosedResult(text)
				if (parsed.state === 'done' || parsed.state === 'failed') { result = parsed; break }
			}
			if (Date.now() > deadline) { console.error('timeout'); return 3 }
			await sleep(1000)
		}
		if (result.state === 'failed') {
			console.log('CAPTURE-FAILED ' + JSON.stringify(result))
			return 1
		}
		const chunks = []
		for (let i = 0; i < result.chunks; i++) {
			const piece = await cdp.evalString(exprChunk(i))
			if (!piece.startsWith('C')) { console.error('chunk-missing'); return 4 }
			chunks.push(piece.slice(1))
		}
		let raw
		try {
			raw = reassemble(chunks, result.rawSha256)
		} catch {
			console.error('integrity-mismatch')
			return 4
		}
		const doc = JSON.parse(raw)
		if (doc.v !== 1 || !Array.isArray(doc.rows) || doc.rows.length !== result.rows) { console.error('integrity-mismatch'); return 4 }

		fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
		const fileName = 'association-' + args.label + '.json'
		try {
			fs.writeFileSync(path.join(outDir, fileName), raw, { mode: 0o600, flag: 'wx' })
		} catch (e) {
			console.error(e.code === 'EEXIST' ? 'REFUSED file-exists' : 'write-failed')
			return 5
		}
		await cdp.evalString(exprStart('clear'))
		console.log('CAPTURE-RESULT ' + JSON.stringify({
			rows: result.rows,
			devices: result.devices,
			rawSha256Prefix: result.rawSha256.slice(0, 12),
			file: fileName,
			bytes: Buffer.byteLength(raw, 'utf8'),
		}))
		return 0
	} catch {
		console.error('instrument-error')
		return 6
	} finally {
		cdp.close()
	}
}

async function main () {
	const args = parseArgs(process.argv.slice(2))
	if (args === null || Object.keys(args).length === 0) return usage()
	if (args.selftest) return selftest()
	return await run(args)
}

main().then((code) => { process.exit(code) }, () => { console.error('instrument-error'); process.exit(6) })
