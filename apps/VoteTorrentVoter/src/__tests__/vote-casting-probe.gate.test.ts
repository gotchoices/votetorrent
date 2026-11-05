/**
 * vote-casting-probe.gate.test.ts - T-63-15-09 (Phase 63 plan 15): the on-device proof probe must
 * not become a second writer of vote state. Scanned on comment-stripped source:
 *   W1  exactly one `setItem(` call, and its key argument is the probe's own STATE_KEY constant.
 *   W2  STATE_KEY is built from the probe's own `votetorrent.voteProof.` namespace.
 *   W3  no removeItem / multiSet / multiRemove / mergeItem / multiMerge / clear call.
 *   W4  the vote key prefixes are imported from vote-record-store, never retyped as literals.
 *
 * The probe lives outside the app (scripts/proof), so the path is resolved from the repo root.
 * Every forbidden literal is assembled by concatenation so this file cannot trip its own scan.
 * Planted fixtures prove each rule can fail.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

function stripCommentsPreservingLines(src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

const PROBE = join(__dirname, '..', '..', '..', '..', 'scripts', 'proof', 'vote-casting-probe.ts')

const FORBIDDEN_CALLS = ['removeItem', 'multiSet', 'multiRemove', 'mergeItem', 'multiMerge', 'clear']
const RECORD_LITERAL = 'votetorrent.vote' + 'Record'
const MARKER_LITERAL = 'votetorrent.vote' + 'Marker'

/** Pure checker: readable violation strings, empty when the probe satisfies W1..W4. */
function checkProbe(raw: string): string[] {
	const out: string[] = []
	const s = stripCommentsPreservingLines(raw)

	const sets = [...s.matchAll(/\bsetItem\s*\(\s*([^,)]*)/g)]
	if (sets.length !== 1) out.push(`W1: setItem( occurs ${sets.length} times, expected exactly 1`)
	for (const m of sets) {
		if (m[1]!.trim() !== 'STATE_KEY') out.push(`W1: setItem key argument is "${m[1]!.trim()}", expected STATE_KEY`)
	}

	const stateKey = /\bconst\s+STATE_KEY\s*=\s*([^\n]*)/.exec(s)
	if (!stateKey) out.push('W2: STATE_KEY is not declared')
	else if (!stateKey[1]!.includes("'votetorrent.voteProof.'")) out.push('W2: STATE_KEY is not in the votetorrent.voteProof. namespace')

	for (const name of FORBIDDEN_CALLS) {
		const n = [...s.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].length
		if (n !== 0) out.push(`W3: ${name}( occurs ${n} times, expected 0`)
	}

	for (const lit of [RECORD_LITERAL, MARKER_LITERAL]) {
		if (s.includes(lit)) out.push(`W4: the vote key prefix literal ${lit} is retyped in the probe`)
	}
	const imp = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/src\/engines\/vote-record-store'/.exec(s)
	for (const name of ['VOTE_MARKER_KEY_PREFIX', 'VOTE_RECORD_KEY_PREFIX']) {
		if (!imp || !new RegExp(`\\b${name}\\b`).test(imp[1]!)) out.push(`W4: ${name} is not imported from vote-record-store`)
	}
	return out
}

describe('vote-casting-probe gate (T-63-15-09, 63-15)', () => {
	it('resolves the real probe (path sanity)', () => {
		expect(existsSync(PROBE)).toBe(true)
	})

	const real = existsSync(PROBE) ? readFileSync(PROBE, 'utf8') : ''

	it('the probe has exactly one write, to its own state key, and no other mutation', () => {
		expect(checkProbe(real)).toEqual([])
	})

	it('the probe really does write its state key once (the scan is not vacuous)', () => {
		const s = stripCommentsPreservingLines(real)
		expect(s).toContain('AsyncStorage.setItem(STATE_KEY, JSON.stringify(state))')
		expect(s).toContain('getAllKeys')
	})

	describe('planted self-tests (the checker can fail)', () => {
		const plant = (extra: string): string[] => checkProbe(real + '\n' + extra + '\n')

		it('P1: a second setItem to a vote key builder reports W1 twice over', () => {
			const v = plant('async function x() { await AsyncStorage.setItem(voteRecordKey(\'e\'), \'{}\') }')
			expect(v.some((x) => x.startsWith('W1: setItem( occurs 2'))).toBe(true)
			expect(v.some((x) => x.includes('key argument is "voteRecordKey'))).toBe(true)
		})

		it('P2: the only setItem pointed at a vote prefix constant reports W1', () => {
			const planted = real.replace('AsyncStorage.setItem(STATE_KEY,', 'AsyncStorage.setItem(VOTE_RECORD_KEY_PREFIX,')
			expect(planted).not.toBe(real)
			expect(checkProbe(planted).some((x) => x.includes('expected STATE_KEY'))).toBe(true)
		})

		it.each(FORBIDDEN_CALLS)('P3: a planted %s( call reports W3', (name) => {
			const v = plant(`async function x() { await AsyncStorage.${name}([]) }`)
			expect(v.some((x) => x.startsWith(`W3: ${name}(`))).toBe(true)
		})

		it('P4: a retyped vote record prefix literal reports W4', () => {
			const v = plant(`const K = '${RECORD_LITERAL}.' + 'e'`)
			expect(v.some((x) => x.startsWith('W4: the vote key prefix literal'))).toBe(true)
		})

		it('P5: dropping the prefix import reports W4', () => {
			const planted = real.replace('VOTE_MARKER_KEY_PREFIX, ', '')
			expect(planted).not.toBe(real)
			expect(checkProbe(planted).some((x) => x.startsWith('W4: VOTE_MARKER_KEY_PREFIX is not imported'))).toBe(true)
		})

		it('P6: a state key moved out of the voteProof namespace reports W2', () => {
			const planted = real.replace("'votetorrent.voteProof.' + VOTE_PROOF_RUN_ID", "'x.' + VOTE_PROOF_RUN_ID")
			expect(planted).not.toBe(real)
			expect(checkProbe(planted).some((x) => x.startsWith('W2'))).toBe(true)
		})

		it('P7: a forbidden call only inside a comment is not reported', () => {
			expect(plant('// AsyncStorage.removeItem(k); AsyncStorage.setItem(k, v)')).toEqual([])
		})
	})
})
