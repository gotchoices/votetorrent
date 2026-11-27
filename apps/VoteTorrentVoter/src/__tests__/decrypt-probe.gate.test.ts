/**
 * decrypt-probe.gate.test.ts - T-64-20 (Phase 64 plan 20): the Voter decrypt probe must stay read-only, dev-only
 * and out of every app bundle. The probe lives outside the app, in scripts/proof, and is read here as text on
 * comment-stripped source. It is never imported: importing it would pull scripts/proof into the app tsconfig.
 *
 *   V1   SQL: every eval argument is one single-quoted select literal with no write verb.
 *   V2   deny-list: no storage, vault, release, seeding, provisioning or write call.
 *   V3   allow-lists: the probe's member calls are pinned, and it names only the key-release and elections engines.
 *   V4   every console call takes one string literal and nothing else.
 *   V5   closed result shape: pinned key list, every assignment of the result goes through closedJson.
 *   V6   secrets: the reconstructed key is zeroed in a finally; no vote, nonce, answer, needle or key on a result
 *        or log line; no raw channel.
 *   V7   registry: one registration of the name across every file in scripts/proof, __DEV__ guards.
 *   V8   Hermes: no closure inside any loop body.
 *   V9   the shared preimage has no import, and the probe takes it from there.
 *   V10  never in the app: no import of scripts/proof, no probe name in the Metro config, no require in the probe.
 *
 * Every forbidden literal is assembled by concatenation, so this file cannot trip its own scan. The planted
 * describe block proves each rule can fail. A violation that sits only inside a comment is not reported.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const REPO = join(__dirname, '..', '..', '..', '..')
const PROOF_DIR = join(REPO, 'scripts', 'proof')
const APP_DIR = join(REPO, 'apps', 'VoteTorrentVoter')

const PROBES_FLAG = 'VT64_' + 'PROBES'
const ENTRY_DOT = 'probe-entry' + '.'
const SET_ITEM = 'set' + 'Item'

const DEC_FILE = 'decrypt-probe.ts'
const PRE_FILE = 'opened-set-preimage.ts'
const ENTRY_FILE = ENTRY_DOT + 'voter.js'

const DEC_RESULT_KEYS = ['v', 'probe', 'state', 'electionIdPrefix', 'phase', 'reconstructable', 'releasedCount', 'threshold', 'blocks', 'entries', 'notReconstructable', 'openedCount', 'openFailures', 'openedSetSha256', 'needlesChecked', 'needleFound', 'needleInOpened', 'ms', 'error', 'ignoredStarts']

const DEC_MEMBER_CALLS = ['decryptElectionBlocks', 'eval', 'fill', 'from', 'getElections', 'getEngine', 'getFiberRoots', 'getKeyReleaseStatus', 'includes', 'info', 'isArray', 'isInteger', 'join', 'keys', 'map', 'now', 'parse', 'pop', 'push', 'reconstructElectionKey', 'replace', 'slice', 'split', 'stringify', 'test', 'then']

const DENY_CALLS = [
	SET_ITEM, 'removeItem', 'multiSet', 'multiRemove', 'mergeItem', 'multiMerge', 'clear', 'writeFile', 'appendFile', 'unlink',
	'run', 'exec', 'transaction', 'commit', 'submit', 'approve', 'reject', 'publish', 'associate', 'sync', 'create', 'insert',
	'update', 'delete', 'upsert', 'storeSecret', 'putSecret', 'setSecret', 'deleteSecret', 'produce', 'produceAttestation',
	'produceFreshAttestation', 'signDeviceKeyDigest', 'createCadreInvitation', 'joinNetwork', 'addStrand',
	'seedReleaseKeyTasks', 'releaseKeyShare', 'releaseKeyholderShare', 'completeKeyRelease', 'getKeysToRelease',
]

const SQL_WRITE_VERBS = /\b(insert|update|delete|replace|upsert|create|drop|alter|attach|pragma|begin|commit|rollback)\b/i

// ---------------------------------------------------------------------------
// Pure text helpers
// ---------------------------------------------------------------------------

function stripCommentsPreservingLines(src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

function matchingClose(s: string, open: number, openCh: string, closeCh: string): number {
	let depth = 0
	for (let i = open; i < s.length; i++) {
		if (s[i] === openCh) depth++
		else if (s[i] === closeCh) {
			depth--
			if (depth === 0) return i
		}
	}
	return s.length - 1
}

function loopBodies(s: string): string[] {
	const out: string[] = []
	const re = /\b(?:for|while)\s*(?:await\s*)?\(|\bdo\s*\{/g
	let m: RegExpExecArray | null
	while ((m = re.exec(s)) !== null) {
		const last = m.index + m[0].length - 1
		if (s[last] === '{') {
			out.push(s.slice(last, matchingClose(s, last, '{', '}') + 1))
			continue
		}
		const close = matchingClose(s, last, '(', ')')
		let i = close + 1
		while (i < s.length && /\s/.test(s[i]!)) i++
		if (s[i] === '{') {
			out.push(s.slice(i, matchingClose(s, i, '{', '}') + 1))
		} else {
			// A brace-less body is the rest of its line.
			const eol = s.indexOf('\n', i)
			out.push(s.slice(i, eol === -1 ? s.length : eol))
		}
	}
	return out
}

function memberCalls(s: string): string[] {
	return [...s.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!)
}

function importSpecifiers(s: string): string[] {
	const out: string[] = []
	for (const m of s.matchAll(/\bimport\s+(?:[^'"]*?\s+from\s*)?'([^']+)'/g)) out.push(m[1]!)
	for (const m of s.matchAll(/\brequire\s*\(\s*'([^']+)'/g)) out.push(m[1]!)
	for (const m of s.matchAll(/\bimport\s*\(\s*'([^']+)'/g)) out.push(m[1]!)
	return out
}

function bodyAfter(s: string, from: number): string {
	const open = s.indexOf('{', from)
	if (open === -1) return ''
	return s.slice(open, matchingClose(s, open, '{', '}') + 1)
}

function keyList(s: string, name: string): string[] | null {
	const m = new RegExp(`\\b${name}\\s*(?::\\s*string\\[\\])?\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(s)
	if (!m) return null
	return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

// ---------------------------------------------------------------------------
// Rule checkers: each returns readable violation strings that start with the rule id
// ---------------------------------------------------------------------------

function checkSql(s: string, label: string, minEvals: number, mustName: string | null): string[] {
	const out: string[] = []
	let count = 0
	for (const m of s.matchAll(/\.eval\s*\(/g)) {
		count++
		const rest = s.slice(m.index! + m[0].length)
		const lit = /^\s*'([^'\\\n]*)'/.exec(rest)
		if (!lit) {
			out.push(`V1: ${label} eval argument is not one single-quoted literal`)
			continue
		}
		if (!/^\s*select\s/i.test(lit[1]!)) out.push(`V1: ${label} eval literal is not a select`)
		if (SQL_WRITE_VERBS.test(lit[1]!)) out.push(`V1: ${label} eval literal holds a write verb`)
		if (mustName !== null && !lit[1]!.includes(mustName)) out.push(`V1: ${label} eval literal does not name ${mustName}`)
	}
	if (count < minEvals) out.push(`V1: ${label} has ${count} eval calls, expected at least ${minEvals}`)
	if (minEvals === 0 && count !== 0) out.push(`V1: ${label} has ${count} eval calls, expected 0`)
	return out
}

function checkDeny(s: string, label: string): string[] {
	const out: string[] = []
	const names = memberCalls(s)
	for (const bad of DENY_CALLS) {
		if (names.includes(bad)) out.push(`V2: ${label} calls ${bad}`)
	}
	if (/\bprovision\w*\s*\(/.test(s)) out.push(`V2: ${label} calls a provisioning function`)
	for (const id of ['AsyncStorage', 'RNFS', 'Keychain']) {
		if (new RegExp(`\\b${id}\\b`).test(s)) out.push(`V2: ${label} names ${id}`)
	}
	return out
}

function checkEngines(s: string): string[] {
	const out: string[] = []
	const names = [...new Set(memberCalls(s))].sort()
	if (JSON.stringify(names) !== JSON.stringify(DEC_MEMBER_CALLS)) out.push(`V3: DEC member calls differ from the pinned set: ${names.join(',')}`)
	const engines = [...s.matchAll(/getEngine\s*\(\s*'([^']*)'/g)].map((m) => m[1]!)
	if (engines.length !== [...s.matchAll(/getEngine\s*\(/g)].length) out.push('V3: DEC calls getEngine with a non-literal name')
	for (const n of engines) {
		if (!['keyRelease', 'elections'].includes(n)) out.push(`V3: DEC names engine ${n}`)
	}
	return out
}

function checkConsole(s: string, label: string): string[] {
	const out: string[] = []
	const re = /console\s*\.\s*(\w+)\s*\(/g
	let m: RegExpExecArray | null
	while ((m = re.exec(s)) !== null) {
		const open = m.index + m[0].length - 1
		const arg = s.slice(open + 1, matchingClose(s, open, '(', ')'))
		if (!/^\s*'[^'\\\n]*'\s*$/.test(arg)) out.push(`V4: ${label} console.${m[1]} takes more than one string literal`)
	}
	return out
}

function checkClosedShape(s: string): string[] {
	const out: string[] = []
	if (JSON.stringify(keyList(s, 'RESULT_KEYS')) !== JSON.stringify(DEC_RESULT_KEYS)) out.push('V5: DEC RESULT_KEYS differs from the pinned list')
	for (const m of s.matchAll(/\blatest\s*=(?!=)([^\n]*)/g)) {
		const rhs = m[1]!.trim()
		if (!(rhs.startsWith('closedJson(') || rhs === 'null')) out.push('V5: DEC assigns latest from something other than closedJson')
	}
	if (!/\breturn latest\b/.test(s)) out.push('V5: DEC never returns latest')
	if (!/\bconst TOKEN_RE\s*=/.test(s) || !/\bconst HEX_RE\s*=/.test(s)) out.push('V5: DEC does not declare TOKEN_RE and HEX_RE')
	const fn = /function closedJson\s*\(/.exec(s)
	if (!fn || !bodyAfter(s, fn.index + fn[0].length).includes('RESULT_KEYS')) out.push('V5: DEC closedJson does not name RESULT_KEYS')
	return out
}

function checkSecrets(s: string): string[] {
	const out: string[] = []
	const fills = [...s.matchAll(/secretKey\.fill\(0\)/g)]
	if (fills.length !== 1) {
		out.push(`V6: DEC has ${fills.length} secretKey.fill(0) calls, expected 1`)
	} else {
		let inFinally = false
		for (const f of s.matchAll(/\bfinally\s*\{/g)) {
			const open = f.index! + f[0].length - 1
			const close = matchingClose(s, open, '{', '}')
			if (fills[0]!.index! > open && fills[0]!.index! < close) inFinally = true
		}
		if (!inFinally) out.push('V6: DEC zeroes the key outside a finally block')
	}
	for (const line of s.split('\n')) {
		if (!(line.includes('closedJson(') || line.includes('console.'))) continue
		if (/voteEntryJson|needle|secretKey|answers|nonce/.test(line)) out.push(`V6: a result or log line holds vote material: ${line.trim()}`)
	}
	if (/rawChunk/.test(s)) out.push('V6: DEC has a raw channel')
	return out
}

function registrationsOf(s: string): string[] {
	return [...s.matchAll(/__vt64Probes\s*\.\s*(\w+)\s*=(?!=)/g)].map((m) => m[1]!)
}

function checkRegistry(s: string): string[] {
	const out: string[] = []
	if (JSON.stringify(registrationsOf(s)) !== JSON.stringify(['decrypt'])) out.push(`V7: DEC registers [${registrationsOf(s).join(',')}], expected [decrypt]`)
	for (const m of s.matchAll(/__vt64Probes\s*\.\s*(\w+)\s*=\s*\{([^}]*)\}/g)) {
		for (const entry of m[2]!.split(',')) {
			const e = entry.trim()
			if (e === '') continue
			const value = e.includes(':') ? e.slice(e.indexOf(':') + 1).trim() : e
			if (!/^[A-Za-z_$][\w$]*$/.test(value)) out.push(`V7: DEC registry value is not a bare identifier: ${e}`)
		}
	}
	if (/async\s+function\s+(?:start|result|rawChunk)/.test(s)) out.push('V7: DEC has an async registry function')
	for (const m of s.matchAll(/function\s+(register\w*Probe)\s*\(/g)) {
		const close = matchingClose(s, m.index! + m[0].length - 1, '(', ')')
		if (!bodyAfter(s, close).includes('__DEV__')) out.push(`V7: DEC ${m[1]} body has no __DEV__ guard`)
	}
	return out
}

function checkRegistryUnique(files: Array<{ name: string, text: string }>): string[] {
	const seen = new Map<string, string>()
	const out: string[] = []
	for (const f of files) {
		for (const n of registrationsOf(stripCommentsPreservingLines(f.text))) {
			const prev = seen.get(n)
			if (prev !== undefined && prev !== f.name) out.push(`V7: probe name ${n} is registered in both ${prev} and ${f.name}`)
			seen.set(n, f.name)
		}
	}
	return out
}

function checkEntryRegistration(s: string): string[] {
	const out: string[] = []
	const specs = importSpecifiers(s)
	if (specs[0] !== '../../apps/VoteTorrentVoter/index.js') out.push(`V7: entry first import is ${String(specs[0])}`)
	const guard = /if\s*\(\s*__DEV__\s*\)\s*\{/.exec(s)
	if (!guard) {
		out.push('V7: entry has no if (__DEV__) block')
		return out
	}
	const open = guard.index + guard[0].length - 1
	const body = s.slice(open, matchingClose(s, open, '{', '}') + 1)
	const outside = s.slice(0, open) + s.slice(open + body.length)
	if (!body.includes('registerDecryptProbe(')) out.push('V7: entry does not call registerDecryptProbe inside if (__DEV__)')
	const loose = outside.split('\n').filter((l) => !/^\s*import\b/.test(l) && l.includes('registerDecryptProbe('))
	if (loose.length > 0) out.push('V7: entry calls registerDecryptProbe outside if (__DEV__)')
	return out
}

function checkHermes(s: string, label: string): string[] {
	const out: string[] = []
	for (const body of loopBodies(s)) {
		if (body.includes('=>') || /\bfunction\b/.test(body)) out.push(`V8: ${label} builds a closure inside a loop`)
	}
	return out
}

function checkPreimage(pre: string, dec: string): string[] {
	const out: string[] = []
	if (importSpecifiers(pre).length !== 0 || /^\s*import\b/m.test(pre)) out.push('V9: PRE has an import')
	if (!/export function openedSetPreimage\b/.test(pre)) out.push('V9: PRE does not export openedSetPreimage')
	if (!importSpecifiers(dec).includes('./opened-set-preimage')) out.push('V9: DEC does not import ./opened-set-preimage')
	return out
}

function checkNeverInApp(files: Array<{ name: string, text: string }>, proofBases: string[], metroText: string): string[] {
	const out: string[] = []
	for (const f of files) {
		for (const spec of importSpecifiers(stripCommentsPreservingLines(f.text))) {
			const bare = spec.replace(/\.(?:tsx?|jsx?|mjs|json)$/, '')
			if (spec.includes('scripts/proof') || proofBases.some((b) => bare === b || bare.endsWith('/' + b))) {
				out.push(`V10: ${f.name} imports ${spec}`)
			}
		}
	}
	if (metroText.includes(PROBES_FLAG) || metroText.includes('probe-' + 'entry')) out.push('V10: the tracked Metro config names the probe flag or entry')
	return out
}

function checkNoRequire(s: string, label: string): string[] {
	return s.includes('require(') ? [`V10: ${label} uses require`] : []
}

// Whole-file checkers
function checkDec(raw: string): string[] {
	const s = stripCommentsPreservingLines(raw)
	return [
		...checkSql(s, 'DEC', 1, 'from VoteBlock'),
		...checkDeny(s, 'DEC'),
		...checkEngines(s),
		...checkConsole(s, 'DEC'),
		...checkClosedShape(s),
		...checkSecrets(s),
		...checkRegistry(s),
		...checkHermes(s, 'DEC'),
		...checkNoRequire(s, 'DEC'),
	]
}

function checkEntry(raw: string): string[] {
	const s = stripCommentsPreservingLines(raw)
	return [
		...checkSql(s, 'ENTRY', 0, null),
		...checkDeny(s, 'ENTRY'),
		...checkConsole(s, 'ENTRY'),
		...checkEntryRegistration(s),
		...checkHermes(s, 'ENTRY'),
		...checkNoRequire(s, 'ENTRY'),
	]
}

function checkPre(raw: string): string[] {
	const s = stripCommentsPreservingLines(raw)
	return [
		...checkSql(s, 'PRE', 0, null),
		...checkDeny(s, 'PRE'),
		...checkConsole(s, 'PRE'),
		...checkHermes(s, 'PRE'),
		...checkNoRequire(s, 'PRE'),
	]
}

// ---------------------------------------------------------------------------
// Real files
// ---------------------------------------------------------------------------

function read(name: string): string {
	const p = join(PROOF_DIR, name)
	return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

const DEC = read(DEC_FILE)
const PRE = read(PRE_FILE)
const ENTRY = read(ENTRY_FILE)

function proofCodeFiles(): Array<{ name: string, text: string }> {
	return readdirSync(PROOF_DIR)
		.filter((n) => /\.(?:ts|tsx|js|mjs)$/.test(n))
		.map((n) => ({ name: n, text: readFileSync(join(PROOF_DIR, n), 'utf8') }))
}

function appSourceFiles(): Array<{ name: string, text: string }> {
	const out: Array<{ name: string, text: string }> = []
	const self = join(__dirname, 'decrypt-probe.gate.test.ts')
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.name === 'node_modules') continue
			const full = join(dir, e.name)
			if (e.isDirectory()) walk(full)
			else if (/\.(?:ts|tsx|js)$/.test(e.name) && full !== self) out.push({ name: relative(APP_DIR, full), text: readFileSync(full, 'utf8') })
		}
	}
	walk(join(APP_DIR, 'src'))
	for (const n of ['index.js', 'App.tsx']) {
		const full = join(APP_DIR, n)
		if (existsSync(full)) out.push({ name: n, text: readFileSync(full, 'utf8') })
	}
	return out
}

function proofBases(): string[] {
	return readdirSync(PROOF_DIR).map((n) => n.replace(/\.(?:tsx?|jsx?|mjs|json)$/, ''))
}

const METRO = readFileSync(join(APP_DIR, 'metro.config.js'), 'utf8')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decrypt probe gate (T-64-20, Voter side)', () => {
	it('resolves every real file (path sanity)', () => {
		for (const n of [DEC_FILE, PRE_FILE, ENTRY_FILE]) expect(existsSync(join(PROOF_DIR, n))).toBe(true)
	})

	it('the probe files hold no URL scheme separator, so the line-comment stripper is safe on them', () => {
		for (const raw of [DEC, PRE, ENTRY]) expect(raw.includes('://')).toBe(false)
	})

	it('is not vacuous: the scans see the content each rule depends on', () => {
		expect(DEC).toContain("'decrypt-probe/1'")
		expect(DEC).toContain('openVoteEntries')
		expect(proofCodeFiles().length).toBeGreaterThanOrEqual(8)
		expect(loopBodies(stripCommentsPreservingLines(DEC)).length).toBeGreaterThan(4)
		expect(memberCalls(stripCommentsPreservingLines(DEC)).length).toBeGreaterThan(20)
	})

	it('V1 SQL: the probe has one select literal on VoteBlock and the others have none', () => {
		expect(checkSql(stripCommentsPreservingLines(DEC), 'DEC', 1, 'from VoteBlock')).toEqual([])
		expect(checkSql(stripCommentsPreservingLines(ENTRY), 'ENTRY', 0, null)).toEqual([])
		expect(checkSql(stripCommentsPreservingLines(PRE), 'PRE', 0, null)).toEqual([])
	})

	it('V2 deny-list: no storage, vault, release, seeding, provisioning or write call', () => {
		for (const [label, raw] of [['DEC', DEC], ['ENTRY', ENTRY], ['PRE', PRE]] as const) {
			expect(checkDeny(stripCommentsPreservingLines(raw), label)).toEqual([])
		}
	})

	it('V3 allow-lists: the member calls are the pinned set and only keyRelease and elections are named', () => {
		expect(checkEngines(stripCommentsPreservingLines(DEC))).toEqual([])
		expect([...new Set([...stripCommentsPreservingLines(DEC).matchAll(/getEngine\s*\(\s*'([^']*)'/g)].map((m) => m[1]))].sort()).toEqual(['elections', 'keyRelease'])
	})

	it('V4 every console call takes one string literal', () => {
		for (const [label, raw] of [['DEC', DEC], ['ENTRY', ENTRY], ['PRE', PRE]] as const) {
			expect(checkConsole(stripCommentsPreservingLines(raw), label)).toEqual([])
		}
	})

	it('V5 closed shape: pinned keys and every result goes through closedJson', () => {
		expect(checkClosedShape(stripCommentsPreservingLines(DEC))).toEqual([])
	})

	it('V6 secrets: the key is zeroed in a finally and no vote material reaches a result or log line', () => {
		expect(checkSecrets(stripCommentsPreservingLines(DEC))).toEqual([])
	})

	it('V7 registry: one registration of decrypt across every scripts/proof file, with __DEV__ guards', () => {
		expect(checkRegistry(stripCommentsPreservingLines(DEC))).toEqual([])
		expect(checkEntryRegistration(stripCommentsPreservingLines(ENTRY))).toEqual([])
		expect(checkRegistryUnique(proofCodeFiles())).toEqual([])
	})

	it('V8 Hermes: no closure inside a loop body', () => {
		for (const [label, raw] of [['DEC', DEC], ['ENTRY', ENTRY], ['PRE', PRE]] as const) {
			expect(checkHermes(stripCommentsPreservingLines(raw), label)).toEqual([])
		}
	})

	it('V9 the preimage has no import and the probe takes it from there', () => {
		expect(checkPreimage(stripCommentsPreservingLines(PRE), stripCommentsPreservingLines(DEC))).toEqual([])
	})

	it('V10 never in the app: no import of scripts/proof, no probe name in the Metro config, no require', () => {
		const files = appSourceFiles()
		expect(files.length).toBeGreaterThan(20)
		expect(checkNeverInApp(files, proofBases(), METRO)).toEqual([])
		expect([DEC, ENTRY, PRE].flatMap((raw) => checkNoRequire(stripCommentsPreservingLines(raw), 'x'))).toEqual([])
	})

	it('the whole-file checkers report nothing on the real files', () => {
		expect(checkDec(DEC)).toEqual([])
		expect(checkEntry(ENTRY)).toEqual([])
		expect(checkPre(PRE)).toEqual([])
	})

	describe('planted mutations (each rule can fail)', () => {
		const plantDec = (extra: string): string[] => checkDec(DEC + '\n' + extra + '\n')
		const has = (v: string[], id: string): boolean => v.some((x) => x.startsWith(id))

		it('V1 planted: a delete statement, a backtick literal and an eval outside the probe are reported', () => {
			expect(has(plantDec("async function x(db: any) { for await (const r of db.eval('delete from VoteBlock', {})) { void r } }"), 'V1')).toBe(true)
			expect(has(plantDec('async function x(db: any) { for await (const r of db.eval(`select 1`, {})) { void r } }'), 'V1')).toBe(true)
			expect(has(checkPre(PRE + "\nfunction x(db: any) { return db.eval('select 1', {}) }\n"), 'V1')).toBe(true)
		})

		it('V2 planted: a release, a seeding call, a storage write and a provisioning call are reported', () => {
			expect(has(plantDec('async function x(k: any) { await k.releaseKeyShare() }'), 'V2')).toBe(true)
			expect(has(plantDec('async function x(k: any) { await k.getKeysToRelease() }'), 'V2')).toBe(true)
			expect(has(plantDec('async function x() { await AsyncStorage.' + SET_ITEM + "('k', 'v') }"), 'V2')).toBe(true)
			expect(has(plantDec('async function x(u: any) { await provisionDeviceKey(u) }'), 'V2')).toBe(true)
		})

		it('V3 planted: a new member call and a third engine name are reported', () => {
			expect(has(plantDec('function x(t: any) { t.insertRow(1) }'), 'V3')).toBe(true)
			expect(has(plantDec("async function x(c: any) { return c.getEngine('registration') }"), 'V3')).toBe(true)
		})

		it('V4 planted: a console call with a variable is reported', () => {
			expect(has(plantDec('function x(a: string) { console.log(a) }'), 'V4')).toBe(true)
			expect(has(plantDec("function x(a: string) { console.info('a' + a) }"), 'V4')).toBe(true)
		})

		it('V5 planted: an extra result key and a non-closed latest are reported', () => {
			expect(has(checkDec(DEC.replace("'v',", "'v', 'extraKey',")), 'V5')).toBe(true)
			expect(has(plantDec('function x(o: any) { latest = JSON.stringify(o) }'), 'V5')).toBe(true)
		})

		it('V6 planted: a key zeroed outside a finally, a needle on a result line and a raw channel are reported', () => {
			expect(has(checkDec(DEC.replace('recon.secretKey.fill(0)', 'void 0')), 'V6')).toBe(true)
			expect(has(plantDec('function x(needle: string) { return closedJson({ a: needle }) }'), 'V6')).toBe(true)
			expect(has(plantDec('function x(a: any) { console.info(a.voteEntryJson) }'), 'V6')).toBe(true)
			expect(has(plantDec('function rawChunkDec(i: number) { return i }'), 'V6')).toBe(true)
		})

		it('V7 planted: a duplicate name, an async start and an unguarded entry call are reported', () => {
			expect(has(checkRegistryUnique([{ name: 'one.ts', text: DEC }, { name: 'two.ts', text: DEC }]), 'V7')).toBe(true)
			expect(has(plantDec('async function startDecrypt(a: string) { return a }'), 'V7')).toBe(true)
			expect(has(checkEntry(ENTRY.replace('if (__DEV__) {', 'if (true) {')), 'V7')).toBe(true)
			expect(has(checkEntry(ENTRY.replace("import '../../apps/VoteTorrentVoter/index.js';", '')), 'V7')).toBe(true)
		})

		it('V8 planted: a closure pushed inside a loop is reported', () => {
			expect(has(plantDec('function x(rows: number[], fns: any[]) { for (const r of rows) { fns.push(() => r) } }'), 'V8')).toBe(true)
			expect(has(checkPre(PRE + '\nfunction y(rows: number[], fns: any[]) { while (rows.length > 0) { fns.push(function () { return 1 }) } }\n'), 'V8')).toBe(true)
		})

		it('V9 planted: an import in the preimage and a probe that stops importing it are reported', () => {
			expect(has(checkPreimage("import x from './other'\n" + PRE, DEC), 'V9')).toBe(true)
			expect(has(checkPreimage(PRE, DEC.replace("from './opened-set-preimage'", "from './other'")), 'V9')).toBe(true)
		})

		it('V10 planted: an app import of a probe, a Metro config naming the flag and a require are reported', () => {
			const planted = [{ name: 'planted.ts', text: "import x from '../../../../scripts/proof/decrypt-probe'\n" }]
			expect(has(checkNeverInApp(planted, proofBases(), METRO), 'V10')).toBe(true)
			expect(has(checkNeverInApp([], proofBases(), METRO + '\n// ' + PROBES_FLAG + '\n'), 'V10')).toBe(true)
			expect(has(checkNeverInApp([{ name: 'p.ts', text: "import x from './opened-set-preimage'" }], proofBases(), METRO), 'V10')).toBe(true)
			expect(has(plantDec("const m = require('x')"), 'V10')).toBe(true)
		})

		it('P-comment: every planted violation placed only inside comments reports nothing', () => {
			const commented = [
				"// db.eval('delete from VoteBlock', {})",
				'// AsyncStorage.' + SET_ITEM + "('k', 'v'); provisionDeviceKey(u); k.releaseKeyShare(); k.getKeysToRelease()",
				"/* c.getEngine('registration'); console.log(a); latest = JSON.stringify(o); closedJson({ a: needle }) */",
				"// import x from './other'; const m = require('x'); function rawChunkDec() {}",
				'// for (const r of rows) { fns.push(() => r) }',
			].join('\n')
			expect(checkDec(DEC + '\n' + commented + '\n')).toEqual([])
			expect(checkEntry(ENTRY + '\n' + commented + '\n')).toEqual([])
			expect(checkPre(PRE + '\n' + commented + '\n')).toEqual([])
			expect(checkNeverInApp([{ name: 'c.ts', text: "// import x from '../../../../scripts/proof/decrypt-probe'\n" }], proofBases(), METRO)).toEqual([])
		})
	})
})
