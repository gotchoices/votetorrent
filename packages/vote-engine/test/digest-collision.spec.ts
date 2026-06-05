import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'

/**
 * VoteTorrent repro — `Digest(...)` argument-boundary ambiguity (delimiter
 * injection) produces colliding content hashes for distinct argument tuples.
 *
 * Source: packages/vote-engine/src/database/initialize.ts
 *
 *   const parts = args.map(a => a == null ? '' : String(a));
 *   const concat = parts.join('|');
 *   return createHash('sha256').update(concat).digest('base64url');
 *
 * Reported as: "Digest(a, b, c) concatenates arg bytes with no separator or
 * length prefix, so Digest('ab','c') == Digest('a','bc')".
 *
 * That exact claim is INACCURATE for the current code — a `|` separator IS
 * present, so `Digest('ab','c')` ("ab|c") and `Digest('a','bc')` ("a|bc")
 * are DISTINCT (see C1, the control case). However the underlying security
 * concern is REAL: a bare, unescaped delimiter join is not injection-safe.
 * Distinct argument tuples still collide whenever:
 *   B1  an argument value itself contains the `|` delimiter, or
 *   B2  a null argument is indistinguishable from an empty string, or
 *   B3  adjacent arguments can be repartitioned across the delimiter.
 *
 * `Digest()` produces the content hash that AdminSigning.Digest signs
 * ("Content hash to be signed", schema line ~211). A collision means a
 * signature produced over payload X is also valid for a different payload Y
 * — a signature-substitution / forgery surface. This is a correctness +
 * security bug, not a cosmetic one.
 *
 * The B* sub-tests below PASS today by asserting the observed (broken)
 * collisions. When the digest encoding is fixed (length-prefix / escape /
 * structured framing), invert B1–B3 to assert the digests are DISTINCT.
 * C1–C2 are controls that should keep passing either way.
 */
describe('VoteTorrent repro — Digest() delimiter-injection collisions', () => {
	let db: Database

	before(async () => {
		db = new Database()
		await prepareDb(db)
	})

	/** Invoke the registered SQL scalar `Digest(...)` with the given args. */
	async function digest(...args: Array<string | null>): Promise<string> {
		const names = args.map((_, i) => `:a${i}`)
		const params: Record<string, string | null> = {}
		args.forEach((v, i) => { params[`a${i}`] = v })
		const row = await db
			.prepare(`select Digest(${names.join(', ')}) as d`)
			.get(params)
		return String((row as { d: string }).d)
	}

	// ---------------------------------------------------------------
	// Confirmed-broken cases — pass today by asserting the observed
	// collision. Invert to `.not.equal` once the encoding is fixed.
	// ---------------------------------------------------------------

	it('B1 — BROKEN: a value containing `|` lets args be repartitioned', async () => {
		// "a|b" + "|" + "c"  ==  "a" + "|" + "b|c"  ==  "a|b|c"
		const left = await digest('a|b', 'c')
		const right = await digest('a', 'b|c')
		expect(left, 'delimiter-injection should NOT collide once fixed').to.equal(right)
	})

	it('B2 — BROKEN: null and empty-string arguments are indistinguishable', async () => {
		// null -> ""  so  ["", "x"]  ==  ["", "x"]
		const withNull = await digest(null, 'x')
		const withEmpty = await digest('', 'x')
		expect(withNull, 'null vs empty-string should be distinguishable once fixed').to.equal(withEmpty)
	})

	it('B3 — BROKEN: arity is not encoded; 3 args collide with a joined 2-arg call', async () => {
		// ["a","b","c"] -> "a|b|c"  ==  ["a|b","c"] -> "a|b|c"
		const threeArgs = await digest('a', 'b', 'c')
		const twoArgs = await digest('a|b', 'c')
		expect(threeArgs, 'argument arity/boundaries should be encoded once fixed').to.equal(twoArgs)
	})

	// ---------------------------------------------------------------
	// Controls — should hold regardless of the fix.
	// ---------------------------------------------------------------

	it('C1 — CONTROL: the literally-reported example does NOT collide (separator present)', async () => {
		// "ab|c" vs "a|bc" — refutes the "no separator" framing of the report.
		const a = await digest('ab', 'c')
		const b = await digest('a', 'bc')
		expect(a).to.not.equal(b)
	})

	it('C2 — CONTROL: identical argument tuples are deterministic', async () => {
		const a = await digest('alpha', 'beta')
		const b = await digest('alpha', 'beta')
		expect(a).to.equal(b)
	})
})
