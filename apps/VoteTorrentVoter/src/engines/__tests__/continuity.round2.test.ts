/**
 * continuity.round2.test.ts — gap6/WR-07 (unavailable reasons) and initial/G5 WR-04 reader half
 * (an approval beats a contradictory rejection). U-1, U-2, P-1..P-4 (P-4: REVIEW CR-R4-02).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Signature} from '@votetorrent/vote-core';
import {setDeviceKeyWrapProviderForTests} from '../device-key-wrap';
import {createInMemoryKeyWrapProviderForTests} from '../__fixtures__/in-memory-key-wrap-provider';
import {getOrCreateDeviceUser} from '../device-user';
import {advanceReassociation, resolveRegistrationCodeAvailability} from '../continuity';
import type {ContinuityDeps, ReassociationCeremonyDeps} from '../continuity';
import type {VoterRequestTransports} from '../../screens/registration/attach-voter-request-transport';

const AUTHORITY_ID = 'auth-1';
const P256_PUB = 'p256-device-pub-key';
const wrapProvider = createInMemoryKeyWrapProviderForTests();

beforeEach(async () => {
	await AsyncStorage.clear();
	setDeviceKeyWrapProviderForTests(wrapProvider);
});
afterEach(() => setDeviceKeyWrapProviderForTests(undefined));

function makeDeps(opts: {network?: unknown; association?: unknown; registration?: unknown; resolveTransports?: unknown}): ContinuityDeps {
	const network = opts.network ?? {getDetails: jest.fn(async () => ({network: {primaryAuthorityId: AUTHORITY_ID}}))};
	const getEngine = jest.fn(async (name: string) => {
		if (name === 'network') return network;
		if (name === 'association') return opts.association ?? {};
		if (name === 'registration') return opts.registration ?? {};
		throw new Error('unexpected engine');
	});
	return {
		getEngine: getEngine as unknown as ContinuityDeps['getEngine'],
		getCurrentDeviceKey: async () => ({publicKey: P256_PUB}),
		resolveTransports: opts.resolveTransports as ContinuityDeps['resolveTransports'],
	};
}

describe('unavailable reasons (gap6/WR-07)', () => {
	test('U-1: network read rejecting -> read-failed, registrantKnown false', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const network = {getDetails: jest.fn(async () => { throw new Error('not ready'); })};
		expect(await resolveRegistrationCodeAvailability(makeDeps({network}))).toEqual({
			kind: 'unavailable',
			reason: 'read-failed',
			registrantKnown: false,
		});
		warn.mockRestore();
	});

	test('U-1: a failure after the registrant resolved (signer cancel) -> read-failed, registrantKnown true', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const identityKey = (await getOrCreateDeviceUser('Device User')).activeKeys[0]!.key;
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(async () => identityKey),
			deriveRegistrationCode: jest.fn(async () => { throw new Error('biometric cancel'); }),
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 'a'}))};
		const resolveTransports = jest.fn(async () => ({ownStagedRegistrationRequestIds: jest.fn(async () => ['R1'])}));
		const result = await resolveRegistrationCodeAvailability(makeDeps({association, registration, resolveTransports}));
		expect(result).toEqual({kind: 'unavailable', reason: 'read-failed', registrantKnown: true});
		warn.mockRestore();
	});

	test('U-1/U-2: holder key undefined -> holder-key-missing; fixed warns; result carries only the allowed keys', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(async () => undefined),
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 'a'}))};
		const result = await resolveRegistrationCodeAvailability(makeDeps({association, registration}));
		expect(result).toEqual({kind: 'unavailable', reason: 'holder-key-missing', registrantKnown: true});
		expect(Object.keys(result).sort()).toEqual(['kind', 'reason', 'registrantKnown']);
		expect(JSON.stringify(result)).not.toMatch(/R1|p256-device|boom/);
		expect(warn.mock.calls).toEqual([['continuity: registration code holder key not found']]);
		warn.mockRestore();
	});
});

describe('advanceReassociation prefers approval (initial/G5 WR-04 reader)', () => {
	function ceremony(pollDecisions: jest.Mock, produce: jest.Mock = jest.fn(), submitAttestation: jest.Mock = jest.fn()): ReassociationCeremonyDeps {
		const transports = {
			associationTransport: {submitRequest: jest.fn(), submitAttestation, pollDecisions},
		} as unknown as VoterRequestTransports;
		return {
			transports,
			producer: {
				provisionDeviceKey: jest.fn(),
				getCurrentDeviceKey: jest.fn(),
				produce,
				signDeviceKeyDigest: jest.fn(async (): Promise<Signature> => ({signerUserId: '', signerKey: P256_PUB, signature: 's'})),
			},
			authorityId: AUTHORITY_ID,
			deviceKey: P256_PUB,
		};
	}

	test('P-1: [c, a, r] in one page -> approved', async () => {
		const poll = jest.fn().mockResolvedValueOnce([
			{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: '1'},
			{requestId: 'Q', status: 'a', cursor: '2'},
			{requestId: 'Q', status: 'r', cursor: '3'},
		]);
		expect(await advanceReassociation(ceremony(poll), 'Q', true)).toEqual({kind: 'approved'});
	});

	test('P-2: rejection on page 1, approval on page 2 -> approved', async () => {
		const poll = jest
			.fn()
			.mockResolvedValueOnce([{requestId: 'Q', status: 'r', cursor: '1'}])
			.mockResolvedValueOnce([{requestId: 'Q', status: 'a', cursor: '2'}]);
		expect(await advanceReassociation(ceremony(poll), 'Q', false)).toEqual({kind: 'approved'});
	});

	test('P-2: a rejection with an empty next page -> rejected', async () => {
		const poll = jest.fn().mockResolvedValueOnce([{requestId: 'Q', status: 'r', cursor: '1'}]).mockResolvedValueOnce([]);
		expect(await advanceReassociation(ceremony(poll), 'Q', false)).toEqual({kind: 'rejected'});
	});

	test('P-2: a rejection followed by an unmoved cursor -> rejected', async () => {
		const poll = jest
			.fn()
			.mockResolvedValueOnce([{requestId: 'Q', status: 'r', cursor: '1'}])
			.mockResolvedValueOnce([{requestId: 'other', status: 'c', challengeNonce: 'x', cursor: '1'}]);
		expect(await advanceReassociation(ceremony(poll), 'Q', false)).toEqual({kind: 'rejected'});
	});

	test('P-4: [c, r] in one page, not yet answered -> rejected, and the challenge is never answered', async () => {
		const poll = jest.fn().mockResolvedValueOnce([
			{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: '1'},
			{requestId: 'Q', status: 'r', cursor: '2'},
		]).mockResolvedValueOnce([]);
		const produce = jest.fn(async () => ({publicKey: P256_PUB, deviceId: 'd', attestationTime: 1, certificateChain: ['c']}));
		const submit = jest.fn(async () => undefined);
		expect(await advanceReassociation(ceremony(poll, produce, submit), 'Q', false)).toEqual({kind: 'rejected'});
		expect(produce).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	test('P-4: rejection on page 1, challenge on page 2, not yet answered -> rejected, never answered', async () => {
		const poll = jest
			.fn()
			.mockResolvedValueOnce([{requestId: 'Q', status: 'r', cursor: '1'}])
			.mockResolvedValueOnce([{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: '2'}])
			.mockResolvedValueOnce([]);
		const produce = jest.fn(async () => ({publicKey: P256_PUB, deviceId: 'd', attestationTime: 1, certificateChain: ['c']}));
		const submit = jest.fn(async () => undefined);
		expect(await advanceReassociation(ceremony(poll, produce, submit), 'Q', false)).toEqual({kind: 'rejected'});
		expect(produce).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	test('P-3: a c answer still drives produce + submitAttestation once', async () => {
		const poll = jest
			.fn()
			.mockResolvedValueOnce([{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: '1'}])
			.mockResolvedValueOnce([{requestId: 'Q', status: 'a', cursor: '2'}]);
		const produce = jest.fn(async () => ({publicKey: P256_PUB, deviceId: 'd', attestationTime: 1, certificateChain: ['c']}));
		const submit = jest.fn(async () => undefined);
		expect(await advanceReassociation(ceremony(poll, produce, submit), 'Q', false)).toEqual({kind: 'approved'});
		expect(produce).toHaveBeenCalledTimes(1);
		expect(submit).toHaveBeenCalledTimes(1);
	});
});
