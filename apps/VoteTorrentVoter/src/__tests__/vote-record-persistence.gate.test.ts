/**
 * vote-record-persistence.gate.test.ts - D-29 / D-19 ciphertext-only persistence source gate
 * (Phase 63 plan 08). This is the PATTERNS "vault no-plaintext gate".
 *
 * Rules, all scanned on comment-stripped source:
 *   V1  vote-record-vault.ts performs no persistence: no AsyncStorage / LevelDB / fs reference and
 *       no setItem / multiSet / mergeItem / multiMerge / removeItem / multiRemove call.
 *   S1  vote-record-store.ts makes no write call other than setItem, and no clear call.
 *   S2  every setItem in the store is one of exactly two allowlisted shapes (the record write of
 *       the envelope, the marker write of the marker), each exactly once, record before marker.
 *   S3  the only JSON.stringify arguments in the store are `envelope` and `marker`, once each.
 *   K1  no other non-test file under apps/VoteTorrentVoter/src references the two key prefixes,
 *       the key builders or the prefix constants, so nothing can write the keys around the store.
 *
 * The scan uses the line-preserving comment stripper copied from no-vrg-ceremony.gate.test.ts.
 * Exclusions are by file suffix (*.test.ts / *.test.tsx) only, never by directory name (T-51-12-05).
 * Every forbidden literal is assembled by concatenation so this file cannot trip its own scan.
 * Each rule has a planted fixture caught at the right file and line and a comment-only twin that
 * is not caught.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type Rule = 'V1' | 'S1' | 'S2' | 'S3' | 'ORDER' | 'K1'
interface Violation {
	rule: Rule
	file: string
	line: number
	token: string
	text: string
}

function stripCommentsPreservingLines(src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

function lineOf(stripped: string, index: number): number {
	return stripped.slice(0, index).split('\n').length
}

function lineText(stripped: string, line: number): string {
	return (stripped.split('\n')[line - 1] ?? '').trim()
}

const TEST_FILE_PATTERN = /\.test\.(ts|tsx)$/

const WRITE_CALL_RE = /\b(setItem|multiSet|mergeItem|multiMerge|removeItem|multiRemove)\s*\(/g
const CLEAR_RE = /\.\s*clear\s*\(/g
const VAULT_TOKENS = ['AsyncStorage', '@react-native-async-storage', 'rn-leveldb', 'react-native-fs']

const RECORD_WRITE_RE =
	/AsyncStorage\s*\.\s*setItem\s*\(\s*voteRecordKey\s*\(\s*marker\s*\.\s*electionId\s*\)\s*,\s*JSON\s*\.\s*stringify\s*\(\s*envelope\s*\)\s*,?\s*\)/g
const MARKER_WRITE_RE =
	/AsyncStorage\s*\.\s*setItem\s*\(\s*voteMarkerKey\s*\(\s*marker\s*\.\s*electionId\s*\)\s*,\s*JSON\s*\.\s*stringify\s*\(\s*marker\s*\)\s*,?\s*\)/g
const STRINGIFY_RE = /JSON\s*\.\s*stringify\s*\(\s*([^\s,)]*)/g

function mk(rule: Rule, file: string, stripped: string, index: number, token: string): Violation {
	const line = lineOf(stripped, index)
	return { rule, file, line, token, text: lineText(stripped, line) }
}

function scanVault(file: string, raw: string): Violation[] {
	const stripped = stripCommentsPreservingLines(raw)
	const out: Violation[] = []
	for (const t of VAULT_TOKENS) {
		let i = stripped.indexOf(t)
		while (i !== -1) {
			out.push(mk('V1', file, stripped, i, t))
			i = stripped.indexOf(t, i + t.length)
		}
	}
	for (const m of stripped.matchAll(WRITE_CALL_RE)) out.push(mk('V1', file, stripped, m.index!, m[1]!))
	return out
}

interface StoreScan {
	violations: Violation[]
	recordWriteLine: number | null
	markerWriteLine: number | null
	setItemCount: number
}

function scanStore(file: string, raw: string): StoreScan {
	const stripped = stripCommentsPreservingLines(raw)
	const violations: Violation[] = []
	const allowedSetItemIdx = new Set<number>()
	const starts: { record: number[]; marker: number[] } = { record: [], marker: [] }
	for (const m of stripped.matchAll(RECORD_WRITE_RE)) {
		starts.record.push(m.index!)
		allowedSetItemIdx.add(m.index! + m[0].indexOf('setItem'))
	}
	for (const m of stripped.matchAll(MARKER_WRITE_RE)) {
		starts.marker.push(m.index!)
		allowedSetItemIdx.add(m.index! + m[0].indexOf('setItem'))
	}
	let setItemCount = 0
	for (const m of stripped.matchAll(WRITE_CALL_RE)) {
		if (m[1] !== 'setItem') {
			violations.push(mk('S1', file, stripped, m.index!, m[1]!))
			continue
		}
		setItemCount += 1
		if (!allowedSetItemIdx.has(m.index!)) violations.push(mk('S2', file, stripped, m.index!, 'setItem'))
	}
	for (const m of stripped.matchAll(CLEAR_RE)) violations.push(mk('S1', file, stripped, m.index!, 'clear'))
	if (starts.record.length !== 1) violations.push({ rule: 'S2', file, line: 0, token: 'record-write-count:' + starts.record.length, text: '' })
	if (starts.marker.length !== 1) violations.push({ rule: 'S2', file, line: 0, token: 'marker-write-count:' + starts.marker.length, text: '' })
	const recordWriteLine = starts.record.length > 0 ? lineOf(stripped, starts.record[0]!) : null
	const markerWriteLine = starts.marker.length > 0 ? lineOf(stripped, starts.marker[0]!) : null
	if (recordWriteLine !== null && markerWriteLine !== null && recordWriteLine > markerWriteLine) {
		violations.push({ rule: 'ORDER', file, line: markerWriteLine, token: 'marker-before-record', text: lineText(stripped, markerWriteLine) })
	}
	const seen: Record<string, number> = {}
	for (const m of stripped.matchAll(STRINGIFY_RE)) {
		const id = m[1]!
		seen[id] = (seen[id] ?? 0) + 1
		if (id !== 'envelope' && id !== 'marker') violations.push(mk('S3', file, stripped, m.index!, id))
	}
	if (seen.envelope !== 1 || seen.marker !== 1) {
		violations.push({ rule: 'S3', file, line: 0, token: 'stringify-counts:' + JSON.stringify(seen), text: '' })
	}
	return { violations, recordWriteLine, markerWriteLine, setItemCount }
}

const K1_TOKENS: string[] = [
	'votetorrent.vote' + 'Marker.',
	'votetorrent.vote' + 'Record.',
	'voteMarker' + 'Key(',
	'voteRecord' + 'Key(',
	'VOTE_MARKER' + '_KEY_PREFIX',
	'VOTE_RECORD' + '_KEY_PREFIX',
]

function walkSourceFiles(root: string, excludeAbsPaths: ReadonlySet<string>): string[] {
	const out: string[] = []
	const stack: string[] = [root]
	while (stack.length > 0) {
		const dir = stack.pop() as string
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry)
			if (statSync(full).isDirectory()) {
				stack.push(full)
				continue
			}
			if (!/\.(ts|tsx)$/.test(entry)) continue
			if (excludeAbsPaths.has(full)) continue
			if (TEST_FILE_PATTERN.test(entry)) continue
			out.push(full)
		}
	}
	return out
}

function scanKeyReferences(root: string, excludeAbsPaths: ReadonlySet<string>): Violation[] {
	const out: Violation[] = []
	for (const file of walkSourceFiles(root, excludeAbsPaths)) {
		const stripped = stripCommentsPreservingLines(readFileSync(file, 'utf8'))
		for (const t of K1_TOKENS) {
			let i = stripped.indexOf(t)
			while (i !== -1) {
				out.push(mk('K1', file, stripped, i, t))
				i = stripped.indexOf(t, i + t.length)
			}
		}
	}
	return out
}

function countsBy(violations: Violation[]): Record<string, number> {
	const out: Record<string, number> = {}
	for (const v of violations) out[`${v.rule}:${v.token}`] = (out[`${v.rule}:${v.token}`] ?? 0) + 1
	return out
}

function detail(violations: Violation[]): string {
	return violations.map((v) => `${v.file}:${v.line} [${v.rule}:${v.token}] ${v.text}`).join('\n')
}

// ---------------------------------------------------------------------------
// 1. Real target
// ---------------------------------------------------------------------------

const STORE = join(__dirname, '../engines/vote-record-store.ts')
const VAULT = join(__dirname, '../engines/vote-record-vault.ts')
const SRC = join(__dirname, '..')

describe('vote-record persistence gate - real target', () => {
	it('the store and vault exist (non-vacuous)', () => {
		expect(existsSync(STORE)).toBe(true)
		expect(existsSync(VAULT)).toBe(true)
	})

	it('V1: the vault performs no persistence', () => {
		const v = scanVault(VAULT, readFileSync(VAULT, 'utf8'))
		expect({ counts: countsBy(v), detail: detail(v) }).toEqual({ counts: {}, detail: '' })
	})

	it('S1/S2/S3: the store writes only the envelope and marker, record then marker', () => {
		const scan = scanStore(STORE, readFileSync(STORE, 'utf8'))
		expect({ counts: countsBy(scan.violations), detail: detail(scan.violations) }).toEqual({ counts: {}, detail: '' })
		expect(scan.setItemCount).toBe(2)
		expect(scan.recordWriteLine).not.toBeNull()
		expect(scan.markerWriteLine).not.toBeNull()
		expect(scan.recordWriteLine!).toBeLessThan(scan.markerWriteLine!)
	})

	it('K1: no other source file references the keys', () => {
		const v = scanKeyReferences(SRC, new Set([STORE]))
		expect({ counts: countsBy(v), detail: detail(v) }).toEqual({ counts: {}, detail: '' })
	})
})

// ---------------------------------------------------------------------------
// 2. Planted fixtures
// ---------------------------------------------------------------------------

const REC = 'await AsyncStorage.setItem(voteRecordKey(marker.electionId), JSON.stringify(envelope))'
const MRK = 'await AsyncStorage.setItem(voteMarkerKey(marker.electionId), JSON.stringify(marker))'
const EXTRA = 'await AsyncStorage.setItem(voteRecordKey(id), JSON.stringify(record))'

describe('vote-record persistence gate - planted fixtures', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'vote-record-persistence-gate-'))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	function scanSrc(lines: string[]): StoreScan {
		const file = join(dir, 'store.ts')
		const raw = lines.join('\n')
		writeFileSync(file, raw)
		return scanStore(file, raw)
	}

	it('P1: a third setItem fed by another value is caught by S2 and S3 at its line', () => {
		const file = join(dir, 'store.ts')
		const scan = scanSrc(["import AsyncStorage from 'x'", REC, MRK, '', EXTRA])
		const s2 = scan.violations.filter((v) => v.rule === 'S2')
		const s3 = scan.violations.filter((v) => v.rule === 'S3' && v.line > 0)
		expect(s2.map((v) => [v.file, v.line])).toEqual([[file, 5]])
		expect(s3.map((v) => [v.file, v.line, v.token])).toEqual([[file, 5, 'record']])
	})

	it('P2: the same text inside a block comment is not caught', () => {
		const scan = scanSrc(["import AsyncStorage from 'x'", REC, MRK, '/*', EXTRA, '*/'])
		expect(scan.violations).toEqual([])
		expect(scan.setItemCount).toBe(2)
	})

	it('P3: marker written before the record is an order violation', () => {
		const scan = scanSrc([MRK, REC])
		expect(scan.violations.filter((v) => v.rule === 'ORDER').map((v) => v.line)).toEqual([1])
	})

	it('P4: multiSet is caught by S1 at its line, and not when commented', () => {
		const scan = scanSrc([REC, MRK, 'await AsyncStorage.multiSet([[a, b], [c, d]])'])
		expect(scan.violations.filter((v) => v.rule === 'S1').map((v) => [v.line, v.token])).toEqual([[3, 'multiSet']])
		const twin = scanSrc([REC, MRK, '// await AsyncStorage.multiSet([[a, b], [c, d]])'])
		expect(twin.violations).toEqual([])
	})

	it('P5: a persistence import in the vault is caught by V1 at line 1, and not when commented', () => {
		const file = join(dir, 'vault.ts')
		const line = "import AsyncStorage from '@react-native-async-storage/async-storage'"
		const hits = scanVault(file, line + '\nexport const x = 1\n')
		expect(hits.length).toBeGreaterThan(0)
		expect(hits.every((v) => v.rule === 'V1' && v.line === 1 && v.file === file)).toBe(true)
		expect(scanVault(file, '// ' + line + '\nexport const x = 1\n')).toEqual([])
	})

	it('P6: a source file referencing a key prefix is caught by K1 at its line; test files and comments are not', () => {
		const prefix = 'votetorrent.vote' + 'Marker.'
		const code = `export const k = '${prefix}' + id`
		mkdirSync(join(dir, '__tests__'))
		writeFileSync(join(dir, 'screen.ts'), ['// header', code].join('\n'))
		writeFileSync(join(dir, 'screen.test.ts'), ['// header', code].join('\n'))
		writeFileSync(join(dir, '__tests__', 'helper.test.ts'), code)
		writeFileSync(join(dir, 'screen2.ts'), ['/*', code, '*/', '// ' + code].join('\n'))
		const hits = scanKeyReferences(dir, new Set())
		expect(hits.map((v) => [v.file, v.line, v.rule])).toEqual([[join(dir, 'screen.ts'), 2, 'K1']])
	})

	it('P6b: a non-test file inside a __tests__ directory is still scanned (suffix-only exclusion)', () => {
		mkdirSync(join(dir, '__tests__'))
		writeFileSync(join(dir, '__tests__', 'helper.ts'), `const b = voteRecord${'Key('}id)`)
		expect(scanKeyReferences(dir, new Set()).map((v) => v.line)).toEqual([1])
	})

	it('P7: prettier-wrapped allowlisted writes pass and report the AsyncStorage line', () => {
		const scan = scanSrc([
			'async function w() {',
			'\tawait AsyncStorage.setItem(',
			'\t\tvoteRecordKey(marker.electionId),',
			'\t\tJSON.stringify(envelope),',
			'\t)',
			'\tawait AsyncStorage.setItem(',
			'\t\tvoteMarkerKey(marker.electionId),',
			'\t\tJSON.stringify(marker),',
			'\t)',
			'}',
		])
		expect(scan.violations).toEqual([])
		expect(scan.recordWriteLine).toBe(2)
		expect(scan.markerWriteLine).toBe(6)
	})
})
