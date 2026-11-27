/**
 * continuity.real-engine.test.ts — Phase 62 Plan 35 Task 1 (V-5, D-45, D-49).
 *
 * `continuity.test.ts` stubs `getRegistrationCodeHolderKey`, which is exactly what hid V-5: after
 * D-49 sealing the REAL method resolved nothing for any new registrant, so the Voter could never
 * show its registration code. This file runs real engines over a real in-memory network and never
 * replaces the holder-key method (a spy only observes the real call).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
	encodeRegistrationCodeBits,
	normalizeRegistrationCode,
	REGISTRATION_CODE_DOMAIN,
} from '@votetorrent/vote-core'
import type { NetworkInit, RegisterInit, RegistrationRequestInit, Scope } from '@votetorrent/vote-core'
import { ElectionType } from '@votetorrent/vote-core'
import {
	AssociationEngine,
	IntakeEngine,
	LocalStorageReact,
	NetworksEngine,
	RegistrationEngine,
	SignatureTasksEngine,
} from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import { setDeviceKeyWrapProviderForTests } from '../device-key-wrap'
import { createInMemoryKeyWrapProviderForTests } from '../__fixtures__/in-memory-key-wrap-provider'
import { createDeviceSigner } from '../device-signer'
import { getOrCreateDeviceUser } from '../device-user'
import { resolveRegistrationCodeAvailability } from '../continuity'
import type { VoterRequestTransports } from '../../screens/registration/attach-voter-request-transport'

const wrapProvider = createInMemoryKeyWrapProviderForTests()

beforeEach(async () => {
	await AsyncStorage.clear()
	setDeviceKeyWrapProviderForTests(wrapProvider)
})
afterEach(() => {
	setDeviceKeyWrapProviderForTests(undefined)
})

/** Map-backed IKeyVault (same shape as dev-seed.test.ts's file-local one). */
class MapKeyVaultForTests {
	private readonly store = new Map<string, Uint8Array>()
	async putSecret(alias: string, secret: Uint8Array): Promise<void> {
		if (this.store.has(alias)) throw new Error(`alias '${alias}' already holds a secret`)
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

describe('resolveRegistrationCodeAvailability against the real engines (V-5)', () => {
	test('a D-49-sealed, approved registration (request id = registrant id) resolves available with the real holder-key read', async () => {
		const deviceUser = await getOrCreateDeviceUser('Device User')
		const identityKey = deviceUser.activeKeys[0]!.key
		const sign = await createDeviceSigner('Device User')

		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const networkInit: NetworkInit = {
			name: 'Continuity Real Engine Network',
			relays: [],
			primaryAuthority: { name: 'Continuity Authority', domainName: 'continuity.votetorrent.local' },
			admin: {
				officers: [{ init: { name: deviceUser.name, title: 'Registrar', scopes: ['vrg'] as Scope[] } }],
				effectiveAt: Date.now(),
				thresholdPolicies: [],
			},
			policies: { timestampAuthorities: [], numberRequiredTSAs: 0, electionType: ElectionType.adhoc },
		}
		await networksEngine.create(networkInit, deviceUser)
		const ref = (await networksEngine.getRecentNetworks()).find((r) => r.name === networkInit.name)!
		const ctx = networksEngine.getEstablishedContext(ref.hash) as EngineContext
		const networkEngine = await networksEngine.open(ref, deviceUser)
		const authorityId = (await networkEngine.getDetails()).network.primaryAuthorityId

		const vault = new MapKeyVaultForTests()
		const intakeEngine = new IntakeEngine(ctx)
		await intakeEngine.registerOfficerEncryptionKey(authorityId, vault, sign)
		ctx.intakeOpener = intakeEngine.createOpener(vault)

		// The Voter's own registration shape: the request id IS the registrant id.
		const registrantId = (globalThis as { crypto: { randomUUID(): string } }).crypto.randomUUID()
		const farFuture = new Date(Date.now() + 365 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '.000Z')
		const payload: RegisterInit = {
			registrant: { id: registrantId, authorityId, expiration: farFuture as never },
			public: { firstName: 'Real', lastName: 'Engine' },
			private: { expiration: farFuture as never, details: [] },
		}
		const init: RegistrationRequestInit = {
			id: registrantId,
			authorityId,
			payload,
			submittedAt: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z') as never,
		}
		const registrationEngine = new RegistrationEngine(ctx)
		await registrationEngine.submitRegistrationRequest(init, identityKey, sign)

		const tasksEngine = new SignatureTasksEngine(
			{ hash: ref.hash, name: ref.name, relays: [], primaryAuthorityDomainName: 'continuity.votetorrent.local' } as never,
			ctx,
		)
		const tasks = await tasksEngine.getRequestedSignatures(true)
		const task = tasks.find(
			(t) => t.signatureType === 'registrant' && (t as { requestId?: string }).requestId === registrantId,
		)
		expect(task).toBeDefined()
		const digest = await tasksEngine.getSignatureDigest(task!)
		await tasksEngine.completeSignature(task!, {
			isAccepted: true,
			signature: await sign(digest),
			sign,
			decision: { checklist: ['id'] },
		} as never)

		const stored = await ctx.db.prepare('select Payload, Status from RegistrationRequest where Id = :id').get({ id: registrantId })
		expect(stored!.Status).toBe('a')
		expect(String(stored!.Payload)).not.toContain('"lastName"') // sealed at rest (D-49)

		// REAL engines. Only the attestation-bound read is overridden (out of scope here).
		const realAssociation = new AssociationEngine(ctx)
		const holderKeySpy = jest.spyOn(realAssociation, 'getRegistrationCodeHolderKey')
		const association = Object.create(realAssociation) as AssociationEngine
		association.getAssociationsByDeviceKey = (async () => [{ registrantId, deviceKey: 'p256-device-key' }]) as never

		const engines: Record<string, unknown> = { network: networkEngine, association, registration: registrationEngine }
		const result = await resolveRegistrationCodeAvailability({
			getEngine: (async (name: string) => {
				if (name in engines) return engines[name]
				throw new Error(`unexpected engine ${name}`)
			}) as never,
			getCurrentDeviceKey: async () => ({ publicKey: 'p256-device-key' }),
			resolveTransports: async () =>
				({
					registrationTransport: {},
					associationTransport: {},
					registrationRoute: 'peer',
					ownAssociationRequestIds: async () => [],
					ownStagedRegistrationRequestIds: async () => [registrantId],
				}) as unknown as VoterRequestTransports,
		})

		// The real method ran, and resolved this device's identity key from cleartext columns.
		expect(holderKeySpy).toHaveBeenCalledWith(registrantId)
		await expect(holderKeySpy.mock.results[0]!.value).resolves.toBe(identityKey)

		// Independent re-derivation of the D-45 code from the device signer.
		const codeDigest = sha256(utf8ToBytes(`${REGISTRATION_CODE_DOMAIN}\n${registrantId}`))
		const sig = (await sign(codeDigest)).signature
		const expected = encodeRegistrationCodeBits(
			sha256(concatBytes(utf8ToBytes(`${REGISTRATION_CODE_DOMAIN}/code`), hexToBytes(sig))),
		)
		expect(result).toEqual({ kind: 'available', code: normalizeRegistrationCode(expected) })
	})
})
