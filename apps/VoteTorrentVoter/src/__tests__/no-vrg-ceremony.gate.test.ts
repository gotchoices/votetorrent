/**
 * no-vrg-ceremony.gate.test.ts — D-09's two enforcement halves against a reintroduced voter-side
 * admin-signed registration/association ceremony (51-12).
 *
 * D-09 is explicit that a gate alone is not enough (it can be dismissed as lint noise) and a
 * structural failure alone is not enough (it surfaces as an opaque schema CHECK error with no
 * named rule pointing back at the source). This file provides BOTH:
 *
 *   1. SOURCE GATE — walks every `.ts`/`.tsx` file under `apps/VoteTorrentVoter/src` that ships in
 *      the app bundle, strips comments, and asserts zero real-code occurrences of `register(`,
 *      `associate(`, `seedSignedMutation`, `issueAttestationChallenge`. Comment-stripping is
 *      MANDATORY: this codebase's own doc comments (dev-seed.ts, ConfirmationScreen.tsx,
 *      device-signer.ts, attestation-failure.ts) already mention these tokens in prose describing
 *      the D-01 defect this phase closed — an unstripped scanner would cry wolf on its own
 *      documentation. `stripComments` below reuses the same two-step (block-then-line) regex
 *      approach as `packages/vote-engine/test/browser-entry-purity.spec.ts`'s `stripComments`
 *      (that file's header records both false-positive modes were OBSERVED with an unstripped
 *      scanner), adjusted to preserve line numbers (blanking block-comment characters instead of
 *      deleting them) so a real match's reported line number is accurate.
 *
 *      TWO exclusions, both principled, neither a silent narrowing of coverage:
 *        (a) this gate file itself (`no-vrg-ceremony.gate.test.ts`) — it necessarily names the
 *            tokens it forbids.
 *        (b) any `*.test.ts`/`*.test.tsx` file — test files are not part of the shipped app
 *            bundle, and this codebase's OWN test infrastructure legitimately calls `register()`
 *            directly against the engine to prove BOTH its success path (a real founding officer)
 *            AND its rejection path (an unregistered signer) — `dev-seed.test.ts` does exactly
 *            this, as does this gate file's own STRUCTURAL half below. Forbidding `register(` in
 *            test files would make the gate permanently red against tests the plan itself
 *            requires (Task 1's must_haves), which is exactly the "gate that cries wolf and gets
 *            disabled" failure mode this phase is trying to avoid. The MUTATION PROOF below
 *            demonstrates this exclusion is bounded to the `.test.ts(x)` suffix specifically — a
 *            plain `.ts` file sitting inside a directory NAMED `__tests__` is still caught.
 *
 *   2. MUTATION PROOF — the identical scan function run over synthetic fixture directories (never
 *      real source files) proves the gate can tell code from prose: a real call fails it, the same
 *      text inside a comment does not. A gate that has never been seen to fail is not a gate.
 *
 *   3. BEHAVIORAL HALF (D-02 ceremony-free intake) — seeding a dev network and then driving
 *      `RegistrationEngine.submitRegistrationRequest` (the ceremony-free intake method a REST
 *      submission from `ConfirmationScreen.tsx` ultimately reaches, per 51-11) creates ZERO
 *      `AdminSigning` rows. Mirrors `registration-request.spec.ts`'s `countAdminSigning` pattern.
 *      Scope note: this covers the REGISTRATION-request leg only. The association-request leg's
 *      P-256 device-key ceremony-free intake is already proven by
 *      `packages/vote-engine/test/association-request.spec.ts` (outside this file's scope, whose
 *      `<files>` list is limited to `apps/VoteTorrentVoter/src`) — duplicating that proof from the
 *      app layer would need the same P-256 device-key plumbing `AttestationProducer` only has a
 *      stub implementation of today (see 51-11-SUMMARY.md's Known Gap).
 *
 *   4. STRUCTURAL HALF (D-09) — calling `register()` with a signer that is genuinely NOT an
 *      Officer of the authority fails at `AdminSigning.UserIdValid`, with that identifier quoted
 *      in the assertion. Honesty note (recorded at length in `dev-seed.ts`'s grant-site comment):
 *      `AdminSigning.UserIdValid` (votetorrent.qsql) only checks that the signer is SOME Officer
 *      of the authority — it does not consult `Officer.Scopes` at all, and no engine-side check
 *      does either (`registration-engine.ts`'s own `rejectRegistrationRequest` doc comment says so
 *      verbatim). So dropping 'vrg' from the dev-seed's OWN founding-officer grant does not, by
 *      itself, make THAT identity's `register()` calls fail here — the identity remains an Officer
 *      regardless of which Scopes it carries. What genuinely fails at `UserIdValid` — and is what
 *      actually stops a real end-user request — is a voter identity that was never inserted into
 *      `Officer` at all, which is what every real (non-dev-seed) voter is. This test proves that.
 *
 *   5. SCHEMA GATE (D-05/D-06) — `votetorrent.qsql`, comment-stripped, carries no `'association'`
 *      member in `view SignatureType` and no `'association'` pairing in `Task.ExtensionExists`.
 *      `48-CONTEXT.md` names `Task.ExtensionExists` the highest-risk schema change across phases
 *      46-48; this gate is what keeps it unamended.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegisterInit, RegistrationRequestInit, Signature } from '@votetorrent/vote-core'
import { NetworksEngine, RegistrationEngine, IntakeEngine, LocalStorageReact } from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { seedDevNetwork } from '../engines/dev-seed'
import { setDeviceKeyWrapProviderForTests } from '../engines/device-key-wrap'
import { createInMemoryKeyWrapProviderForTests } from '../engines/__fixtures__/in-memory-key-wrap-provider'

// D-42 (Phase 62 plan 08): seedDevNetwork -> getOrCreateDeviceUser now needs a DeviceKeyWrapProvider.
const wrapProvider = createInMemoryKeyWrapProviderForTests()
beforeAll(() => setDeviceKeyWrapProviderForTests(wrapProvider))
afterAll(() => setDeviceKeyWrapProviderForTests(undefined))

// ---------------------------------------------------------------------------
// Comment stripping (mechanism analog: packages/vote-engine/test/browser-entry-purity.spec.ts)
// ---------------------------------------------------------------------------

/**
 * Same two-step (block comments, then line comments) approach as
 * `browser-entry-purity.spec.ts`'s `stripComments`, adjusted to PRESERVE line numbers: block
 * comment content is blanked out (non-newline characters replaced with spaces) rather than
 * deleted outright, so a real match after a multi-line block-comment header still reports its
 * true line number. Line comments are still deleted to end-of-line (no newline inside a
 * line comment to preserve).
 */
function stripCommentsPreservingLines (src: string): string {
	const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
	return noBlockComments.replace(/\/\/.*$/gm, '')
}

const FORBIDDEN_TOKENS = ['register(', 'associate(', 'seedSignedMutation', 'issueAttestationChallenge'] as const
type ForbiddenToken = (typeof FORBIDDEN_TOKENS)[number]

interface ForbiddenMatch {
	file: string
	line: number
	token: ForbiddenToken
	text: string
}

/** Walk every `.ts`/`.tsx` file under `root`, excluding any absolute path in `excludeAbsPaths`. */
/** Test files are not part of the shipped app bundle — see the module doc comment's exclusion
 * (b) above for why they are exempt from this specific gate. */
const TEST_FILE_PATTERN = /\.test\.(ts|tsx)$/

function walkSourceFiles (root: string, excludeAbsPaths: ReadonlySet<string>): string[] {
	const out: string[] = []
	const stack: string[] = [root]
	while (stack.length > 0) {
		const dir = stack.pop() as string
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry)
			const st = statSync(full)
			if (st.isDirectory()) {
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

/**
 * Scan every non-test source file under `root` (comment-stripped) for the forbidden tokens. The
 * ONLY permitted exclusions are this gate file's own absolute path (passed via
 * `excludeAbsPaths`) and any `*.test.ts(x)` file (see module doc comment) — no path is ever
 * excluded merely for living inside a directory named `__tests__`/`__mocks__`; only the file's
 * own name matters. An exclusion by directory name is exactly how a gate quietly stops covering
 * the file that matters (T-51-12-05).
 */
function scanForForbiddenTokens (root: string, excludeAbsPaths: ReadonlySet<string>): ForbiddenMatch[] {
	const matches: ForbiddenMatch[] = []
	for (const file of walkSourceFiles(root, excludeAbsPaths)) {
		const raw = readFileSync(file, 'utf8')
		const stripped = stripCommentsPreservingLines(raw)
		const lines = stripped.split('\n')
		lines.forEach((lineText, idx) => {
			for (const token of FORBIDDEN_TOKENS) {
				if (lineText.includes(token)) {
					matches.push({ file, line: idx + 1, token, text: lineText.trim() })
				}
			}
		})
	}
	return matches
}

function formatMatches (matches: ForbiddenMatch[]): string {
	return matches.map((m) => `${m.file}:${m.line} [${m.token}] ${m.text}`).join('\n')
}

/** Per-token counts (never a bare aggregate — a single `== 0` on unfiltered text is
 * self-invalidating the moment a comment explains the rule). */
function countsByToken (matches: ForbiddenMatch[]): Record<ForbiddenToken, number> {
	const counts = Object.fromEntries(FORBIDDEN_TOKENS.map((t) => [t, 0])) as Record<ForbiddenToken, number>
	for (const m of matches) counts[m.token] += 1
	return counts
}

// ---------------------------------------------------------------------------
// 1. SOURCE GATE — the real target
// ---------------------------------------------------------------------------

const VOTER_SRC_DIR = join(__dirname, '..')
const THIS_FILE = join(__dirname, 'no-vrg-ceremony.gate.test.ts')

/**
 * Exact matches that are NOT the ceremony, each with its reason. An entry names one file (relative to
 * `src`), one token and the exact comment-stripped, trimmed line text, so any edit to that line, or the
 * same token anywhere else, is caught again. The test below also fails when an entry matches nothing
 * (a stale exemption is removed, not carried).
 */
const NOT_THE_CEREMONY: ReadonlyArray<{ file: string; token: ForbiddenToken; text: string; why: string }> = [
	{
		file: 'engines/pool-matchmaking-ports.ts',
		token: 'register(',
		text: 'await session.register(poolMatchTopic(topicLabel), reg);',
		why: "Optimystic's MatchmakingProviderSession.register: lists a vote pool's coordinator on a matchmaking topic, signed by the libp2p peer key. Not RegistrationEngine.register; no Registrant or AdminSigning row is written.",
	},
]

const isNotTheCeremony = (m: ForbiddenMatch): boolean =>
	NOT_THE_CEREMONY.some((e) => m.file === join(VOTER_SRC_DIR, e.file) && m.token === e.token && m.text === e.text)

describe('no-vrg-ceremony source gate (D-09) — apps/VoteTorrentVoter/src', () => {
	it('has zero real-code occurrences of register(/associate(/seedSignedMutation/issueAttestationChallenge, per-token counted, file:line reported', () => {
		const all = scanForForbiddenTokens(VOTER_SRC_DIR, new Set([THIS_FILE]))
		for (const e of NOT_THE_CEREMONY) {
			expect({ exemption: e.file, hits: all.filter((m) => m.file === join(VOTER_SRC_DIR, e.file) && m.token === e.token && m.text === e.text).length }).toEqual({ exemption: e.file, hits: 1 })
		}
		const matches = all.filter((m) => !isNotTheCeremony(m))
		const counts = countsByToken(matches)
		expect({ counts, detail: formatMatches(matches) }).toEqual({
			counts: { 'register(': 0, 'associate(': 0, seedSignedMutation: 0, issueAttestationChallenge: 0 },
			detail: '',
		})
	})
})

// ---------------------------------------------------------------------------
// 2. MUTATION PROOF — the identical scan function over synthetic fixtures
// ---------------------------------------------------------------------------

describe('no-vrg-ceremony source gate — mutation proof (the gate can tell code from prose)', () => {
	let fixtureDir: string

	beforeEach(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), 'no-vrg-gate-mutation-'))
	})

	afterEach(() => {
		rmSync(fixtureDir, { recursive: true, force: true })
	})

	it('FAILS (reports a match, with file and line) when a forbidden token appears in real code', () => {
		const file = join(fixtureDir, 'reintroduced.ts')
		writeFileSync(
			file,
			[
				'export async function reintroducedCeremony(engine: { register: (a: unknown, b: unknown) => Promise<void> }) {',
				'  // a plain call — this line IS the violation',
				'  await engine.register(1, 2)',
				'}',
			].join('\n'),
		)

		const matches = scanForForbiddenTokens(fixtureDir, new Set())

		expect(matches.length).toBeGreaterThan(0)
		const hit = matches.find((m) => m.token === 'register(')
		expect(hit).toBeDefined()
		expect(hit?.file).toBe(file)
		expect(hit?.line).toBe(3)
	})

	it('PASSES (reports zero matches) when the same token appears only inside a comment', () => {
		const file = join(fixtureDir, 'comment-only.ts')
		writeFileSync(
			file,
			[
				'/**',
				' * This module deliberately never calls register( or associate( or',
				' * seedSignedMutation or issueAttestationChallenge — see D-01.',
				' */',
				'export const NOTE = "no forbidden call sites here";',
				'// register( mentioned again, purely in a line comment',
			].join('\n'),
		)

		const matches = scanForForbiddenTokens(fixtureDir, new Set())

		expect(matches).toEqual([])
	})

	it('the __tests__ DIRECTORY name grants no exemption by itself — only a *.test.ts(x) filename does (T-51-12-05)', () => {
		// A forbidden token in a plain (non-`.test.ts`) `.ts` file living inside a directory NAMED
		// `__tests__` must still be caught — proving the exemption keys off the FILE's own name
		// (the `.test.ts(x)` suffix, or this gate file's literal path), never the containing
		// directory's name. An exclusion-by-directory would be exactly the silent coverage
		// narrowing T-51-12-05 warns against.
		const testsDir = join(fixtureDir, '__tests__')
		mkdirSync(testsDir)
		const nonTestHelper = join(testsDir, 'helper.ts')
		writeFileSync(nonTestHelper, 'await something.associate(1, 2) // lives in __tests__/ but is NOT a *.test.ts file — must be caught')

		const matches = scanForForbiddenTokens(fixtureDir, new Set())

		expect(matches).toHaveLength(1)
		expect(matches[0]?.file).toBe(nonTestHelper)
		expect(matches[0]?.token).toBe('associate(')
	})

	it('a genuine *.test.ts file is exempt by filename, even outside a __tests__ directory (bounded, principled exclusion)', () => {
		const genuineTest = join(fixtureDir, 'engine-behavior.test.ts')
		writeFileSync(genuineTest, 'await registrationEngine.register(init, signer) // legitimate engine-level test, mirrors dev-seed.test.ts')

		const matches = scanForForbiddenTokens(fixtureDir, new Set())

		expect(matches).toEqual([])
	})

	it('excludes the gate file itself by literal path, even though its own name would otherwise match the test-file exemption anyway', () => {
		const gateLookalike = join(fixtureDir, 'no-vrg-ceremony.gate.test.ts')
		writeFileSync(gateLookalike, 'export const x = 1; // register( — this file names the forbidden tokens by design')

		const matches = scanForForbiddenTokens(fixtureDir, new Set([gateLookalike]))

		expect(matches).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// 3 & 4. BEHAVIORAL HALF (zero AdminSigning rows) + STRUCTURAL HALF (UserIdValid)
// ---------------------------------------------------------------------------

/** Build a keypair + signer for an identity that is NOT a row in Officer for any authority —
 * mirrors dev-seed.test.ts's makeUnregisteredSigner() exactly (same pattern, independently
 * constructed here so this gate file does not depend on another test file's internals). Returns
 * BOTH the public key and the signer (not just the signer) because submitRegistrationRequest's
 * own pre-flight/SignatureValid checks require the SAME key that produced the signature to be
 * passed as the explicit `requesterKey` argument — a mismatched, independently-generated key
 * fails CHECK constraint SignatureValid, not the behavior this test means to prove. */
function makeNonOfficerKeypairSigner (): { publicHex: string, sign: (digest: Uint8Array) => Promise<Signature> } {
	const privBytes = secp256k1.utils.randomSecretKey()
	const publicHex = bytesToHex(secp256k1.getPublicKey(privBytes))
	const privHex = bytesToHex(privBytes)
	const sign = async (digest: Uint8Array): Promise<Signature> => ({
		signerUserId: 'gate-test-non-officer-voter',
		signerKey: publicHex,
		signature: bytesToHex(secp256k1.sign(digest, hexToBytes(privHex))),
	})
	return { publicHex, sign }
}

/**
 * D-49 (Phase 62 Plan 31): a file-local Map-backed `IKeyVault` (62-04's four-method contract),
 * mirroring `dev-seed.test.ts`'s own helper of the same shape — this file resolves
 * `@votetorrent/vote-engine` from `dist` and has no mapped fixture.
 */
class MapKeyVaultForTests {
	private readonly store = new Map<string, Uint8Array>()
	async putSecret (alias: string, secret: Uint8Array): Promise<void> {
		if (this.store.has(alias)) throw new Error(`MapKeyVaultForTests.putSecret: alias '${alias}' already holds a secret`)
		this.store.set(alias, Uint8Array.from(secret))
	}
	async getSecret (alias: string): Promise<Uint8Array | null> {
		const found = this.store.get(alias)
		return found ? Uint8Array.from(found) : null
	}
	async hasSecret (alias: string): Promise<boolean> {
		return this.store.has(alias)
	}
	async deleteSecret (alias: string): Promise<boolean> {
		return this.store.delete(alias)
	}
}

/** D-49: registers the founding officer's intake encryption key BEFORE the first registration
 * write, so the now-D-49-sealed `submitRegistrationRequest`/`register()` have a recipient. */
async function ensureIntakeRecipient (
	ctx: EngineContext,
	authorityId: string,
	sign: (digest: Uint8Array) => Promise<Signature>
): Promise<void> {
	const vault = new MapKeyVaultForTests()
	await new IntakeEngine(ctx).registerOfficerEncryptionKey(authorityId, vault, sign)
}

describe('D-09 behavioral + structural halves', () => {
	beforeEach(async () => {
		// Mirrors dev-seed.test.ts's own isolation convention — the RN AsyncStorage jest mock is a
		// module-scope singleton shared across every it() in this file.
		await AsyncStorage.clear()
	})

	it('BEHAVIORAL: submitRegistrationRequest (the ceremony-free intake a voter REST submission reaches) creates ZERO AdminSigning rows', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const seeded = await seedDevNetwork(networksEngine)
		const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)
		if (!ctx) throw new Error('gate test setup: no established context after seedDevNetwork')

		const authorityRow = await ctx.db
			.prepare('select AuthorityId from Election where Id = :electionId')
			.get({ electionId: seeded.electionId })
		const authorityId = authorityRow!.AuthorityId as string
		await ensureIntakeRecipient(ctx, authorityId, seeded.sign)

		const countAdminSigning = async (): Promise<number> => {
			const row = await ctx.db.prepare('select count(*) as n from AdminSigning').get({})
			return Number(row?.n ?? 0)
		}

		const registrationEngine = new RegistrationEngine(ctx)
		const { publicHex: requesterPublicHex, sign: requesterSigner } = makeNonOfficerKeypairSigner()

		const payload: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: crypto.randomUUID(), authorityId, expiration: Date.now() + 365 * 86_400_000 },
			public: { firstName: 'Gate' },
			private: { expiration: Date.now() + 365 * 86_400_000, details: [{ name: 'email', value: 'gate@example.com' }] },
		}
		const requestInit: RegistrationRequestInit = {
			id: crypto.randomUUID(),
			authorityId,
			payload,
			submittedAt: new Date().toISOString(),
		}

		const before = await countAdminSigning()
		const returnedId = await registrationEngine.submitRegistrationRequest(requestInit, requesterPublicHex, requesterSigner)
		const after = await countAdminSigning()

		expect(returnedId).toBe(requestInit.id)
		expect(after).toBe(before)
	})

	it('STRUCTURAL: register() signed by a genuinely non-officer identity FAILS at an AdminSigning signer CHECK (UserIdValid or SignerKeyValid), quoting the identifier', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const seeded = await seedDevNetwork(networksEngine)
		const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)
		if (!ctx) throw new Error('gate test setup: no established context after seedDevNetwork')

		const authorityRow = await ctx.db
			.prepare('select AuthorityId from Election where Id = :electionId')
			.get({ electionId: seeded.electionId })
		const authorityId = authorityRow!.AuthorityId as string
		await ensureIntakeRecipient(ctx, authorityId, seeded.sign)

		const registrationEngine = new RegistrationEngine(ctx)
		const { sign: nonOfficerSign } = makeNonOfficerKeypairSigner()
		const registrantId = crypto.randomUUID()

		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: Date.now() + 365 * 86_400_000 },
			public: { firstName: 'NonOfficer' },
			private: { expiration: Date.now() + 365 * 86_400_000, details: [{ name: 'email', value: 'nonofficer@example.com' }] },
		}

		// D-09: the failure must name the specific CHECK identifier, not merely "it threw".
		let caught: unknown
		try {
			await registrationEngine.register(init, nonOfficerSign)
		} catch (err) {
			caught = err
		}
		// The non-officer is refused by AdminSigning's signer CHECKs: it is not an Officer
		// (UserIdValid) and its key is not a registered UserKey (SignerKeyValid, engine-computed
		// since the hardcoded `IsSignerKeyValid = true` stub was replaced). Either names the
		// structural reason; which one Quereus reports first is evaluation order, not intent.
		expect((caught as Error | undefined)?.message).toMatch(/UserIdValid|SignerKeyValid/)
		// D-49 (62-31): a recipient is provisioned above, so this must be the ORIGINAL signer
		// refusal, never IntakeError('no-recipients') firing first for the wrong reason.
		expect((caught as { name?: string } | undefined)?.name).not.toBe('IntakeError')

		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// 5. SCHEMA GATE (D-05/D-06)
// ---------------------------------------------------------------------------

function stripSqlLineComments (src: string): string {
	return src.replace(/--.*$/gm, '')
}

describe('no-association schema gate (D-05/D-06) — packages/vote-core/schema/votetorrent.qsql', () => {
	// `@votetorrent/vote-core`'s package.json `exports` map only exposes the `.` subpath (no
	// `./package.json`), and its `main` points at a `dist/` build that does not exist in every
	// worktree (51-11-SUMMARY.md's Issues Encountered) — so `require.resolve` cannot locate this
	// file at runtime. Walk up from this gate file's own on-disk location instead: this file lives
	// at apps/VoteTorrentVoter/src/__tests__/, four levels below the repo root.
	const schemaPath = join(__dirname, '..', '..', '..', '..', 'packages', 'vote-core', 'schema', 'votetorrent.qsql')

	if (!existsSync(schemaPath)) {
		throw new Error(`no-vrg-ceremony schema gate: schema file not found at resolved path ${schemaPath}`)
	}

	const strippedSchema = stripSqlLineComments(readFileSync(schemaPath, 'utf8'))

	it('view SignatureType carries no \'association\' member', () => {
		const viewMatch = strippedSchema.match(/view\s+SignatureType\s+as[\s\S]*?;/)
		if (!viewMatch) throw new Error('view SignatureType not found — schema gate regex is stale, fix the gate')
		const body = viewMatch[0]
		expect(body).not.toContain("'association'")
	})

	it('Task.ExtensionExists carries no \'association\' pairing', () => {
		const extMatch = strippedSchema.match(/constraint\s+ExtensionExists\s+check\s*\(([\s\S]*?)\n\t\tconstraint\s+MutationValid/)
		if (!extMatch) throw new Error('Task.ExtensionExists not found — schema gate regex is stale, fix the gate')
		const body = extMatch[1]
		expect(body).not.toContain("'association'")
	})

	// MUTATION PROOF, schema half: this file's `<files_modified>` is limited to
	// `apps/VoteTorrentVoter/src`, and `packages/vote-core/` is out of bounds for this plan (the
	// concurrent 51-10 plan works in the authority app; the schema is shared, off-limits either
	// way) — so the mutation is applied to a SYNTHETIC string mirroring the real shape, never to
	// the real schema file on disk. This still proves the same extraction regex + assertion would
	// catch a reintroduced 'association' member/pairing, without any risk of leaving a real schema
	// file mutated (or colliding with a concurrent session editing it).
	it('MUTATION PROOF: the same view-body extraction catches a synthetic reintroduced \'association\' member', () => {
		const syntheticSchema = stripSqlLineComments(
			[
				'\tview SignatureType as',
				"\t\tselect 'admin' as Code",
				"\t\tunion all select 'registrant' as Code",
				"\t\tunion all select 'association' as Code; -- reintroduced, must be caught",
				'',
				'\ttable Unrelated (',
				'\t\tId text primary key',
				'\t);',
			].join('\n'),
		)
		const viewMatch = syntheticSchema.match(/view\s+SignatureType\s+as[\s\S]*?;/)
		if (!viewMatch) throw new Error('mutation-proof fixture malformed — view SignatureType not found in synthetic schema')
		expect(viewMatch[0]).toContain("'association'")
	})

	it('MUTATION PROOF: the same ExtensionExists-body extraction catches a synthetic reintroduced \'association\' pairing', () => {
		const syntheticSchema = stripSqlLineComments(
			[
				'\ttable Task (',
				'\t\tconstraint ExtensionExists check (',
				"\t\t\t(Type = 'signature' and (",
				"\t\t\t\t(SignatureType = 'registrant' and exists (select 1 from X where X.TaskId = new.Id))",
				"\t\t\t\t\tor (SignatureType = 'association' and exists (select 1 from Y where Y.TaskId = new.Id)) -- reintroduced",
				'\t\t\t))',
				'\t\t),',
				'\t\tconstraint MutationValid check on insert, update (context.IsMutationValid = true)',
				'\t)',
			].join('\n'),
		)
		const extMatch = syntheticSchema.match(/constraint\s+ExtensionExists\s+check\s*\(([\s\S]*?)\n\t\tconstraint\s+MutationValid/)
		if (!extMatch) throw new Error('mutation-proof fixture malformed — ExtensionExists not found in synthetic schema')
		expect(extMatch[1]).toContain("'association'")
	})
})
