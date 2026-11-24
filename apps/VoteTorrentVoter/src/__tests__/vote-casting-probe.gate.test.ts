/**
 * vote-casting-probe.gate.test.ts - T-63-15-09 (Phase 63 plan 15): the on-device proof probe must
 * not become a second writer of vote state. Scanned on comment-stripped source:
 *   W1  exactly one `setItem(` call, and its key argument is the probe's own STATE_KEY constant.
 *   W2  STATE_KEY is built from the probe's own `votetorrent.voteProof.` namespace.
 *   W3  no removeItem / multiSet / multiRemove / mergeItem / multiMerge / clear call.
 *   W4  the vote key prefixes are imported from vote-record-store, never retyped as literals.
 * Phase 67 plan 22 moved castVote to `packages/workflows/src/voter/vote-casting.ts`; the invariant
 * "vote state is written only by castVote through the store" now spans the shared file and the app
 * binding, so two more rules read those:
 *   W5  the shared castVote has exactly one `writeVoteRecord(` call, through the injected store
 *       (`recordStore.`), no storage call, no other mutation and no vote key prefix literal.
 *   W6  the app binding wires the app store's writer (imports `writeVoteRecord` from
 *       './vote-record-store') and makes no storage call itself.
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
const SHARED_CASTING = join(__dirname, '..', '..', '..', '..', 'packages', 'workflows', 'src', 'voter', 'vote-casting.ts')
const BINDING = join(__dirname, '..', 'engines', 'vote-casting.ts')

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

/** W5, pure: readable violation strings over the shared castVote source, empty when it satisfies the rule. */
function checkSharedCastVote(raw: string): string[] {
	const out: string[] = []
	const s = stripCommentsPreservingLines(raw)
	const writes = [...s.matchAll(/([A-Za-z_$.]*)\bwriteVoteRecord\s*\(/g)]
	if (writes.length !== 1) out.push(`W5: writeVoteRecord( occurs ${writes.length} times in the shared castVote, expected exactly 1`)
	for (const m of writes) {
		if (!m[1]!.endsWith('recordStore.')) out.push(`W5: writeVoteRecord( is not called through recordStore. (prefix "${m[1]}")`)
	}
	const sets = [...s.matchAll(/\bsetItem\s*\(/g)].length
	if (sets !== 0) out.push(`W5: setItem( occurs ${sets} times in the shared castVote, expected 0`)
	for (const name of FORBIDDEN_CALLS) {
		const n = [...s.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].length
		if (n !== 0) out.push(`W5: ${name}( occurs ${n} times in the shared castVote, expected 0`)
	}
	for (const lit of [RECORD_LITERAL, MARKER_LITERAL]) {
		if (s.includes(lit)) out.push(`W5: the vote key prefix literal ${lit} is retyped in the shared castVote`)
	}
	return out
}

/** W6, pure: the app binding imports the app store's writer and makes no storage call. */
function checkBinding(raw: string): string[] {
	const out: string[] = []
	const s = stripCommentsPreservingLines(raw)
	const imp = /import\s*\{([^}]*)\}\s*from\s*'\.\/vote-record-store'/.exec(s)
	if (!imp || !/\bwriteVoteRecord\b/.test(imp[1]!)) out.push("W6: the binding does not import writeVoteRecord from './vote-record-store'")
	const sets = [...s.matchAll(/\bsetItem\s*\(/g)].length
	if (sets !== 0) out.push(`W6: setItem( occurs ${sets} times in the binding, expected 0`)
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

	describe('single writer across the shared castVote and its binding (phase 67 plan 22)', () => {
		const shared = existsSync(SHARED_CASTING) ? readFileSync(SHARED_CASTING, 'utf8') : ''
		const binding = existsSync(BINDING) ? readFileSync(BINDING, 'utf8') : ''

		it('W5 the shared castVote is the only write path and writes only through the injected store', () => {
			expect(existsSync(SHARED_CASTING)).toBe(true)
			expect(checkSharedCastVote(shared)).toEqual([])
			expect(stripCommentsPreservingLines(shared)).toContain('seams.recordStore.writeVoteRecord(envelope, marker)')
		})

		it('W6 the binding wires the app store\'s writer', () => {
			expect(existsSync(BINDING)).toBe(true)
			expect(checkBinding(binding)).toEqual([])
		})

		it('P8 a second recordStore.writeVoteRecord( in the shared castVote reports W5', () => {
			const v = checkSharedCastVote(shared + '\nasync function again () { await seams.recordStore.writeVoteRecord(envelope, marker) }\n')
			expect(v.some((x) => x.startsWith('W5: writeVoteRecord( occurs 2'))).toBe(true)
		})

		it('P9 a planted storage setItem( in the shared castVote reports W5', () => {
			const v = checkSharedCastVote(shared + "\nasync function leak () { await kv.setItem('k', 'v') }\n")
			expect(v.some((x) => x.startsWith('W5: setItem( occurs 1'))).toBe(true)
		})

		it('P10 a binding importing writeVoteRecord from another module reports W6', () => {
			const planted = binding.replace("from './vote-record-store'", "from './other-store'")
			expect(planted).not.toBe(binding)
			expect(checkBinding(planted).some((x) => x.startsWith('W6: the binding does not import'))).toBe(true)
		})
	})
})
