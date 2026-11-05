/**
 * registrant-dev-seed.sealing.test.ts — Phase 62 Plan 31 (D-49).
 *
 * `registrant-dev-seed.test.ts` deliberately never constructs a real Quereus DB (its own header
 * comment) — `RegistrationEngine`/`AssociationEngine`/`IntakeEngine` are all `jest.mock`'d there so
 * its completion-marker regression tests can run with a hand-built fake `ctx.db`. That makes it the
 * wrong home for a D-49 proof, which needs the REAL schema. This file runs against the real schema
 * instead (mirrors `officer-intake-key.test.ts`'s own "I1/I2 run against the REAL schema" split),
 * with NO `jest.mock('@votetorrent/vote-engine/rn', ...)` anywhere — so this file's own module
 * registry never sees a mocked RegistrationEngine/IntakeEngine/AssociationEngine, independent of
 * the sibling file's file-scoped mock (each jest test FILE gets its own module registry).
 *
 * Proves: `seedRegistrantFixtures` provisions an intake recipient and seals every registrant's
 * private tier — the raw `RegistrantPrivate.PrivateDetails` column holds NONE of
 * `seedPrivateLiterals()`'s 36 synthetic SSN/DOB/phone strings, and the values are recoverable only
 * through `getRegistrantPrivate` with an opener built from the SAME (injected, Map-backed) vault.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { IntakeEngine, RegistrationEngine } from '@votetorrent/vote-engine/rn'
import type { Signature, User } from '@votetorrent/vote-core'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any
// Resolved via jest's moduleNameMapper to the TS source — the same deep-require pattern
// `officer-intake-key.test.ts` already uses for this otherwise-unresolvable deep import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTestNetwork, addTestAuthority, addTestElection, makeTestSignCallback } = require('@votetorrent/vote-engine/test/fixtures/test-context') as {
	createTestNetwork: (overrides?: unknown) => Promise<{
		networksEngine: unknown
		ctx: { db: AnyDb; user: User }
		user: User
		ref: { hash: string; name: string; relays: string[]; primaryAuthorityDomainName: string }
	}>
	addTestAuthority: (net: unknown) => Promise<{ authority: { id: string }; ctx: { db: AnyDb; user: User }; user: User }>
	addTestElection: (auth: unknown) => Promise<unknown>
	makeTestSignCallback: (user: User) => (digest: Uint8Array) => Promise<Signature>
}
import { seedPrivateLiterals, seedRegistrantFixtures } from '../registrant-dev-seed'

/** A Map-backed `IKeyVault` (62-04's four-method contract) — mirrors `dev-seed.test.ts`'s own
 * Voter-side helper of the same shape; this app's test maps `@votetorrent/vote-engine/rn` to
 * `dist`, so the deep-path `InMemoryTestKeyVault` is not reachable from here either. */
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

beforeEach(async () => {
	await AsyncStorage.clear()
})

describe('registrant-dev-seed.ts — D-49 sealing (real schema)', () => {
	it('seeds 12 registrants whose raw RegistrantPrivate.PrivateDetails column never contains a seedPrivateLiterals() value, readable only through the injected vault', async () => {
		const original = (globalThis as { __DEV__?: boolean }).__DEV__
		;(globalThis as { __DEV__?: boolean }).__DEV__ = true
		try {
			const net = await createTestNetwork()
			const auth = await addTestAuthority(net)
			await addTestElection(auth)

			const vault = new MapKeyVaultForTests()
			const sign = makeTestSignCallback(net.user)
			const result = await seedRegistrantFixtures(
				net.networksEngine as Parameters<typeof seedRegistrantFixtures>[0],
				net.ref,
				net.user,
				sign,
				{ intakeVault: vault },
			)
			expect(result.seeded).toBe(true)
			expect(result.registrantIds).toHaveLength(12)

			const literals = seedPrivateLiterals()
			expect(literals.length).toBe(36)

			// Raw column scan: none of the 36 literals may appear in any stored PrivateDetails text.
			for (const registrantId of result.registrantIds) {
				const row = await net.ctx.db
					.prepare('select PrivateDetails from RegistrantPrivate where RegistrantId = :id')
					.get({ id: registrantId })
				expect(row).toBeTruthy()
				const stored = String(row!.PrivateDetails)
				for (const literal of literals) {
					expect(stored.includes(literal)).toBe(false)
				}
			}

			// D-52: the raw RegistrantSelective.SelectiveDetails column holds none of the seeded selective
			// literals and no salt key either.
			for (const registrantId of result.registrantIds) {
				const row = await net.ctx.db
					.prepare('select SelectiveDetails from RegistrantSelective where RegistrantId = :id')
					.get({ id: registrantId })
				expect(row).toBeTruthy()
				const stored = String(row!.SelectiveDetails)
				for (const literal of ['Independent', 'Unaffiliated', 'BirthYear', '"salt"']) {
					expect(stored.includes(literal)).toBe(false)
				}
			}

			// Opened through the SAME vault: the real values ARE recoverable.
			const intakeEngine = new IntakeEngine({ ...net.ctx })
			const opener = intakeEngine.createOpener(vault)
			const readCtx = { db: net.ctx.db, user: net.user, intakeOpener: opener }
			const registrationEngine = new RegistrationEngine(readCtx)
			let foundAtLeastOneLiteral = false
			for (const registrantId of result.registrantIds) {
				const read = await registrationEngine.getRegistrantPrivate(registrantId)
				expect(read).toBeTruthy()
				expect(read!.detailsAccess).toBe('opened')
				const values = (read!.privateDetails ?? []).map((d) => String(d.value))
				if (values.some((v) => literals.includes(v))) foundAtLeastOneLiteral = true
			}
			expect(foundAtLeastOneLiteral).toBe(true)
		} finally {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = original
		}
	})
})
