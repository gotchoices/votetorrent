/**
 * continuity.dev-seed.test.ts — UAT 62 test 14 composed regression.
 *
 * Real seedDevNetwork + the __DEV__ StubAttestationProducer + the REAL
 * resolveRegistrationCodeAvailability (no resolver or engine stubs). Before the registered-state
 * fixture became opt-in, a default dev boot bound the stub device key to an active registrant with
 * no RegistrationRequest, so the resolver returned a silent 'unavailable' and the Registration tab
 * rendered nothing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
	AssociationEngine,
	LocalStorageReact,
	NetworksEngine,
	RegistrationEngine,
} from '@votetorrent/vote-engine/rn'
import {seedDevNetwork} from '../dev-seed'
import {resolveAttestationProducer} from '../attestation-producer'
import {resolveRegistrationCodeAvailability} from '../continuity'
import {setDeviceKeyWrapProviderForTests} from '../device-key-wrap'
import {createInMemoryKeyWrapProviderForTests} from '../__fixtures__/in-memory-key-wrap-provider'

const wrapProvider = createInMemoryKeyWrapProviderForTests()

beforeEach(async () => {
	await AsyncStorage.clear()
	setDeviceKeyWrapProviderForTests(wrapProvider)
})
afterEach(() => {
	setDeviceKeyWrapProviderForTests(undefined)
})

async function resolveAfterSeed(options?: {registeredStateFixture?: boolean}) {
	const networksEngine = new NetworksEngine(new LocalStorageReact())
	const seeded = await seedDevNetwork(networksEngine, options)
	const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)!
	const networkEngine = await networksEngine.open(seeded.networkReference, seeded.deviceUser)
	const engines: Record<string, unknown> = {
		network: networkEngine,
		association: new AssociationEngine(ctx),
		registration: new RegistrationEngine(ctx),
	}
	return resolveRegistrationCodeAvailability({
		getEngine: (async (name: string) => {
			if (name in engines) return engines[name]
			throw new Error(`continuity.dev-seed.test.ts: unexpected engine "${name}"`)
		}) as never,
		getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
	})
}

describe('continuity availability over a real dev seed (UAT 62 test 14)', () => {
	test('default flags: a fresh dev Voter reads not-registered (entry link reachable)', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			expect(await resolveAfterSeed()).toEqual({kind: 'not-registered'})
			expect(warn).not.toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	test('registeredStateFixture opted in: the old device symptom, now loud (unavailable + fixed warn)', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			// gap6/WR-07: the reason now tells a retryable read failure from a missing holder key.
			expect(await resolveAfterSeed({registeredStateFixture: true})).toEqual({kind: 'unavailable', reason: 'holder-key-missing', registrantKnown: true})
			expect(warn).toHaveBeenCalledWith('continuity: registration code holder key not found')
		} finally {
			warn.mockRestore()
		}
	})
})
