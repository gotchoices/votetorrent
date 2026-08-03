/**
 * dev-seed.test.ts — Phase 44-06 integration proof.
 *
 * Runs against the REAL RegistrationEngine + a local in-memory Quereus DB
 * (same pattern as `packages/vote-engine/test/registration.spec.ts`) — the
 * engine layer is pure TS, so this builds the EngineContext directly via
 * `seedDevNetwork`'s own `NetworksEngine`, rather than through the RN
 * CadreNode boot. No on-device dependency.
 *
 * Asserts the five behaviors this plan's `must_haves` require:
 *   1. A founding-officer-signed register() persists a real Registrant.
 *   2. register() signed by an UNREGISTERED key is rejected (AdminSigning /
 *      MutationValid / UserIdValid).
 *   3. getElectionRegistrationFields(electionId) is non-empty (Pitfall 5 —
 *      proves the policy is actually loaded before asserting enforcement).
 *   4. A required-tier-violating submission throws FieldPolicyViolationError.
 *   5. A conforming submission succeeds and creates a RegistrantSelective row
 *      for 'party'.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegisterInit, Signature } from '@votetorrent/vote-core'
import { NetworksEngine, RegistrationEngine, LocalStorageReact } from '@votetorrent/vote-engine/rn'
import { FieldPolicyViolationError } from '@votetorrent/vote-engine'
import { seedDevNetwork, DEV_SEED_NETWORK_NAME } from '../dev-seed'

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

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

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

	async function setup() {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const seeded = await seedDevNetwork(networksEngine)
		const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)
		if (!ctx) throw new Error('test setup: no established context after seedDevNetwork')
		const registrationEngine = new RegistrationEngine(ctx)
		const authorityRow = await ctx.db
			.prepare('select AuthorityId from Election where Id = :electionId')
			.get({ electionId: seeded.electionId })
		const authorityId = authorityRow!.AuthorityId as string
		return { seeded, ctx, registrationEngine, authorityId }
	}

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
		expect(JSON.parse(officerRow!.Scopes as string)).toContain('vrg')
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

		await expect(registrationEngine.register(init, unregisteredSign)).rejects.toThrow()

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

	it('is idempotent — re-running seedDevNetwork re-attaches the same network and election without duplicating policy rows', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const first = await seedDevNetwork(networksEngine)
		const second = await seedDevNetwork(networksEngine)

		expect(second.networkReference.hash).toBe(first.networkReference.hash)
		expect(second.electionId).toBe(first.electionId)

		const ctx = networksEngine.getEstablishedContext(second.networkReference.hash)!
		const registrationEngine = new RegistrationEngine(ctx)
		const fields = await registrationEngine.getElectionRegistrationFields(second.electionId)
		// Exactly the 3 seeded rows (firstname/email/party) — not 6, proving the
		// second call did not re-insert (which would violate the PK anyway).
		expect(fields.length).toBe(3)
	})
})
