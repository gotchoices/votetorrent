/**
 * vote-receipt-no-module-cache.gate.test.ts - T-63-12-02 (Phase 63 plan 12): neither the receipt
 * engine nor the receipt screen keeps a module-level copy of the decrypted record. Scanned on
 * comment-stripped source:
 *   M1  no top-level `let` / `var` (exported or not).
 *   M2  no top-level `const` outside a closed allowlist of pure constants, and none whose
 *       initializer is a Map / WeakMap / Set / WeakSet, or the result of a record or reveal call.
 *
 * The allowlist is exact, so a new top-level binding fails here until it is reviewed. Planted
 * fixtures prove each rule can fail.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

function stripCommentsPreservingLines(src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

const RECEIPT_ENGINE = join(__dirname, '..', 'engines', 'vote-receipt.ts')
const RECEIPT_SCREEN = join(__dirname, '..', 'screens', 'ballot', 'VoteReceiptScreen.tsx')

const ALLOWED_CONSTS: Record<string, readonly string[]> = {
	'vote-receipt.ts': ['NONCE_GROUP_COUNT', 'NONCE_GROUP_SIZE', 'NONCE_RE', 'REVEAL_BY_REASON'],
	'VoteReceiptScreen.tsx': ['NOTICE_KEY', 'styles'],
}
const CACHE_INIT_RE = /\bnew\s+(Weak)?(Map|Set)\b|\b(open|reveal|load|read)\w*(Record|Receipt|Vote)\w*\s*\(|\bawait\b/i

/** Pure checker: readable violation strings, empty when the module holds no module-level state. */
function checkNoModuleCache(file: string, raw: string, allowed: readonly string[]): string[] {
	const out: string[] = []
	const s = stripCommentsPreservingLines(raw)
	for (const m of s.matchAll(/^(?:export\s+)?(let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
		out.push(`M1: ${file} has a top-level ${m[1]} ${m[2]}`)
	}
	for (const m of s.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/gm)) {
		const name = m[1]!
		const rest = s.slice(m.index! + m[0].length)
		const end = rest.search(/\n(?=[^\s})\]])/)
		const init = end < 0 ? rest : rest.slice(0, end)
		if (!allowed.includes(name)) out.push(`M2: ${file} has top-level const ${name} outside the allowlist`)
		if (CACHE_INIT_RE.test(init)) out.push(`M2: ${file} top-level const ${name} is initialised from a cache or record call`)
	}
	return out
}

describe('receipt modules hold no module-level decrypted record (T-63-12-02, 63-12)', () => {
	it('resolves both receipt modules (path sanity)', () => {
		expect(existsSync(RECEIPT_ENGINE)).toBe(true)
		expect(existsSync(RECEIPT_SCREEN)).toBe(true)
	})

	it('vote-receipt.ts has no top-level mutable binding or record cache', () => {
		expect(checkNoModuleCache('vote-receipt.ts', readFileSync(RECEIPT_ENGINE, 'utf8'), ALLOWED_CONSTS['vote-receipt.ts']!)).toEqual([])
	})

	it('VoteReceiptScreen.tsx has no top-level mutable binding or record cache', () => {
		expect(checkNoModuleCache('VoteReceiptScreen.tsx', readFileSync(RECEIPT_SCREEN, 'utf8'), ALLOWED_CONSTS['VoteReceiptScreen.tsx']!)).toEqual([])
	})

	it('the scan sees the allowlisted constants (it is not vacuous)', () => {
		const engine = stripCommentsPreservingLines(readFileSync(RECEIPT_ENGINE, 'utf8'))
		const screen = stripCommentsPreservingLines(readFileSync(RECEIPT_SCREEN, 'utf8'))
		for (const n of ALLOWED_CONSTS['vote-receipt.ts']!) expect(engine).toMatch(new RegExp(`^(export )?const ${n}\\b`, 'm'))
		for (const n of ALLOWED_CONSTS['VoteReceiptScreen.tsx']!) expect(screen).toMatch(new RegExp(`^(export )?const ${n}\\b`, 'm'))
	})

	describe('planted self-tests (the checker can fail)', () => {
		const engine = readFileSync(RECEIPT_ENGINE, 'utf8')
		const allowed = ALLOWED_CONSTS['vote-receipt.ts']!
		const plant = (extra: string): string[] => checkNoModuleCache('vote-receipt.ts', engine + '\n' + extra + '\n', allowed)

		it('P1: a planted top-level let cachedRecord reports M1', () => {
			const v = plant('let cachedRecord: unknown = null')
			expect(v).toContain('M1: vote-receipt.ts has a top-level let cachedRecord')
		})

		it('P2: a planted exported var reports M1', () => {
			expect(plant('export var lastReveal = 0').some((x) => x.startsWith('M1'))).toBe(true)
		})

		it('P3: a planted module-level Map cache reports both M2 rules', () => {
			const v = plant('const recordCache = new Map<string, unknown>()')
			expect(v.some((x) => x.includes('recordCache outside the allowlist'))).toBe(true)
			expect(v.some((x) => x.includes('recordCache is initialised from a cache or record call'))).toBe(true)
		})

		it('P4: an allowlisted name initialised from a reveal call still reports M2', () => {
			const v = plant('const NONCE_RE2 = revealVoteReceipt(a, b)')
			expect(v.some((x) => x.startsWith('M2'))).toBe(true)
			const v2 = checkNoModuleCache('x.ts', 'const NOTICE_KEY = openVoteRecord(a)\n', ['NOTICE_KEY'])
			expect(v2.some((x) => x.includes('initialised from a cache or record call'))).toBe(true)
		})

		it('P5: the same planted binding inside a // comment is not reported', () => {
			expect(plant('// let cachedRecord = null\n/* var x = 1 */')).toEqual([])
		})

		it('P6: an indented let inside a function is not a module-level binding', () => {
			expect(plant('function f() {\n\tlet local = 1\n\treturn local\n}')).toEqual([])
		})
	})
})
