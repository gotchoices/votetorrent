/**
 * dev-seed.test.ts — Phase 44-06 integration proof.
 *
 * Runs against the REAL RegistrationEngine + a local in-memory Quereus DB
 * (same pattern as `packages/vote-engine/test/registration.spec.ts`) — the
 * engine layer is pure TS, so this builds the EngineContext directly via
 * `seedDevNetwork`'s own `NetworksEngine`, rather than through the RN
 * CadreNode boot. No on-device dependency.
 *
 * Asserts the five 44-06 behaviors, plus 51-12's D-09/D-20 scope-drop guard:
 *   1. A founding-officer-signed register() persists a real Registrant.
 *   2. register() signed by an UNREGISTERED key is rejected (AdminSigning /
 *      MutationValid / UserIdValid).
 *   3. getElectionRegistrationFields(electionId) is non-empty (Pitfall 5 —
 *      proves the policy is actually loaded before asserting enforcement).
 *   4. A required-tier-violating submission throws FieldPolicyViolationError.
 *   5. A conforming submission succeeds and creates a RegistrantSelective row
 *      for 'party'.
 *   6. (51-12, D-09/D-20) The seeded officer's Scopes is exactly ['mel'] — the
 *      registration-ceremony scope is deliberately withheld from the device's
 *      own voter identity.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Ballot, BallotSignatureTask, RegisterInit, Signature } from '@votetorrent/vote-core'
import { NetworksEngine, RegistrationEngine, AssociationEngine, ElectionsEngine, IntakeEngine, SignatureTasksEngine, LocalStorageReact } from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import { FieldPolicyViolationError } from '@votetorrent/vote-engine'
import { seedDevNetwork, confirmDevBallot, DEV_SEED_NETWORK_NAME, DEV_SEED_BALLOT_QUESTIONS } from '../dev-seed'
import { readVoteContext, readVoterBallot, readVoterElection, toVoterBallot } from '../election-read'
import { resolveAttestationProducer } from '../attestation-producer'
import * as attestationProducerModule from '../attestation-producer'
import { setDeviceKeyWrapProviderForTests } from '../device-key-wrap'
import { createInMemoryKeyWrapProviderForTests } from '../__fixtures__/in-memory-key-wrap-provider'

// D-42 (Phase 62 plan 08): seedDevNetwork -> getOrCreateDeviceUser now needs a DeviceKeyWrapProvider.
// ONE instance for the whole file (not per-test) so a record wrapped in an earlier test stays
// unwrappable by a later one, mirroring a real device's single wrap key per alias.
const wrapProvider = createInMemoryKeyWrapProviderForTests()
beforeAll(() => setDeviceKeyWrapProviderForTests(wrapProvider))
afterAll(() => setDeviceKeyWrapProviderForTests(undefined))

/** Build a signer for an UNREGISTERED identity — not a row in Officer for this authority. */
function makeUnregisteredSigner(): (digest: Uint8Array) => Promise<Signature> {
	const privBytes = secp256k1.utils.randomSecretKey()
	const publicHex = bytesToHex(secp256k1.getPublicKey(privBytes))
	const privHex = bytesToHex(privBytes)
	const unregisteredUserId = 'unregistered-user-not-an-officer'
	return async (digest: Uint8Array): Promise<Signature> => ({
		signerUserId: unregisteredUserId,
		signerKey: publicHex,
		signature: bytesToHex(secp256k1.sign(digest, hexToBytes(privHex))),
	})
}

let registrantSeq = 0
function nextRegistrantId(): string {
	registrantSeq += 1
	return `dev-seed-registrant-${Date.now()}-${registrantSeq}`
}

/**
 * D-49 (Phase 62 Plan 31): a file-local Map-backed `IKeyVault` (62-04's four-method contract) —
 * the Voter resolves `@votetorrent/vote-engine` from `dist` and has no mapped fixture, so this
 * mirrors `packages/vote-engine/src/crypto/vault.ts`'s `InMemoryTestKeyVault` structurally rather
 * than importing it (that class is a deep-path, never-barrel-exported test-only type).
 */
class MapKeyVaultForTests {
	private readonly store = new Map<string, Uint8Array>()
	async putSecret(alias: string, secret: Uint8Array): Promise<void> {
		if (this.store.has(alias)) throw new Error(`MapKeyVaultForTests.putSecret: alias '${alias}' already holds a secret`)
		this.store.set(alias, Uint8Array.from(secret))
	}
	async getSecret(alias: string): Promise<Uint8Array | null> {
		const found = this.store.get(alias)
		return found ? Uint8Array.from(found) : null
	}
	async hasSecret(alias: string): Promise<boolean> {
		return this.store.has(alias)
	}
	async deleteSecret(alias: string): Promise<boolean> {
		return this.store.delete(alias)
	}
}

/**
 * D-49: registers the founding officer's intake encryption key BEFORE the first registration
 * write, so `RegistrationEngine.submitRegistrationRequest`/`register()` (now D-49-sealed) have a
 * recipient. `ctx.intakeOpener` is also set so this file's own reads (`getRegistrant`,
 * `getRegistrantSelective`) can open the sealed tiers they write.
 */
async function ensureIntakeRecipient(
	ctx: EngineContext,
	authorityId: string,
	sign: (digest: Uint8Array) => Promise<Signature>
): Promise<void> {
	const vault = new MapKeyVaultForTests()
	const intakeEngine = new IntakeEngine(ctx)
	await intakeEngine.registerOfficerEncryptionKey(authorityId, vault, sign)
	ctx.intakeOpener = intakeEngine.createOpener(vault)
}

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

async function setup(options?: { registeredStateFixture?: boolean }) {
	const networksEngine = new NetworksEngine(new LocalStorageReact())
	const seeded = await seedDevNetwork(networksEngine, options)
	const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)
	if (!ctx) throw new Error('test setup: no established context after seedDevNetwork')
	const registrationEngine = new RegistrationEngine(ctx)
	const authorityRow = await ctx.db
		.prepare('select AuthorityId from Election where Id = :electionId')
		.get({ electionId: seeded.electionId })
	const authorityId = authorityRow!.AuthorityId as string
	await ensureIntakeRecipient(ctx, authorityId, seeded.sign)
	return { seeded, ctx, registrationEngine, authorityId }
}

describe('dev-seed — D-05/D-07/D-08 founding-officer seed + real signed register', () => {
	// Test isolation: the RN AsyncStorage jest mock is a module-scope singleton
	// store shared across every `it()` in this file (unlike the fresh in-memory
	// Quereus Database each `new NetworksEngine(...)` gets). Without clearing it,
	// a later test's brand-new (schema-less) in-memory NetworksEngine would hit
	// dev-seed's idempotent "existingRef" re-attach branch against a
	// `recentNetworks` entry left over from an EARLIER test's AsyncStorage state
	// — throwing "Network not opened in this session". Mirrors
	// `createTestNetwork()`'s own `AsyncStorage.clear()` in
	// packages/vote-engine/test/fixtures/test-context.ts.
	beforeEach(async () => {
		await AsyncStorage.clear()
	})

	it('is __DEV__-guarded — throws when __DEV__ is false', async () => {
		const original = (globalThis as { __DEV__?: boolean }).__DEV__
		;(globalThis as { __DEV__?: boolean }).__DEV__ = false
		try {
			const networksEngine = new NetworksEngine(new LocalStorageReact())
			await expect(seedDevNetwork(networksEngine)).rejects.toThrow(/__DEV__/)
		} finally {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = original
		}
	})

	it('seeds a network whose device user is the founding officer, and an election', async () => {
		const { seeded, ctx } = await setup()
		expect(seeded.networkReference.name).toBe(DEV_SEED_NETWORK_NAME)
		expect(seeded.electionId).toEqual(expect.any(String))

		const officerRow = await ctx.db
			.prepare('select UserId, Scopes from Officer where UserId = :userId')
			.get({ userId: seeded.deviceUser.id })
		expect(officerRow).toBeTruthy()
		expect(JSON.parse(officerRow!.Scopes as string)).toEqual(['mel'])
	})

	it('does NOT grant the officer the registration-ceremony scope — a regression re-granting it is exactly the D-01 defect this phase closed (D-09/D-20)', async () => {
		const { seeded, ctx } = await setup()

		const officerRow = await ctx.db
			.prepare('select Scopes from Officer where UserId = :userId')
			.get({ userId: seeded.deviceUser.id })
		expect(officerRow).toBeTruthy()
		const scopes = JSON.parse(officerRow!.Scopes as string) as string[]
		// The authority's own registration-ceremony scope ("Validate registrations",
		// votetorrent.qsql:59) is deliberately withheld from the device's own voter
		// identity — granting it is what let the voter app run the authority's
		// admin-signed ceremony (D-01, 51-CONTEXT.md). 'mel' ("Manage Elections")
		// stays per D-20 — this seed's own election + policy-row ceremonies need it,
		// and D-12's ElectionRecordValidityPolicy row is 'mel'-scoped. Deleting this
		// test later would be an obvious removal of a guard.
		expect(scopes).not.toContain('vrg')
		expect(scopes).toContain('mel')
	})

	it('getElectionRegistrationFields(electionId) is non-empty (Pitfall 5 — policy actually loaded)', async () => {
		const { seeded, registrationEngine } = await setup()
		const fields = await registrationEngine.getElectionRegistrationFields(seeded.electionId)
		expect(fields.length).toBeGreaterThan(0)
		const byName = new Map(fields.map((f) => [f.fieldName, f]))
		expect(byName.get('firstname')).toMatchObject({ tier: 'public', requirement: 'required' })
		expect(byName.get('email')).toMatchObject({ tier: 'private', requirement: 'required' })
		expect(byName.get('party')).toMatchObject({ tier: 'selective', requirement: 'optional' })
	})

	it('register() signed by the seeded founding-officer device signer succeeds and persists a real Registrant', async () => {
		const { seeded, registrationEngine, authorityId } = await setup()
		const registrantId = nextRegistrantId()

		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: FUTURE_EXPIRATION },
			public: { firstName: 'Jane' },
			private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'email', value: 'jane@example.com' }] },
		}

		await registrationEngine.register(init, seeded.sign)

		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeDefined()
		expect(registrant!.authorityId).toBe(authorityId)
	})

	it('register() signed by an UNREGISTERED key is rejected (AdminSigning/UserIdValid)', async () => {
		const { seeded, registrationEngine, authorityId } = await setup()
		const registrantId = nextRegistrantId()
		const unregisteredSign = makeUnregisteredSigner()

		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: FUTURE_EXPIRATION },
			public: { firstName: 'Unregistered' },
			private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'email', value: 'unreg@example.com' }] },
		}

		let caught: unknown
		try {
			await registrationEngine.register(init, unregisteredSign)
		} catch (err) {
			caught = err
		}
		expect(caught).toBeDefined()
		// D-49 (62-31): a recipient is provisioned in setup() above, so this rejection must be the
		// ORIGINAL AdminSigning/UserIdValid refusal, never IntakeError('no-recipients') firing first
		// for the wrong reason.
		expect((caught as { name?: string } | undefined)?.name).not.toBe('IntakeError')

		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeUndefined()
	})

	it('a submission violating a required field policy throws FieldPolicyViolationError', async () => {
		const { seeded, registrationEngine, authorityId } = await setup()
		const registrantId = nextRegistrantId()

		// Omits 'firstname' (public, required) and 'email' (private, required) entirely.
		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: FUTURE_EXPIRATION },
			private: { expiration: FUTURE_EXPIRATION, details: [] },
		}

		await expect(registrationEngine.register(init, seeded.sign)).rejects.toThrow(FieldPolicyViolationError)

		// A policy-rejected submission must not persist a Registrant.
		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeUndefined()
	})

	it('a conforming submission succeeds and creates a RegistrantSelective row for party', async () => {
		const { seeded, registrationEngine, authorityId } = await setup()
		const registrantId = nextRegistrantId()

		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: FUTURE_EXPIRATION },
			public: { firstName: 'Conforming' },
			private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'email', value: 'conforming@example.com' }] },
			selective: { expiration: FUTURE_EXPIRATION, details: [{ name: 'party', value: 'IND' }] },
		}

		await registrationEngine.register(init, seeded.sign)

		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeDefined()
		expect(registrant!.selectiveCid).toEqual(expect.any(String))

		const selective = await registrationEngine.getRegistrantSelective(registrantId)
		expect(selective).toBeDefined()
		expect(selective!.selectiveDetails?.some((leaf) => leaf.name === 'party' && leaf.value === 'IND')).toBe(true)
	})

	it('62-51: default seed binds nothing to the stub device key (fresh dev Voter reads not-registered)', async () => {
		const { ctx } = await setup()
		const associationEngine = new AssociationEngine(ctx)
		const { publicKey: deviceKey } = await resolveAttestationProducer().provisionDeviceKey()
		expect(await associationEngine.getAssociationsByDeviceKey(deviceKey)).toEqual([])
	})

	it('D-23(f) opt-in: the registered state is reachable end-to-end from the device key alone (no cached id) — one row, status "a"', async () => {
		const { seeded, ctx } = await setup({ registeredStateFixture: true })
		const associationEngine = new AssociationEngine(ctx)
		const registrationEngine = new RegistrationEngine(ctx)

		const { publicKey: deviceKey } = await resolveAttestationProducer().provisionDeviceKey()
		const rows = await associationEngine.getAssociationsByDeviceKey(deviceKey)
		expect(rows).toHaveLength(1)

		const registrant = await registrationEngine.getRegistrant(rows[0]!.registrantId)
		expect(registrant).toBeDefined()
		expect(registrant!.status).toBe('a')
		expect(new Date(registrant!.expiration as string).getTime()).toBeGreaterThan(Date.now())
		// Sanity: the seeded registrant belongs to THIS seed's own authority/network.
		expect(registrant!.authorityId).toBe(
			(
				await ctx.db
					.prepare('select AuthorityId from Election where Id = :electionId')
					.get({ electionId: seeded.electionId })
			)!.AuthorityId,
		)
	})

	it('D-23(f): an unrelated device key reads not-registered — []', async () => {
		const { ctx } = await setup()
		const associationEngine = new AssociationEngine(ctx)
		const rows = await associationEngine.getAssociationsByDeviceKey('dev-seed-test-unrelated-device-key-never-seeded')
		expect(rows).toEqual([])
	})

	it('dev-seed.ts has no import of @react-native-async-storage/async-storage (import-graph assertion — inspects the resolved require() module graph, not a text/token scan)', () => {
		// Genuine import-GRAPH assertion: after this test file's own top-level `import
		// '../dev-seed'` has resolved it, Jest's CommonJS module registry (`require.cache`)
		// records dev-seed.ts's DIRECT `children` — the modules it itself required. This
		// cannot be falsely tripped by a doc comment merely NAMING the package (unlike a
		// text/token scan): only an actual resolved `require`/`import` edge appears here.
		// This RN app's ambient `NodeRequire` type (from @types/react-native) declares only the
		// callable form (matching the existing `require('...')` value-import pattern elsewhere in
		// this codebase) — `.resolve`/`.cache` are real Jest/CommonJS runtime properties this
		// project's minimal type does not surface, hence the narrow `as any` escape below.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const nodeRequire = require as any
		const devSeedModulePath = nodeRequire.resolve('../dev-seed')
		const devSeedCacheEntry = nodeRequire.cache[devSeedModulePath]
		expect(devSeedCacheEntry).toBeDefined()
		const childIds: string[] = (devSeedCacheEntry?.children ?? []).map((c: { id: string }) => c.id)
		expect(childIds.some((id) => id.includes('@react-native-async-storage/async-storage'))).toBe(false)
	})

	// The voter's REAL read path (election-read.ts) against the REAL seeded engine rows — the
	// end-to-end proof that the Home/Ballot screens no longer need an in-memory mock.
	it('the seeded election and ballot read back through the voter read path', async () => {
		const { seeded, ctx } = await setup()
		const deps = {
			getEngine: async <T,>() => new ElectionsEngine(ctx) as unknown as T,
			fallbackElectionId: seeded.electionId,
		}

		const election = await readVoterElection(deps, Date.now())
		expect(election).toMatchObject({ id: seeded.electionId, title: 'Dev Voter Registration Election', lifecycleState: 'Upcoming' })
		expect(election.countdownTarget).toEqual(expect.any(String))

		const proposedRead = await readVoterBallot(deps, { includeProposed: true })
		const releaseRead = await readVoterBallot(deps, { includeProposed: false })
		// B7: the seed now confirms its ballot, so the release read offers it too.
		expect(releaseRead.offices).toEqual(proposedRead.offices)
		expect(releaseRead.offices).toHaveLength(5)
		expect(releaseRead.unsupportedQuestionCount).toBe(0)
		expect(proposedRead.unsupportedQuestionCount).toBe(0)

		const tuples = releaseRead.offices.map(o => [o.group, o.title, o.voteFor])
		const expected = [
			['Federal', 'U.S. Senate', 1],
			['Federal', 'U.S. House of Representatives, District 2', 1],
			['State (UT)', 'Governor', 1],
			['State (UT)', 'State Board of Education', 2],
			['State (UT)', 'State Senate, District 8', 1],
		]
		// No office may be lost, whatever the order.
		expect([...tuples].sort()).toEqual([...expected].sort())
		// ORDER PIN: a confirmed ballot's questions read in Question PK (BallotId, Code) order, not
		// proposal order — todo 2026-10-05-confirmed-ballot-read-orders-questions-by-code. This pin
		// flips to the `expected` order when that todo is fixed.
		expect(tuples).toEqual([
			['State (UT)', 'Governor', 1],
			['State (UT)', 'State Board of Education', 2],
			['State (UT)', 'State Senate, District 8', 1],
			['Federal', 'U.S. Senate', 1],
			['Federal', 'U.S. House of Representatives, District 2', 1],
		])
		const senate = releaseRead.offices.find(o => o.title === 'U.S. Senate')!
		expect(senate.candidates[0]).toMatchObject({ name: 'Diana Foster', party: 'Democratic Party' })
	})

	it('readVoteContext over the seeded dev election: confirmed ballot, real revision, window from the timeline (D-01/D-03/D-04/D-05)', async () => {
		const { seeded, ctx, authorityId } = await setup()
		const deps = {
			getEngine: async <T,>() => new ElectionsEngine(ctx) as unknown as T,
			fallbackElectionId: seeded.electionId,
		}
		const details = await (await new ElectionsEngine(ctx).openElection(seeded.electionId)).getElectionDetails()

		const live = await readVoteContext(deps, Date.now())
		expect(live.electionId).toBe(seeded.electionId)
		expect(live.authorityId).toBe(authorityId)
		expect(live.revision).toBe(details.current.revision)
		expect(typeof live.revision).toBe('number')
		expect(live.open).toBe(false)
		expect(live.lifecycleState).toBe('Upcoming')

		const openAt = details.current.timeline.votingStarts + 60_000
		const openCtx = await readVoteContext(deps, openAt)
		expect(openCtx.open).toBe(true)
		expect(openCtx.lifecycleState).toBe('Open')
		expect(openCtx.ballots).toHaveLength(1)
		expect(openCtx.unconfirmedBallotIds).toEqual([])
		expect(openCtx.unsupportedQuestionCount).toBe(0)

		// Sorted sets, never sequences: a confirmed read comes back in Code order (63-04 finding).
		const byCode = new Map(openCtx.ballots[0]!.questions.map((q) => [q.code, q]))
		expect([...byCode.keys()].sort()).toEqual(DEV_SEED_BALLOT_QUESTIONS.map((q) => q.code).sort())

		const offices = toVoterBallot(openCtx.electionId, openCtx.ballots).offices
		expect(Object.fromEntries(offices.map((o) => [o.questionCode, o.required]))).toEqual({
			'us-senate': true,
			'us-house': false,
			governor: true,
			'state-board-education': true,
			'state-senate': false,
		})
		for (const o of offices) {
			expect(o.hasDependsOn).toBe(false)
			expect(o.ballotId).toBe(openCtx.ballots[0]!.id)
			const codes = byCode.get(o.questionCode)!.options.map((x) => x.code)
			for (const c of o.candidates) expect(codes).toContain(c.optionCode)
		}
	})

	it('readVoteContext survives a re-attach seed: still one confirmed ballot and the same revision', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const first = await seedDevNetwork(networksEngine)
		const ctx = networksEngine.getEstablishedContext(first.networkReference.hash)!
		const deps = {
			getEngine: async <T,>() => new ElectionsEngine(ctx) as unknown as T,
			fallbackElectionId: first.electionId,
		}
		const details = await (await new ElectionsEngine(ctx).openElection(first.electionId)).getElectionDetails()
		const openAt = details.current.timeline.votingStarts + 60_000
		const before = await readVoteContext(deps, openAt)

		await seedDevNetwork(networksEngine)
		const after = await readVoteContext(deps, openAt)
		expect(after.ballots).toHaveLength(1)
		expect(after.unconfirmedBallotIds).toEqual([])
		expect(after.revision).toBe(before.revision)
	})

	it('D-03: a fresh seed leaves every ballot confirmed; D-04: two questions read back required:false', async () => {
		const { seeded, ctx } = await setup()
		const electionEngine = await new ElectionsEngine(ctx).openElection(seeded.electionId)
		const ballots = await electionEngine.getBallots()
		expect(ballots).toHaveLength(1)
		for (const b of ballots) {
			// gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
			expect(await electionEngine.getBallotConfirmationState(b.id)).toEqual({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
		}
		const details = await electionEngine.getBallotDetails(ballots[0]!.id)
		const required = Object.fromEntries(details.ballot.questions.map((q) => [q.code, q.required]))
		expect(required).toEqual({
			'us-senate': true,
			'us-house': false,
			governor: true,
			'state-board-education': true,
			'state-senate': false,
		})
	})

	it('D-03: re-attach seed is idempotent — still confirmed, no duplicate Ballot/ProposedBallot/Task/AdminSigning rows', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const first = await seedDevNetwork(networksEngine)
		const ctx = networksEngine.getEstablishedContext(first.networkReference.hash)!
		const count = async (sql: string, p: Record<string, string> = {}) =>
			Number((await ctx.db.prepare(sql).get(p))!.n)
		const e = { e: first.electionId }
		const signingBefore = await count('select count(*) as n from AdminSigning')

		const second = await seedDevNetwork(networksEngine)
		expect(second.electionId).toBe(first.electionId)

		const electionEngine = await new ElectionsEngine(ctx).openElection(second.electionId)
		const [only] = await electionEngine.getBallots()
		// gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
		expect(await electionEngine.getBallotConfirmationState(only!.id)).toEqual({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
		expect(await count('select count(*) as n from Ballot where ElectionId = :e', e)).toBe(1)
		expect(await count('select count(*) as n from ProposedBallot where ElectionId = :e', e)).toBe(1)
		expect(await count("select count(*) as n from Task where SignatureType = 'ballot'")).toBe(1)
		expect(await count('select count(*) as n from AdminSigning')).toBe(signingBefore)
	})

	function extraBallot(seeded: { electionId: string }, authorityId: string): Ballot {
		return {
			id: (globalThis as any).crypto.randomUUID(),
			electionId: seeded.electionId,
			authorityId,
			description: 'extra proposed-only ballot',
			districts: [],
			questions: [
				{
					code: 'x-q',
					title: 'X question',
					instructions: '',
					type: 'select',
					optionRange: { min: 1, max: 1 },
					group: 'X',
					sequence: 0,
					required: true,
					options: [
						{ code: 'x-a', title: 'A', details: '' },
						{ code: 'x-b', title: 'B', details: '' },
					],
				},
			],
		}
	}

	it('D-03: a legacy proposed-only ballot is confirmed on the next seedDevNetwork boot', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const first = await seedDevNetwork(networksEngine)
		const ctx = networksEngine.getEstablishedContext(first.networkReference.hash)!
		const authorityId = (await ctx.db.prepare('select AuthorityId from Election where Id = :e').get({ e: first.electionId }))!.AuthorityId as string
		const electionEngine = await new ElectionsEngine(ctx).openElection(first.electionId)
		const extra = extraBallot(first, authorityId)
		await electionEngine.proposeBallot(extra)
		expect((await electionEngine.getBallotConfirmationState(extra.id)).confirmed).toBe(false)

		await seedDevNetwork(networksEngine)
		// gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
		expect(await electionEngine.getBallotConfirmationState(extra.id)).toEqual({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
	})

	it('D-03: confirmDevBallot confirms a proposed ballot, is idempotent, and resumes a submitted-but-unconfirmed one', async () => {
		const { seeded, ctx, authorityId } = await setup()
		const electionEngine = await new ElectionsEngine(ctx).openElection(seeded.electionId)

		const proposedOnly = extraBallot(seeded, authorityId)
		await electionEngine.proposeBallot(proposedOnly)
		await confirmDevBallot(ctx, seeded.networkReference, seeded.electionId, proposedOnly.id, seeded.sign)
		// gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
		expect(await electionEngine.getBallotConfirmationState(proposedOnly.id)).toEqual({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
		await expect(
			confirmDevBallot(ctx, seeded.networkReference, seeded.electionId, proposedOnly.id, seeded.sign),
		).resolves.toBeUndefined()
		const taskCount = async () =>
			Number((await ctx.db.prepare("select count(*) as n from Task where SignatureType = 'ballot'").get({}))!.n)
		expect(await taskCount()).toBe(2) // dev ballot + this one

		const resumed = extraBallot(seeded, authorityId)
		await electionEngine.proposeBallot(resumed)
		await electionEngine.submitBallotForConfirmation(resumed.id)
		// gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
		expect(await electionEngine.getBallotConfirmationState(resumed.id)).toEqual({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: true })
		await confirmDevBallot(ctx, seeded.networkReference, seeded.electionId, resumed.id, seeded.sign)
		// gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
		expect(await electionEngine.getBallotConfirmationState(resumed.id)).toEqual({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
		expect(await taskCount()).toBe(3)
	})

	describe('63-18: the registered-state fixture binds the CURRENT key and creates one at most once', () => {
		afterEach(() => {
			jest.restoreAllMocks()
		})

		function stubProducer(producer: { getCurrentDeviceKey: () => Promise<{ publicKey: string }>, provisionDeviceKey: jest.Mock }) {
			jest.spyOn(attestationProducerModule, 'resolveAttestationProducer').mockReturnValue(producer as never)
		}

		it('an existing key is bound as-is and provisionDeviceKey is NEVER called', async () => {
			const provisionDeviceKey = jest.fn(async () => ({ publicKey: 'ROTATED-NEW-KEY' }))
			stubProducer({ getCurrentDeviceKey: async () => ({ publicKey: 'CURRENT-KEY' }), provisionDeviceKey })
			const { ctx } = await setup({ registeredStateFixture: true })
			const associations = new AssociationEngine(ctx)
			expect(await associations.getAssociationsByDeviceKey('CURRENT-KEY')).toHaveLength(1)
			expect(await associations.getAssociationsByDeviceKey('ROTATED-NEW-KEY')).toEqual([])
			expect(provisionDeviceKey).not.toHaveBeenCalled()
		})

		it('an absent key (fresh install) is created exactly once and that key is bound', async () => {
			const provisionDeviceKey = jest.fn(async () => ({ publicKey: 'CREATED-KEY' }))
			const getCurrentDeviceKey = jest.fn(async () => {
				throw Object.assign(new Error('absent'), { code: 'DEVICE_KEY_ABSENT' })
			})
			stubProducer({ getCurrentDeviceKey, provisionDeviceKey })
			const { ctx } = await setup({ registeredStateFixture: true })
			expect(await new AssociationEngine(ctx).getAssociationsByDeviceKey('CREATED-KEY')).toHaveLength(1)
			expect(provisionDeviceKey).toHaveBeenCalledTimes(1)
		})

		it('any other lookup failure (e.g. DEVICE_KEY_INVALIDATED) is NOT papered over by creating a key', async () => {
			const provisionDeviceKey = jest.fn(async () => ({ publicKey: 'SHOULD-NOT-EXIST' }))
			stubProducer({
				getCurrentDeviceKey: async () => {
					throw Object.assign(new Error('invalid'), { code: 'DEVICE_KEY_INVALIDATED' })
				},
				provisionDeviceKey,
			})
			await expect(setup({ registeredStateFixture: true })).rejects.toThrow()
			expect(provisionDeviceKey).not.toHaveBeenCalled()
		})
	})

	it('62-51: default re-attach run also binds nothing to the stub device key', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		await seedDevNetwork(networksEngine)
		const second = await seedDevNetwork(networksEngine)
		const ctx = networksEngine.getEstablishedContext(second.networkReference.hash)!
		const { publicKey: deviceKey } = await resolveAttestationProducer().provisionDeviceKey()
		expect(await new AssociationEngine(ctx).getAssociationsByDeviceKey(deviceKey)).toEqual([])
	})

	it('is idempotent — re-running seedDevNetwork re-attaches the same network and election without duplicating policy rows', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const first = await seedDevNetwork(networksEngine, { registeredStateFixture: true })
		const second = await seedDevNetwork(networksEngine, { registeredStateFixture: true })

		expect(second.networkReference.hash).toBe(first.networkReference.hash)
		expect(second.electionId).toBe(first.electionId)

		const ctx = networksEngine.getEstablishedContext(second.networkReference.hash)!
		const registrationEngine = new RegistrationEngine(ctx)
		const fields = await registrationEngine.getElectionRegistrationFields(second.electionId)
		// Exactly the 3 seeded rows (firstname/email/party) — not 6, proving the
		// second call did not re-insert (which would violate the PK anyway).
		expect(fields.length).toBe(3)

		// D-23(f): the registered-state fixture is also idempotent across re-attach —
		// exactly one Association row for the seeded device key, not two.
		const associationEngine = new AssociationEngine(ctx)
		const { publicKey: deviceKey } = await resolveAttestationProducer().provisionDeviceKey()
		const rows = await associationEngine.getAssociationsByDeviceKey(deviceKey)
		expect(rows).toHaveLength(1)

		// Exactly one ballot — the re-attach must not propose a second one.
		const electionEngine = await new ElectionsEngine(ctx).openElection(second.electionId)
		expect(await electionEngine.getBallots()).toHaveLength(1)
	})
})

describe('A7 — a mel-only founding officer confirms a threshold-1 ballot', () => {
	beforeEach(async () => {
		await AsyncStorage.clear()
	})

	it("A7: the seeded founding officer (scopes ['mel'] only) confirms a threshold-1 ballot through submitBallotForConfirmation + completeSignature", async () => {
		const { seeded, ctx, authorityId } = await setup()
		const electionEngine = await new ElectionsEngine(ctx).openElection(seeded.electionId)

		const probeId: string = (globalThis as any).crypto.randomUUID()
		const probe: Ballot = {
			id: probeId,
			electionId: seeded.electionId,
			authorityId,
			description: 'A7 probe ballot',
			districts: [],
			questions: [
				{
					code: 'a7-q',
					title: 'A7 question',
					instructions: '',
					type: 'select',
					optionRange: { min: 1, max: 1 },
					group: 'A7',
					sequence: 0,
					required: true,
					options: [
						{ code: 'a7-x', title: 'X', details: '' },
						{ code: 'a7-y', title: 'Y', details: '' },
					],
				},
			],
		}
		await electionEngine.proposeBallot(probe)
		await electionEngine.submitBallotForConfirmation(probeId)

		const tasks = new SignatureTasksEngine(seeded.networkReference, ctx)
		const task = (await tasks.getRequestedSignatures(true)).find(
			(t) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === probeId,
		)
		expect(task).toBeDefined()

		const digest = await tasks.getSignatureDigest(task!)
		await tasks.completeSignature(task!, { isAccepted: true, signature: await seeded.sign(digest), sign: seeded.sign })

		// gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
		expect(await electionEngine.getBallotConfirmationState(probeId)).toEqual({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
		expect(await ctx.db.prepare('select Id from Ballot where Id = :id').get({ id: probeId })).toBeTruthy()
		expect((await electionEngine.getBallotDetails(probeId)).ballot.questions).toHaveLength(1)

		const officerRow = await ctx.db
			.prepare('select Scopes from Officer where UserId = :userId')
			.get({ userId: seeded.deviceUser.id })
		expect(JSON.parse(officerRow!.Scopes as string)).toEqual(['mel'])
	})
})
