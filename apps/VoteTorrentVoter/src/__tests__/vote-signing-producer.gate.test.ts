/**
 * vote-signing-producer.gate.test.ts - D-08 source gate (Phase 63 plan 11), plus the castVote
 * signing-shape rules (D-16, D-26).
 *
 * D-08: vote signing uses the real producer in every build. The resolver that eligibility uses is
 * real-only, but it returns an injected override unchanged, so this gate is what keeps the dev stub
 * out of the vote path. It bans the stub producer name, the legacy resolver name and the stub
 * signature placeholder (all named here only in words) in the app's vote-casting binding, every
 * vote-record-*.ts (current and future, by filename pattern), every `vote-*.ts` and `run-vote-send.ts`
 * under the SHARED voter directory (`packages/workflows/src/voter`, phase 67 plan 22), and every
 * non-test file under either root that imports vote-casting (with or without a `.js` suffix). The
 * castVote shape rules read the SHARED vote-casting.ts; R5 pins the app binding to no logic. The
 * device proof's `producer-real` leg is the runtime counterpart.
 *
 * The castVote shape rules: exactly one sign call on the eligibility producer, a single producer
 * resolution, a nonce from the CSPRNG with one argument (D-16), the normalized key in the voter
 * entry (D-26), and the build, sign, verify, seal, store order.
 *
 * Comments are stripped with the line-preserving stripper copied from no-vrg-ceremony.gate.test.ts;
 * exclusions are by file suffix only, never by directory name (T-51-12-05); every searched literal
 * is assembled by concatenation, so this file cannot trip its own scan (self-tripping-checker lesson).
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENGINES = join(__dirname, '../engines')
const SRC = join(__dirname, '..')
const SHARED_VOTER = join(__dirname, '../../../../packages/workflows/src/voter')
const CASTING = join(SHARED_VOTER, 'vote-casting.ts')
const BINDING = join(ENGINES, 'vote-casting.ts')

const STUB_PRODUCER = 'Stub' + 'AttestationProducer'
const LEGACY_RESOLVER = 'resolveAttestation' + 'Producer'
const STUB_PLACEHOLDER = 'STUB_DEVICE_KEY_' + 'SIGNATURE_PLACEHOLDER'
const PRODUCER_TOKENS = [STUB_PRODUCER, LEGACY_RESOLVER, STUB_PLACEHOLDER] as const

const TEST_FILE_PATTERN = /\.test\.(ts|tsx)$/

function stripCommentsPreservingLines (src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

function lineOf (stripped: string, index: number): number {
	return stripped.slice(0, index).split('\n').length
}

/** From the `function <name> (` line through the first following line that is exactly `}`. Throws when absent. */
function sliceFunction (src: string, name: string): string {
	const lines = src.split('\n')
	const head = new RegExp('^(export\\s+)?(async\\s+)?function\\s+' + name + ' \\(')
	const start = lines.findIndex(l => head.test(l))
	if (start < 0) throw new Error(`sliceFunction: function ${name} not found`)
	let end = start
	while (end < lines.length && lines[end] !== '}') end++
	return lines.slice(start, end + 1).join('\n')
}

interface Violation {
	rule: string
	file: string
	line: number
	token: string
	text: string
}

function walkSourceFiles (root: string): string[] {
	const out: string[] = []
	const stack = [root]
	while (stack.length > 0) {
		const dir = stack.pop()!
		for (const entry of readdirSync(dir)) {
			const abs = join(dir, entry)
			if (statSync(abs).isDirectory()) {
				if (entry === 'node_modules') continue
				stack.push(abs)
			} else if (/\.(ts|tsx)$/.test(entry) && !TEST_FILE_PATTERN.test(entry)) {
				out.push(abs)
			}
		}
	}
	return out.sort()
}

function voteSigningTargets (enginesDir: string): string[] {
	return readdirSync(enginesDir)
		.filter(n => n === 'vote-casting.ts' || /^vote-record-.*\.ts$/.test(n))
		.filter(n => !TEST_FILE_PATTERN.test(n))
		.map(n => join(enginesDir, n))
		.sort()
}

/** The shared voter directory's vote files: every non-test `vote-*.ts` plus `run-vote-send.ts`. */
function sharedVoteTargets (sharedDir: string): string[] {
	return readdirSync(sharedDir)
		.filter(n => /^vote-.*\.ts$/.test(n) || n === 'run-vote-send.ts')
		.filter(n => !TEST_FILE_PATTERN.test(n))
		.map(n => join(sharedDir, n))
		.sort()
}

/** D8-1 */
function scanProducerTokens (files: readonly string[]): Violation[] {
	const out: Violation[] = []
	for (const file of files) {
		const stripped = stripCommentsPreservingLines(readFileSync(file, 'utf8'))
		stripped.split('\n').forEach((text, idx) => {
			for (const token of PRODUCER_TOKENS) {
				const hit = token === STUB_PLACEHOLDER ? text.includes(token) : new RegExp('\\b' + token + '\\b').test(text)
				if (hit) out.push({ rule: 'D8-1', file, line: idx + 1, token, text: text.trim() })
			}
		})
	}
	return out
}

/** D8-2: every non-test file under any root that imports vote-casting (an optional `.js` suffix included). */
function scanImporters (roots: readonly string[]): { importers: string[], violations: Violation[] } {
	const importers = roots.flatMap(root => walkSourceFiles(root)).filter(f => /from\s+['"][^'"]*\/vote-casting(\.js)?['"]/.test(stripCommentsPreservingLines(readFileSync(f, 'utf8'))))
	return { importers, violations: scanProducerTokens(importers).map(v => ({ ...v, rule: 'D8-2' })) }
}

/** R5: the tokens of a build, nonce, sign, verify or read-chain call; the app binding must contain none. */
const BINDING_LOGIC_TOKENS = [
	'signDeviceKey' + 'Digest(',
	'makeVote' + 'Nonce(',
	'buildVote' + 'Entry(',
	'voterEntry' + 'Digest(',
	'verifySig' + 'P256(',
	'getRandom' + 'Values(',
	'checkVoting' + 'Key(',
	'getAssociationsBy' + 'DeviceKey(',
] as const

/** Counts the top-level arguments of the call whose `(` is at `openIndex`. */
function callArgCount (src: string, openIndex: number): number {
	let depth = 0
	let args = 0
	let sawContent = false
	for (let i = openIndex; i < src.length; i++) {
		const c = src[i]!
		if (c === '(' || c === '[' || c === '{') {
			depth += 1
			if (depth > 1) sawContent = true
		} else if (c === ')' || c === ']' || c === '}') {
			depth -= 1
			if (depth === 0) return sawContent ? args + 1 : 0
		} else if (c === ',' && depth === 1) {
			args += 1
		} else if (depth >= 1 && !/\s/.test(c)) {
			sawContent = true
		}
	}
	return -1
}

function countOf (text: string, token: string): number {
	return text.split(token).length - 1
}

/** D8-3, over the comment-stripped text of vote-casting.ts. */
function scanCastVoteShape (rawSrc: string, file = 'vote-casting.ts'): Violation[] {
	const src = stripCommentsPreservingLines(rawSrc)
	const out: Violation[] = []
	const add = (token: string, text: string, index = 0): void => {
		out.push({ rule: 'D8-3', file, line: lineOf(src, index), token, text })
	}
	const slice = (name: string): string => {
		try {
			return sliceFunction(src, name)
		} catch {
			add(name, 'missing function slice')
			return ''
		}
	}
	const cast = slice('castVote')
	const evaluate = slice('evaluateVoteEligibility')
	const nonce = slice('freshVoteNonce')

	const signToken = 'signDeviceKey' + 'Digest('
	const signCount = countOf(src, signToken)
	if (signCount !== 1) add(signToken, `count ${signCount}, expected 1`, src.indexOf(signToken))
	else if (!new RegExp('eligibility\\.producer\\.' + signToken.replace('(', '\\(')).test(cast)) add(signToken, 'sign call is not eligibility.producer in castVote', src.indexOf(signToken))

	const resolveToken = 'resolveVoteSigning' + 'Producer('
	const resolveCount = countOf(src, resolveToken)
	if (resolveCount !== 1) add(resolveToken, `count ${resolveCount}, expected 1`, src.indexOf(resolveToken))
	else if (!evaluate.includes(resolveToken)) add(resolveToken, 'resolution is outside evaluateVoteEligibility', src.indexOf(resolveToken))

	for (const banned of ['createReal' + 'AttestationProducer', 'Math' + '.random', 'voter' + 'Entropy']) {
		const n = countOf(src, banned)
		if (n !== 0) add(banned, `count ${n}, expected 0`, src.indexOf(banned))
	}

	const nonceToken = 'makeVote' + 'Nonce('
	const nonceCount = countOf(src, nonceToken)
	if (nonceCount !== 1) add(nonceToken, `count ${nonceCount}, expected 1`, src.indexOf(nonceToken))
	else {
		if (!nonce.includes(nonceToken)) add(nonceToken, 'nonce call is outside freshVoteNonce', src.indexOf(nonceToken))
		if (!nonce.includes('getRandomValues(new Uint8Array(32))')) add('getRandomValues', 'freshVoteNonce does not draw 32 CSPRNG bytes')
		const idx = src.indexOf(nonceToken)
		const args = callArgCount(src, idx + nonceToken.length - 1)
		if (args !== 1) add(nonceToken, `${args} arguments, expected exactly 1`, idx)
	}

	const order = ['evaluateVoteEligibility(', 'freshVoteNonce(', 'buildVoteEntry(', 'voterEntryDigest(', signToken, 'verifySigP256(', 'sealVoteRecord(', 'buildVoteMarker(', 'writeVoteRecord(']
	let last = -1
	for (const token of order) {
		const at = cast.indexOf(token)
		if (at < 0) { add(token, 'missing from castVote'); continue }
		if (at <= last) add(token, 'out of order in castVote')
		last = Math.max(last, at)
	}

	if (!cast.includes('deviceKey: eligibility.voter.compressedDeviceKey')) add('deviceKey', 'voter entry does not carry the compressed key')
	if (cast.includes('currentDevice' + 'Key')) add('currentDeviceKey', 'castVote reads the raw device key')
	return out
}

/** A minimal, well-formed castVote source the planted cases mutate. */
function goodCastSource (): string {
	return [
		'export async function evaluateVoteEligibility (deps: unknown) {',
		'\tconst producer = resolveVoteSigning' + 'Producer(deps)',
		'\treturn producer',
		'}',
		'function freshVoteNonce (): string {',
		'\tconst random = globalThis.crypto.getRandomValues(new Uint8Array(32))',
		'\treturn makeVote' + 'Nonce(random)',
		'}',
		'export async function castVote (deps: unknown) {',
		'\tconst eligibility = await evaluateVoteEligibility(deps)',
		'\tconst n = freshVoteNonce()',
		'\tconst v = buildVoteEntry({ nonce: n })',
		'\tconst digest = voterEntryDigest({ deviceKey: eligibility.voter.compressedDeviceKey })',
		'\tconst s = await eligibility.producer.signDeviceKey' + 'Digest(digest)',
		'\tverifySigP256(digest, s, 1)',
		'\tawait sealVoteRecord(v)',
		'\tconst m = buildVoteMarker(v)',
		'\tawait writeVoteRecord(v, m)',
		'}',
		'',
	].join('\n')
}

function countsBy (violations: Violation[]): Record<string, number> {
	return Object.fromEntries(PRODUCER_TOKENS.map(t => [t, violations.filter(v => v.token === t).length]))
}

const ZERO_COUNTS = Object.fromEntries(PRODUCER_TOKENS.map(t => [t, 0]))

describe('planted fixtures (the scanners can fail)', () => {
	let dir: string
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vote-signing-gate-')) })
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('P1 a stub producer token in code is reported at its file and line', () => {
		const f = join(dir, 'vote-casting.ts')
		writeFileSync(f, ['// header', 'const a = 1', '', 'const p = ' + STUB_PRODUCER + '', ''].join('\n'))
		const v = scanProducerTokens([f])
		expect(v.map(x => [x.file, x.line, x.token])).toEqual([[f, 4, STUB_PRODUCER]])
	})

	it('P2 a new vote-record-*.ts file is picked up and scanned', () => {
		writeFileSync(join(dir, 'vote-casting.ts'), '\n')
		const extra = join(dir, 'vote-record-extra.ts')
		writeFileSync(extra, ['export const x = 1', 'const r = ' + LEGACY_RESOLVER + '()', ''].join('\n'))
		writeFileSync(join(dir, 'vote-record-extra.test.ts'), 'const r = ' + LEGACY_RESOLVER + '()\n')
		writeFileSync(join(dir, 'other.ts'), 'const r = ' + LEGACY_RESOLVER + '()\n')
		const targets = voteSigningTargets(dir)
		expect(targets.map(t => t.slice(dir.length + 1))).toEqual(['vote-casting.ts', 'vote-record-extra.ts'])
		expect(scanProducerTokens(targets).map(x => [x.file, x.line])).toEqual([[extra, 2]])
	})

	it('P3 the same text inside comments gives zero violations', () => {
		const f = join(dir, 'vote-casting.ts')
		writeFileSync(f, [
			'/*',
			' * const p = ' + STUB_PRODUCER,
			' */',
			'// ' + STUB_PLACEHOLDER + '_NOT_REAL',
			'const ok = 1',
			'',
		].join('\n'))
		expect(scanProducerTokens([f])).toEqual([])
	})

	it('P4 importers of vote-casting are scanned; tests and non-importers are not', () => {
		const screen = join(dir, 'screen.tsx')
		writeFileSync(screen, ["import { castVote } from '../engines/vote-casting'", 'const r = ' + LEGACY_RESOLVER + '()', ''].join('\n'))
		writeFileSync(join(dir, 'screen.test.tsx'), ["import { castVote } from '../engines/vote-casting'", 'const r = ' + LEGACY_RESOLVER + '()', ''].join('\n'))
		writeFileSync(join(dir, 'other.tsx'), 'const r = ' + LEGACY_RESOLVER + '()\n')
		mkdirSync(join(dir, 'node_modules'))
		writeFileSync(join(dir, 'node_modules', 'dep.ts'), "import x from './vote-casting'\n" + LEGACY_RESOLVER + '\n')
		const { importers, violations } = scanImporters([dir])
		expect(importers).toEqual([screen])
		expect(violations.map(v => [v.rule, v.file, v.line])).toEqual([['D8-2', screen, 2]])
	})

	it('P6 an importer with a .js suffix under a second root is scanned', () => {
		const second = join(dir, 'shared-voter')
		mkdirSync(second)
		const runner = join(second, 'run-vote-send.ts')
		writeFileSync(runner, ["import { digestBytesFromBase64Url } from './vote-casting.js'", 'const r = ' + LEGACY_RESOLVER + '()', ''].join('\n'))
		writeFileSync(join(second, 'quiet.ts'), 'const r = ' + LEGACY_RESOLVER + '()\n')
		const first = join(dir, 'first')
		mkdirSync(first)
		writeFileSync(join(first, 'other.ts'), 'const ok = 1\n')
		const { importers, violations } = scanImporters([first, second])
		expect(importers).toEqual([runner])
		expect(violations.map(v => [v.rule, v.file, v.line])).toEqual([['D8-2', runner, 2]])
	})

	it('P5a the good fixture has no shape violations', () => {
		expect(scanCastVoteShape(goodCastSource())).toEqual([])
	})

	it('P5b two sign calls are reported', () => {
		const src = goodCastSource().replace('\tverifySigP256(', '\tawait eligibility.producer.signDeviceKey' + 'Digest(digest)\n\tverifySigP256(')
		expect(scanCastVoteShape(src).map(v => v.text)).toEqual(['count 2, expected 1'])
	})

	it('P5c a second nonce argument is reported; nested commas are not', () => {
		const two = goodCastSource().replace('makeVote' + 'Nonce(random)', 'makeVote' + "Nonce(random, 'x')")
		expect(scanCastVoteShape(two).map(v => v.text)).toEqual(['2 arguments, expected exactly 1'])
		const nested = goodCastSource().replace('makeVote' + 'Nonce(random)', 'makeVote' + 'Nonce(getBytes(a, b))')
		expect(scanCastVoteShape(nested)).toEqual([])
	})

	it('P5d sealing before signing is an order violation', () => {
		const src = goodCastSource()
			.replace('\tawait sealVoteRecord(v)\n', '')
			.replace('\tconst s = await', '\tawait sealVoteRecord(v)\n\tconst s = await')
		const v = scanCastVoteShape(src)
		expect(v.map(x => x.text)).toContain('out of order in castVote')
	})

	it('P5e the raw device key as deviceKey is reported', () => {
		const src = goodCastSource().replace('compressedDeviceKey', 'currentDevice' + 'Key')
		const tokens = scanCastVoteShape(src).map(v => v.token)
		expect(tokens).toContain('deviceKey')
		expect(tokens).toContain('currentDeviceKey')
	})
})

describe('real targets', () => {
	it('R1 the target set is non-vacuous', () => {
		const names = voteSigningTargets(ENGINES).map(f => f.slice(ENGINES.length + 1))
		for (const n of ['vote-casting.ts', 'vote-record-store.ts', 'vote-record-vault.ts', 'vote-record-wrap.ts']) expect(names).toContain(n)
		const shared = sharedVoteTargets(SHARED_VOTER).map(f => f.slice(SHARED_VOTER.length + 1))
		for (const n of ['vote-casting.ts', 'vote-sending.ts', 'vote-sending-port.ts', 'run-vote-send.ts']) expect(shared).toContain(n)
	})

	it('R2 D8-1: no stub producer, legacy resolver or stub placeholder in vote-casting, vote-record-* or the shared vote files', () => {
		const v = scanProducerTokens([...voteSigningTargets(ENGINES), ...sharedVoteTargets(SHARED_VOTER)])
		expect({ counts: countsBy(v), detail: v.map(x => `${x.file}:${x.line}`) }).toEqual({ counts: ZERO_COUNTS, detail: [] })
	})

	it('R3 D8-2: no importer of vote-casting under the app or the shared voter directory names the banned tokens', () => {
		const { importers, violations } = scanImporters([SRC, SHARED_VOTER])
		expect({ counts: countsBy(violations), detail: violations.map(x => `${x.file}:${x.line}`), importers: importers.length >= 0 }).toEqual({ counts: ZERO_COUNTS, detail: [], importers: true })
	})

	it('R4 D8-3: castVote keeps its signing shape', () => {
		const v = scanCastVoteShape(readFileSync(CASTING, 'utf8'), CASTING)
		expect(v.map(x => `${x.token} ${x.text} @${x.line}`)).toEqual([])
	})

	it('R5 the app binding at engines/vote-casting.ts makes no build, nonce, sign, verify or read-chain call', () => {
		const stripped = stripCommentsPreservingLines(readFileSync(BINDING, 'utf8'))
		const counts = Object.fromEntries(BINDING_LOGIC_TOKENS.map(t => [t, countOf(stripped, t)]))
		expect(counts).toEqual(Object.fromEntries(BINDING_LOGIC_TOKENS.map(t => [t, 0])))
		// not vacuous: the binding forwards to the shared castVote with the app seams
		expect(countOf(stripped, 'appVoteCastingSeams()')).toBe(2)
	})
})
