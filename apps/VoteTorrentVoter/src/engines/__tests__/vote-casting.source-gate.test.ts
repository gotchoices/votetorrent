/**
 * vote-casting.source-gate.test.ts - pins the never-signs and lazy-producer rules for eligibility
 * (D-06, D-07, D-08 layering) over comment-stripped vote-casting.ts.
 *
 * The separate D-08 producer-token gate over the whole vote-casting module arrives with `castVote`.
 * Function slices make this gate survive `castVote` being appended later, so that plan must not
 * edit this one except to follow a rename. Every banned literal is assembled by concatenation so
 * this file cannot trip its own scan.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

function stripCommentsPreservingLines (src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
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

interface Hit { token: string, line: number }

function scan (text: string, tokens: readonly string[]): Hit[] {
	const hits: Hit[] = []
	text.split('\n').forEach((l, idx) => {
		for (const token of tokens) if (l.includes(token)) hits.push({ token, line: idx + 1 })
	})
	return hits
}

function countsByToken (hits: Hit[], tokens: readonly string[]): Record<string, number> {
	return Object.fromEntries(tokens.map(t => [t, hits.filter(h => h.token === t).length]))
}

const SIGN_TOKENS = [
	'signDeviceKey' + 'Digest',
	'.pro' + 'duce(',
	'sealVote' + 'Record',
	'writeVote' + 'Record',
	'console' + '.',
	'Date' + '.now(',
] as const

const BANNED_TOKENS = [
	'getOrCreate' + 'DeviceUser',
	'resolveAttestation' + 'Producer',
	'Stub' + 'AttestationProducer',
	'STUB_' + 'DEVICE_',
	'Async' + 'Storage',
	'@react-native-async-' + 'storage',
	'lifecycle' + 'Override',
	'include' + 'Proposed',
	'readVoter' + 'Ballot',
] as const

const GATED_FUNCTIONS = ['evaluateVoteEligibility', 'resolveVotingRegistrant', 'findUnvotableReason', 'resolveVoteSelections'] as const

const SOURCE = stripCommentsPreservingLines(readFileSync(join(__dirname, '..', 'vote-casting.ts'), 'utf8'))

describe('vote-casting eligibility source gate', () => {
	it.each(GATED_FUNCTIONS)('SG1 %s never signs, seals, writes, logs or reads the wall clock', (name) => {
		const counts = countsByToken(scan(sliceFunction(SOURCE, name), SIGN_TOKENS), SIGN_TOKENS)
		expect(counts).toEqual(Object.fromEntries(SIGN_TOKENS.map(t => [t, 0])))
	})

	it('SG2 resolveVotingRegistrant carries the whole D-06 / D-07 read chain', () => {
		const slice = sliceFunction(SOURCE, 'resolveVotingRegistrant')
		for (const needle of ['getCurrentDeviceKey(', 'getAssociationsByDeviceKey(', 'getRegistrant(', "status === 'a'", 'checkVotingKey(']) {
			expect(slice).toContain(needle)
		}
		// 63-18: the lookup is read-only. A creating call here rotates the Android key.
		expect(slice).not.toContain('.provisionDeviceKey(')
	})

	it('SG2 evaluateVoteEligibility resolves the producer lazily, after the selection gate', () => {
		const slice = sliceFunction(SOURCE, 'evaluateVoteEligibility')
		const producerAt = slice.indexOf('resolveVoteSigningProducer(')
		expect(producerAt).toBeGreaterThan(-1)
		expect(producerAt).toBeGreaterThan(slice.indexOf('resolveVoteSelections('))
	})

	it('SG3 the whole file never names the stub, the dev cycler, the secp256k1 device user or storage', () => {
		const counts = countsByToken(scan(SOURCE, BANNED_TOKENS), BANNED_TOKENS)
		expect(counts).toEqual(Object.fromEntries(BANNED_TOKENS.map(t => [t, 0])))
	})

	it('SG4 the gated slices are non-trivial (the gate is not vacuous)', () => {
		for (const name of GATED_FUNCTIONS) expect(sliceFunction(SOURCE, name).split('\n').length).toBeGreaterThan(5)
	})

	describe('planted self-checks', () => {
		const planted = ['export async function planted (x: number) {', '\tconst a = 1', '\tawait producer.' + 'signDeviceKey' + 'Digest(d)', '}'].join('\n')

		it('P1 a planted signing call is reported at its line', () => {
			const hits = scan(sliceFunction(planted, 'planted'), SIGN_TOKENS)
			expect(hits).toEqual([{ token: 'signDeviceKey' + 'Digest', line: 3 }])
		})

		it('P1 the same text inside a block comment reports nothing', () => {
			const commented = ['/*', ' * await producer.' + 'signDeviceKey' + 'Digest(d)', ' */', 'function quiet () {', '}'].join('\n')
			expect(scan(sliceFunction(stripCommentsPreservingLines(commented), 'quiet'), SIGN_TOKENS)).toEqual([])
		})

		it('P2 sliceFunction throws when the name is absent', () => {
			expect(() => sliceFunction(planted, 'missing')).toThrow(/not found/)
		})
	})
})
