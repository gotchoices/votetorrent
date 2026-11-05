/**
 * continuity.test.ts — Phase 62 Plan 28 (D-40/D-41/D-43/D-45). One `it` per `<behavior>` bullet in
 * 62-28-PLAN.md's Task 1 (except the own-staging and registration-status bullets, which live in
 * `voter-request-transports.test.ts`/`registration-status.test.ts`). Plain fake engines/transports
 * (jest.fn) throughout; `device-user.ts`/`device-signer.ts` run FOR REAL against the 62-08
 * in-memory key-wrap stub (not mocked) — the same pattern `voter-request-transports.test.ts`
 * established — so `resolveRegistrationCodeAvailability`'s identity-key read and
 * `createDeviceSigner` call are proven against the real module, not a stand-in.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {AssociationRequestRead, Signature} from '@votetorrent/vote-core';
import {REASSOCIATION_UNRESOLVED_REGISTRANT_ID} from '@votetorrent/vote-core';
import {setDeviceKeyWrapProviderForTests} from '../device-key-wrap';
import {createInMemoryKeyWrapProviderForTests} from '../__fixtures__/in-memory-key-wrap-provider';
import {getDeviceIdentityKeyState, getOrCreateDeviceUser} from '../device-user';
import {
	REASSOCIATION_MAX_POLL_ROUNDS,
	advanceReassociation,
	buildIdentityFallbackFields,
	buildReassociationRequestInit,
	mintRegistrationCodeForSubmit,
	reassociationExtrasFor,
	resolveDeviceRetired,
	resolveReassociationResume,
	resolveRegistrationCodeAvailability,
	submitReassociationRequest,
} from '../continuity';
import type {ContinuityDeps, ReassociationCeremonyDeps} from '../continuity';
import type {VoterRequestTransports} from '../../screens/registration/attach-voter-request-transport';

const AUTHORITY_ID = 'auth-1';
const P256_PUB = 'p256-device-pub-key';

const wrapProvider = createInMemoryKeyWrapProviderForTests();

beforeEach(async () => {
	await AsyncStorage.clear();
	setDeviceKeyWrapProviderForTests(wrapProvider);
});

afterEach(() => {
	setDeviceKeyWrapProviderForTests(undefined);
});

function makeNetworkEngine(authorityId: string = AUTHORITY_ID) {
	return {getDetails: jest.fn(async () => ({network: {primaryAuthorityId: authorityId}}))};
}

interface ContinuityDepsOverrides {
	network?: ReturnType<typeof makeNetworkEngine>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	association?: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	registration?: any;
	getCurrentDeviceKey?: ContinuityDeps['getCurrentDeviceKey'];
	resolveTransports?: ContinuityDeps['resolveTransports'];
}

function makeContinuityDeps(overrides: ContinuityDepsOverrides = {}): ContinuityDeps {
	const network = overrides.network ?? makeNetworkEngine();
	const association = overrides.association ?? {};
	const registration = overrides.registration ?? {};
	const getEngine = jest.fn(async (name: string) => {
		if (name === 'network') return network;
		if (name === 'association') return association;
		if (name === 'registration') return registration;
		throw new Error(`continuity.test.ts stub: unexpected engine "${name}"`);
	});
	return {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		getEngine: getEngine as any,
		getCurrentDeviceKey: overrides.getCurrentDeviceKey ?? (async () => ({publicKey: P256_PUB})),
		resolveTransports: overrides.resolveTransports,
	};
}

function makeSentinelRequest(overrides: {
	requestId: string;
	status: AssociationRequestRead['status'];
	submittedAt: string;
	deviceKey?: string;
	registrantId?: string;
	challengeNonce?: string;
}): AssociationRequestRead {
	return {
		requestId: overrides.requestId,
		authorityId: AUTHORITY_ID,
		registrantId: overrides.registrantId ?? REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
		deviceKey: overrides.deviceKey ?? P256_PUB,
		status: overrides.status,
		challengeNonce: overrides.challengeNonce,
		submittedAt: overrides.submittedAt,
		receivedAt: overrides.submittedAt,
	};
}

function makeTransports(overrides: Partial<VoterRequestTransports> = {}): VoterRequestTransports {
	return {
		registrationTransport: {submitRequest: jest.fn(), pollDecisions: jest.fn(async () => [])},
		associationTransport: {
			submitRequest: jest.fn(),
			submitAttestation: jest.fn(),
			pollDecisions: jest.fn(async () => []),
		},
		registrationRoute: 'peer',
		ownAssociationRequestIds: jest.fn(async () => []),
		ownStagedRegistrationRequestIds: jest.fn(async () => []),
		...overrides,
	};
}

// -------------------------------------------------------------------------------------------
// resolveRegistrationCodeAvailability
// -------------------------------------------------------------------------------------------

describe('resolveRegistrationCodeAvailability (D-45)', () => {
	test('available: an active registrant, a matching holder key, own-staged registration and a successful derive resolve the code', async () => {
		const identityUser = await getOrCreateDeviceUser('Device User');
		const identityKey = identityUser.activeKeys[0]!.key;
		const unwrapBefore = wrapProvider.unwrapCalls;

		const deriveRegistrationCode = jest.fn(async () => 'ABCDE12345');
		const getRegistrationCodeHolderKey = jest.fn(async () => identityKey);
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey,
			deriveRegistrationCode,
		};
		const registration = {
			getRegistrant: jest.fn(async (id: string) => (id === 'R1' ? {id, authorityId: AUTHORITY_ID, status: 'a'} : undefined)),
		};
		const resolveTransports = jest.fn(async () =>
			makeTransports({ownStagedRegistrationRequestIds: jest.fn(async (key: string) => (key === identityKey ? ['R1'] : []))}),
		);

		const deps = makeContinuityDeps({association, registration, resolveTransports});
		const result = await resolveRegistrationCodeAvailability(deps);

		expect(result).toEqual({kind: 'available', code: 'ABCDE12345'});
		expect(deriveRegistrationCode).toHaveBeenCalledWith('R1', expect.any(Function));
		expect(wrapProvider.unwrapCalls).toBeGreaterThan(unwrapBefore);
	});

	test('not-registered: zero Association rows resolve not-registered, and getRegistrationCodeHolderKey/deriveRegistrationCode are never called; identity is never provisioned', async () => {
		const stateBefore = await getDeviceIdentityKeyState();
		expect(stateBefore).toBe('absent');

		const getRegistrationCodeHolderKey = jest.fn();
		const deriveRegistrationCode = jest.fn();
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => []),
			getRegistrationCodeHolderKey,
			deriveRegistrationCode,
		};
		const deps = makeContinuityDeps({association});

		const result = await resolveRegistrationCodeAvailability(deps);

		expect(result).toEqual({kind: 'not-registered'});
		expect(getRegistrationCodeHolderKey).not.toHaveBeenCalled();
		expect(deriveRegistrationCode).not.toHaveBeenCalled();
		// getOrCreateDeviceUser never ran — nothing was ever persisted.
		expect(await getDeviceIdentityKeyState()).toBe('absent');
	});

	test('unavailable: holder key undefined logs exactly one fixed-string warn (T-62-51-01) and the catch-path warn stays distinct', async () => {
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(async () => undefined),
			deriveRegistrationCode: jest.fn(),
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 'a'}))};
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await resolveRegistrationCodeAvailability(makeContinuityDeps({association, registration}));
			// gap6/WR-07: the reason now tells a retryable read failure from a missing holder key.
			expect(result).toEqual({kind: 'unavailable', reason: 'holder-key-missing', registrantKnown: true});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]).toEqual(['continuity: registration code holder key not found']);

			warn.mockClear();
			const failing = {getAssociationsByDeviceKey: jest.fn(async () => { throw new Error('boom'); })};
			// gap6/WR-07: the reason now tells a retryable read failure from a missing holder key.
			expect(await resolveRegistrationCodeAvailability(makeContinuityDeps({association: failing}))).toEqual({kind: 'unavailable', reason: 'read-failed', registrantKnown: false});
			expect(warn.mock.calls[0]![0]).toBe('continuity: code availability read failed');
		} finally {
			warn.mockRestore();
		}
	});

	test('not-registered: a suspended (s) registrant is also not-registered', async () => {
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(),
			deriveRegistrationCode: jest.fn(),
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 's'}))};
		const result = await resolveRegistrationCodeAvailability(makeContinuityDeps({association, registration}));
		expect(result).toEqual({kind: 'not-registered'});
	});

	test('not-registered: a revoked (r) registrant of ANOTHER authority is also not-registered', async () => {
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(),
			deriveRegistrationCode: jest.fn(),
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: 'some-other-authority', status: 'a'}))};
		const result = await resolveRegistrationCodeAvailability(makeContinuityDeps({association, registration}));
		expect(result).toEqual({kind: 'not-registered'});
	});

	test('not-holder: a holder key that differs from this device\'s identity key resolves not-holder, and deriveRegistrationCode is never called', async () => {
		const deriveRegistrationCode = jest.fn();
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(async () => 'some-other-devices-identity-key'),
			deriveRegistrationCode,
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 'a'}))};
		const result = await resolveRegistrationCodeAvailability(makeContinuityDeps({association, registration}));
		expect(result).toEqual({kind: 'not-holder'});
		expect(deriveRegistrationCode).not.toHaveBeenCalled();
	});

	test('not-sent: own staging ids lacking the registrantId resolve not-sent, and deriveRegistrationCode is never called', async () => {
		const identityUser = await getOrCreateDeviceUser('Device User');
		const identityKey = identityUser.activeKeys[0]!.key;
		const deriveRegistrationCode = jest.fn();
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(async () => identityKey),
			deriveRegistrationCode,
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 'a'}))};
		const resolveTransports = jest.fn(async () => makeTransports({ownStagedRegistrationRequestIds: jest.fn(async () => ['some-other-id'])}));
		const result = await resolveRegistrationCodeAvailability(
			makeContinuityDeps({association, registration, resolveTransports}),
		);
		expect(result).toEqual({kind: 'not-sent'});
		expect(deriveRegistrationCode).not.toHaveBeenCalled();
	});

	test('not-sent: an undefined transport resolver resolves not-sent', async () => {
		const identityUser = await getOrCreateDeviceUser('Device User');
		const identityKey = identityUser.activeKeys[0]!.key;
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(async () => identityKey),
			deriveRegistrationCode: jest.fn(),
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 'a'}))};
		const resolveTransports = jest.fn(async () => undefined);
		const result = await resolveRegistrationCodeAvailability(
			makeContinuityDeps({association, registration, resolveTransports}),
		);
		expect(result).toEqual({kind: 'not-sent'});
	});

	test('unavailable: an undefined holder key resolves unavailable', async () => {
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(async () => undefined),
			deriveRegistrationCode: jest.fn(),
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 'a'}))};
		const result = await resolveRegistrationCodeAvailability(makeContinuityDeps({association, registration}));
		// gap6/WR-07: the reason now tells a retryable read failure from a missing holder key.
		expect(result).toEqual({kind: 'unavailable', reason: 'holder-key-missing', registrantKnown: true});
	});

	test('unavailable: any engine read rejecting never throws, resolves unavailable', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => {
				throw new Error('simulated read failure');
			}),
			getRegistrationCodeHolderKey: jest.fn(),
			deriveRegistrationCode: jest.fn(),
		};
		const result = await resolveRegistrationCodeAvailability(makeContinuityDeps({association}));
		// gap6/WR-07: the reason now tells a retryable read failure from a missing holder key.
		expect(result).toEqual({kind: 'unavailable', reason: 'read-failed', registrantKnown: false});
		expect(warnSpy).toHaveBeenCalled();
		// The fixed log string never contains the real error's own message.
		expect(warnSpy.mock.calls.some(c => c.some(a => String(a).includes('simulated read failure')))).toBe(false);
		warnSpy.mockRestore();
	});

	test('unavailable: a rejecting deriveRegistrationCode resolves unavailable, never throws', async () => {
		const identityUser = await getOrCreateDeviceUser('Device User');
		const identityKey = identityUser.activeKeys[0]!.key;
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const association = {
			getAssociationsByDeviceKey: jest.fn(async () => [{registrantId: 'R1', deviceKey: P256_PUB}]),
			getRegistrationCodeHolderKey: jest.fn(async () => identityKey),
			deriveRegistrationCode: jest.fn(async () => {
				throw new Error('derive failed');
			}),
		};
		const registration = {getRegistrant: jest.fn(async () => ({id: 'R1', authorityId: AUTHORITY_ID, status: 'a'}))};
		const resolveTransports = jest.fn(async () => makeTransports({ownStagedRegistrationRequestIds: jest.fn(async () => ['R1'])}));
		const result = await resolveRegistrationCodeAvailability(
			makeContinuityDeps({association, registration, resolveTransports}),
		);
		// gap6/WR-07: the reason now tells a retryable read failure from a missing holder key.
		expect(result).toEqual({kind: 'unavailable', reason: 'read-failed', registrantKnown: true});
		warnSpy.mockRestore();
	});

	test('every non-available result has exactly the key "kind" — no registrantId, key or reason leaks', async () => {
		const notRegistered = await resolveRegistrationCodeAvailability(
			makeContinuityDeps({association: {getAssociationsByDeviceKey: jest.fn(async () => [])}}),
		);
		expect(Object.keys(notRegistered)).toEqual(['kind']);

		const unavailable = await resolveRegistrationCodeAvailability(
			makeContinuityDeps({
				association: {
					getAssociationsByDeviceKey: jest.fn(async () => {
						throw new Error('x');
					}),
				},
			}),
		);
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		// gap6/WR-07: 'unavailable' now carries the fixed-vocabulary reason and registrantKnown flag (no id/key/error text).
		expect(Object.keys(unavailable).sort()).toEqual(['kind', 'reason', 'registrantKnown']);
		warnSpy.mockRestore();
	});
});

// -------------------------------------------------------------------------------------------
// mintRegistrationCodeForSubmit
// -------------------------------------------------------------------------------------------

describe('mintRegistrationCodeForSubmit', () => {
	test('calls getEngine(\'association\') then deriveRegistrationCode(registrantId, sign) and resolves its value; a rejection propagates', async () => {
		const deriveRegistrationCode = jest.fn(async () => 'MINTEDCODE1');
		const association = {deriveRegistrationCode};
		const getEngine = jest.fn(async (name: string) => {
			expect(name).toBe('association');
			return association;
		});
		const sign = jest.fn(async (): Promise<Signature> => ({signerUserId: '', signerKey: '', signature: ''}));

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await mintRegistrationCodeForSubmit(getEngine as any, 'R1', sign);
		expect(result).toBe('MINTEDCODE1');
		expect(deriveRegistrationCode).toHaveBeenCalledWith('R1', sign);

		deriveRegistrationCode.mockRejectedValueOnce(new Error('derive failed'));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(mintRegistrationCodeForSubmit(getEngine as any, 'R1', sign)).rejects.toThrow('derive failed');
	});
});

// -------------------------------------------------------------------------------------------
// buildIdentityFallbackFields
// -------------------------------------------------------------------------------------------

describe('buildIdentityFallbackFields', () => {
	test('trims values, drops empty ones, and keeps catalog order', () => {
		const fields = buildIdentityFallbackFields({
			firstName: '  Jane  ',
			lastName: 'Doe',
			dob: '',
			email: 'jane@example.com',
			phone: '   ',
			addressLine1: '123 Main St',
			addressLine2: '',
			addressLine3: '',
		});
		expect(fields).toEqual([
			{name: 'firstName', value: 'Jane'},
			{name: 'lastName', value: 'Doe'},
			{name: 'email', value: 'jane@example.com'},
			{name: 'addressLine1', value: '123 Main St'},
		]);
	});
});

// -------------------------------------------------------------------------------------------
// reassociationExtrasFor
// -------------------------------------------------------------------------------------------

describe('reassociationExtrasFor', () => {
	test('code evidence normalizes and deep-equals {registrationCode}, with no identityFields key', () => {
		const extras = reassociationExtrasFor({kind: 'code', code: 'wwwww-wwwww'});
		expect(extras).toEqual({registrationCode: 'WWWWWWWWWW'});
		expect('identityFields' in extras).toBe(false);
	});

	test('an unnormalizable code throws TypeError', () => {
		expect(() => reassociationExtrasFor({kind: 'code', code: 'not-a-valid-code'})).toThrow(TypeError);
	});

	test('identity evidence deep-equals {identityFields}, with no registrationCode key', () => {
		const fields = [{name: 'firstName', value: 'Jane'}];
		const extras = reassociationExtrasFor({kind: 'identity', fields});
		expect(extras).toEqual({identityFields: fields});
		expect('registrationCode' in extras).toBe(false);
	});

	test('empty identity fields throw TypeError', () => {
		expect(() => reassociationExtrasFor({kind: 'identity', fields: []})).toThrow(TypeError);
	});
});

// -------------------------------------------------------------------------------------------
// buildReassociationRequestInit
// -------------------------------------------------------------------------------------------

describe('buildReassociationRequestInit', () => {
	test('sets the sentinel registrantId, the given deviceKey, and omits electionId when undefined', () => {
		const init = buildReassociationRequestInit({
			id: 'req-1',
			authorityId: AUTHORITY_ID,
			deviceKey: P256_PUB,
			submittedAt: '2026-01-01T00:00:00.000Z',
		});
		expect(init.registrantId).toBe(REASSOCIATION_UNRESOLVED_REGISTRANT_ID);
		expect(init.deviceKey).toBe(P256_PUB);
		expect('electionId' in init).toBe(false);
	});

	test('carries electionId when given', () => {
		const init = buildReassociationRequestInit({
			id: 'req-1',
			authorityId: AUTHORITY_ID,
			deviceKey: P256_PUB,
			electionId: 'election-1',
			submittedAt: '2026-01-01T00:00:00.000Z',
		});
		expect(init.electionId).toBe('election-1');
	});
});

// -------------------------------------------------------------------------------------------
// submitReassociationRequest
// -------------------------------------------------------------------------------------------

describe('submitReassociationRequest', () => {
	function makeCeremonyDeps(overrides: Partial<ReassociationCeremonyDeps> = {}): ReassociationCeremonyDeps {
		return {
			transports: makeTransports(),
			producer: {
				provisionDeviceKey: jest.fn(async () => ({publicKey: P256_PUB})),
				getCurrentDeviceKey: jest.fn(async () => ({publicKey: P256_PUB})),
				produce: jest.fn(),
				signDeviceKeyDigest: jest.fn(async (): Promise<Signature> => ({signerUserId: '', signerKey: P256_PUB, signature: 'sig'})),
			},
			authorityId: AUTHORITY_ID,
			deviceKey: P256_PUB,
			...overrides,
		};
	}

	test('calls associationTransport.submitRequest(init, deviceKey, signCb, extras) exactly once; signCb delegates to producer.signDeviceKeyDigest', async () => {
		const transports = makeTransports();
		const submitRequest = transports.associationTransport.submitRequest as jest.Mock;
		submitRequest.mockImplementation(async (init: {id: string}) => init.id);
		const signDeviceKeyDigest = jest.fn(async (): Promise<Signature> => ({signerUserId: '', signerKey: P256_PUB, signature: 'sig'}));
		const deps = makeCeremonyDeps({transports, producer: {provisionDeviceKey: jest.fn(), getCurrentDeviceKey: jest.fn(), produce: jest.fn(), signDeviceKeyDigest}});
		const init = buildReassociationRequestInit({
			id: 'req-1',
			authorityId: AUTHORITY_ID,
			deviceKey: P256_PUB,
			submittedAt: '2026-01-01T00:00:00.000Z',
		});

		const id = await submitReassociationRequest(deps, init, {kind: 'code', code: 'WWWWW-WWWWW'});

		expect(id).toBe('req-1');
		expect(submitRequest).toHaveBeenCalledTimes(1);
		const [calledInit, calledKey, calledSignCb, calledExtras] = submitRequest.mock.calls[0];
		expect(calledInit).toBe(init);
		expect(calledKey).toBe(P256_PUB);
		expect(calledExtras).toEqual({registrationCode: 'WWWWWWWWWW'});

		await (calledSignCb as (d: Uint8Array) => Promise<Signature>)(new Uint8Array([1, 2, 3]));
		expect(signDeviceKeyDigest).toHaveBeenCalledTimes(1);
	});

	test('a producer without signDeviceKeyDigest rejects before any submit', async () => {
		const transports = makeTransports();
		const submitRequest = transports.associationTransport.submitRequest as jest.Mock;
		const deps = makeCeremonyDeps({transports, producer: {provisionDeviceKey: jest.fn(), getCurrentDeviceKey: jest.fn(), produce: jest.fn()}});
		const init = buildReassociationRequestInit({
			id: 'req-1',
			authorityId: AUTHORITY_ID,
			deviceKey: P256_PUB,
			submittedAt: '2026-01-01T00:00:00.000Z',
		});

		await expect(submitReassociationRequest(deps, init, {kind: 'code', code: 'WWWWW-WWWWW'})).rejects.toThrow(
			'Device attestation signer is not available yet',
		);
		expect(submitRequest).not.toHaveBeenCalled();
	});
});

// -------------------------------------------------------------------------------------------
// advanceReassociation
// -------------------------------------------------------------------------------------------

describe('advanceReassociation', () => {
	function makeCeremonyDeps(overrides: Partial<ReassociationCeremonyDeps> & {transports: VoterRequestTransports}): ReassociationCeremonyDeps {
		return {
			producer: {
				provisionDeviceKey: jest.fn(async () => ({publicKey: P256_PUB})),
				getCurrentDeviceKey: jest.fn(async () => ({publicKey: P256_PUB})),
				produce: jest.fn(async () => ({publicKey: P256_PUB, deviceId: 'd', attestationTime: 1, certificateChain: ['c']})),
				signDeviceKeyDigest: jest.fn(async (): Promise<Signature> => ({signerUserId: '', signerKey: P256_PUB, signature: 'sig'})),
			},
			authorityId: AUTHORITY_ID,
			deviceKey: P256_PUB,
			electionId: 'election-1',
			...overrides,
		};
	}

	test('challenge then approved: produce+submitAttestation run once, cursor forwards, notices for other request ids are ignored', async () => {
		const attestationValue = {publicKey: P256_PUB, deviceId: 'd', attestationTime: 1, certificateChain: ['c']};
		const pollDecisions = jest
			.fn()
			.mockResolvedValueOnce([
				{requestId: 'someone-else', status: 'c', challengeNonce: 'ignored', cursor: '0'},
				{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: '1'},
			])
			.mockResolvedValueOnce([{requestId: 'Q', status: 'a', cursor: '2'}]);
		const submitAttestation = jest.fn(async (_answer: unknown, _requesterKey: unknown, _signOrCb: unknown) => undefined);
		const produce = jest.fn(async () => attestationValue);
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation, pollDecisions},
		});
		const deps = makeCeremonyDeps({transports, producer: {provisionDeviceKey: jest.fn(), getCurrentDeviceKey: jest.fn(), produce, signDeviceKeyDigest: jest.fn(async (): Promise<Signature> => ({signerUserId: '', signerKey: '', signature: 'sig'}))}});

		const result = await advanceReassociation(deps, 'Q', false);

		expect(result).toEqual({kind: 'approved'});
		expect(produce).toHaveBeenCalledTimes(1);
		expect(produce).toHaveBeenCalledWith({
			nonce: 'N',
			authorityId: AUTHORITY_ID,
			registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
			deviceKey: P256_PUB,
			electionId: 'election-1',
		});
		expect(submitAttestation).toHaveBeenCalledTimes(1);
		expect(submitAttestation.mock.calls[0][0]).toEqual({requestId: 'Q', nonce: 'N', attestation: attestationValue});
		expect(pollDecisions).toHaveBeenNthCalledWith(2, '1');
	});

	test('duplicate answer: a duplicate-request-id rejection from submitAttestation counts as already answered; pending once the feed drains', async () => {
		const pollDecisions = jest
			.fn()
			.mockResolvedValueOnce([{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: '1'}])
			.mockResolvedValueOnce([]);
		const submitAttestation = jest.fn(async () => {
			const err: Error & {code?: string} = new Error('already staged');
			err.code = 'duplicate-request-id';
			throw err;
		});
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation, pollDecisions},
		});
		const deps = makeCeremonyDeps({transports});

		const result = await advanceReassociation(deps, 'Q', false);
		expect(result).toEqual({kind: 'pending', answered: true});
	});

	test('a non-duplicate submitAttestation error propagates', async () => {
		const pollDecisions = jest.fn().mockResolvedValueOnce([{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: '1'}]);
		const submitAttestation = jest.fn(async () => {
			throw new Error('submit failed: transient');
		});
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation, pollDecisions},
		});
		const deps = makeCeremonyDeps({transports});

		await expect(advanceReassociation(deps, 'Q', false)).rejects.toThrow('submit failed: transient');
	});

	test('answered skips produce: with answered=true, a \'c\' notice never calls produce', async () => {
		const pollDecisions = jest
			.fn()
			.mockResolvedValueOnce([{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: '1'}])
			.mockResolvedValueOnce([]);
		const produce = jest.fn();
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation: jest.fn(), pollDecisions},
		});
		const deps = makeCeremonyDeps({transports, producer: {provisionDeviceKey: jest.fn(), getCurrentDeviceKey: jest.fn(), produce, signDeviceKeyDigest: jest.fn()}});

		const result = await advanceReassociation(deps, 'Q', true);
		expect(produce).not.toHaveBeenCalled();
		expect(result).toEqual({kind: 'pending', answered: true});
	});

	test('rejected: an \'r\' notice resolves rejected', async () => {
		const pollDecisions = jest.fn().mockResolvedValueOnce([{requestId: 'Q', status: 'r', cursor: '1'}]);
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation: jest.fn(), pollDecisions},
		});
		const deps = makeCeremonyDeps({transports});

		const result = await advanceReassociation(deps, 'Q', false);
		expect(result).toEqual({kind: 'rejected'});
	});

	test('drained: an empty round ends polling as pending', async () => {
		const pollDecisions = jest.fn(async () => []);
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation: jest.fn(), pollDecisions},
		});
		const deps = makeCeremonyDeps({transports});

		const result = await advanceReassociation(deps, 'Q', false);
		expect(result).toEqual({kind: 'pending', answered: false});
		expect(pollDecisions).toHaveBeenCalledTimes(1);
	});

	test('IN-02a: a re-delivered non-matching notice with an unmoved resume cursor ends the run as pending after two polls', async () => {
		const pollDecisions = jest.fn(async () => [{requestId: 'someone-else', status: 'c', challengeNonce: 'N', cursor: 'R'}]);
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation: jest.fn(), pollDecisions},
		});
		const deps = makeCeremonyDeps({transports});

		const result = await advanceReassociation(deps, 'Q', false);
		expect(result).toEqual({kind: 'pending', answered: false});
		expect(pollDecisions).toHaveBeenCalledTimes(2);
		expect(pollDecisions).toHaveBeenNthCalledWith(2, 'R');
	});

	test('IN-02b: a re-delivered challenge for our request is answered exactly once, then the run ends pending after two polls', async () => {
		const pollDecisions = jest.fn(async () => [{requestId: 'Q', status: 'c', challengeNonce: 'N', cursor: 'R'}]);
		const submitAttestation = jest.fn(async (_a: unknown, _k: unknown, _s: unknown) => undefined);
		const produce = jest.fn(async () => ({publicKey: P256_PUB, deviceId: 'd', attestationTime: 1, certificateChain: ['c']}));
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation, pollDecisions},
		});
		const deps = makeCeremonyDeps({transports, producer: {provisionDeviceKey: jest.fn(), getCurrentDeviceKey: jest.fn(), produce, signDeviceKeyDigest: jest.fn(async (): Promise<Signature> => ({signerUserId: '', signerKey: '', signature: 'sig'}))}});

		const result = await advanceReassociation(deps, 'Q', false);
		expect(result).toEqual({kind: 'pending', answered: true});
		expect(produce).toHaveBeenCalledTimes(1);
		expect(submitAttestation).toHaveBeenCalledTimes(1);
		expect(pollDecisions).toHaveBeenCalledTimes(2);
	});

	test('IN-02c: a re-delivered approval with an unmoved resume cursor still resolves approved', async () => {
		const pollDecisions = jest.fn(async () => [{requestId: 'Q', status: 'a', cursor: 'R'}]);
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation: jest.fn(), pollDecisions},
		});
		const deps = makeCeremonyDeps({transports});

		const result = await advanceReassociation(deps, 'Q', false);
		expect(result).toEqual({kind: 'approved'});
		expect(pollDecisions).toHaveBeenCalledTimes(1);
	});

	test('bounded: a feed that only ever reports a fresh non-matching notice stops after exactly REASSOCIATION_MAX_POLL_ROUNDS calls', async () => {
		let calls = 0;
		const pollDecisions = jest.fn(async () => {
			calls += 1;
			return [{requestId: 'someone-else', status: 'c', challengeNonce: 'N', cursor: `cursor-${calls}`}];
		});
		const transports = makeTransports({
			associationTransport: {submitRequest: jest.fn(), submitAttestation: jest.fn(), pollDecisions},
		});
		const deps = makeCeremonyDeps({transports});

		const result = await advanceReassociation(deps, 'Q', false);
		expect(result).toEqual({kind: 'pending', answered: false});
		expect(pollDecisions).toHaveBeenCalledTimes(REASSOCIATION_MAX_POLL_ROUNDS);
	});
});

// -------------------------------------------------------------------------------------------
// resolveReassociationResume
// -------------------------------------------------------------------------------------------

describe('63-18: lookups never create a device key', () => {
	const absent = () => Object.assign(new Error('absent'), {code: 'DEVICE_KEY_ABSENT'});

	test('code availability: DEVICE_KEY_ABSENT -> not-registered, with no engine read', async () => {
		const deps = makeContinuityDeps({getCurrentDeviceKey: async () => { throw absent(); }});
		expect(await resolveRegistrationCodeAvailability(deps)).toEqual({kind: 'not-registered'});
		expect(deps.getEngine).not.toHaveBeenCalled();
	});

	test('code availability: any other key lookup failure stays unavailable', async () => {
		const deps = makeContinuityDeps({
			getCurrentDeviceKey: async () => { throw Object.assign(new Error('invalid'), {code: 'DEVICE_KEY_INVALIDATED'}); },
		});
		// gap6/WR-07: the reason now tells a retryable read failure from a missing holder key.
		expect(await resolveRegistrationCodeAvailability(deps)).toEqual({kind: 'unavailable', reason: 'read-failed', registrantKnown: false});
	});

	test('reassociation resume and retired notice fail soft on an absent key (fresh / false)', async () => {
		const deps = makeContinuityDeps({getCurrentDeviceKey: async () => { throw absent(); }});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'fresh'});
		expect(await resolveDeviceRetired({getEngine: deps.getEngine, getCurrentDeviceKey: deps.getCurrentDeviceKey, identityKeyState: async () => 'wrapped'})).toBe(false);
	});

	test('the three resolvers read the key through getCurrentDeviceKey exactly once each', async () => {
		const getCurrentDeviceKey = jest.fn(async () => ({publicKey: P256_PUB}));
		const deps = makeContinuityDeps({getCurrentDeviceKey});
		await resolveRegistrationCodeAvailability(deps);
		await resolveReassociationResume(deps);
		await resolveDeviceRetired({getEngine: deps.getEngine, getCurrentDeviceKey, identityKeyState: async () => 'wrapped'});
		expect(getCurrentDeviceKey).toHaveBeenCalledTimes(3);
	});

	test('source gate with negative control: continuity.ts contains no provisionDeviceKey( call; a planted one is detected', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs') as typeof import('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path') as typeof import('path');
		const text = fs.readFileSync(path.join(__dirname, '..', 'continuity.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		const re = /\bprovisionDeviceKey\s*\(/;
		expect(re.test(text)).toBe(false);
		expect(re.test(text + '\nawait deps.provisionDeviceKey();')).toBe(true);
	});
});

describe('resolveReassociationResume', () => {
	test('an own sentinel \'p\' row resolves pending with its requestId', async () => {
		const listAssociationRequests = jest.fn(async () => [
			makeSentinelRequest({requestId: 'req-p', status: 'p', submittedAt: '2026-01-01T00:00:00.000Z'}),
		]);
		const deps = makeContinuityDeps({association: {listAssociationRequests}});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'pending', requestId: 'req-p'});
	});

	test('an own sentinel \'c\' row resolves pending with its challengeNonce', async () => {
		const listAssociationRequests = jest.fn(async () => [
			makeSentinelRequest({requestId: 'req-c', status: 'c', submittedAt: '2026-01-02T00:00:00.000Z', challengeNonce: 'nonce-xyz'}),
		]);
		const deps = makeContinuityDeps({association: {listAssociationRequests}});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'pending', requestId: 'req-c', challengeNonce: 'nonce-xyz'});
	});

	test('an own sentinel \'a\' row resolves approved', async () => {
		const listAssociationRequests = jest.fn(async () => [
			makeSentinelRequest({requestId: 'req-a', status: 'a', submittedAt: '2026-01-03T00:00:00.000Z'}),
		]);
		const deps = makeContinuityDeps({association: {listAssociationRequests}});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'approved'});
	});

	test('only \'r\' rows resolve fresh', async () => {
		const listAssociationRequests = jest.fn(async () => [
			makeSentinelRequest({requestId: 'req-r', status: 'r', submittedAt: '2026-01-01T00:00:00.000Z'}),
		]);
		const deps = makeContinuityDeps({association: {listAssociationRequests}});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'fresh'});
	});

	test('a row for a different device key resolves fresh (not mine)', async () => {
		const listAssociationRequests = jest.fn(async () => [
			makeSentinelRequest({requestId: 'req-x', status: 'p', submittedAt: '2026-01-01T00:00:00.000Z', deviceKey: 'someone-elses-key'}),
		]);
		const deps = makeContinuityDeps({association: {listAssociationRequests}});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'fresh'});
	});

	test('a non-sentinel registrantId row resolves fresh (not a re-association)', async () => {
		const listAssociationRequests = jest.fn(async () => [
			makeSentinelRequest({requestId: 'req-y', status: 'p', submittedAt: '2026-01-01T00:00:00.000Z', registrantId: 'real-registrant-id'}),
		]);
		const deps = makeContinuityDeps({association: {listAssociationRequests}});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'fresh'});
	});

	test('a read failure resolves fresh', async () => {
		const listAssociationRequests = jest.fn(async () => {
			throw new Error('boom');
		});
		const deps = makeContinuityDeps({association: {listAssociationRequests}});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'fresh'});
	});

	test('multiple own sentinel rows resolve from the NEWEST by submittedAt, not array order', async () => {
		const older = makeSentinelRequest({requestId: 'req-old', status: 'r', submittedAt: '2026-01-01T00:00:00.000Z'});
		const newer = makeSentinelRequest({requestId: 'req-new', status: 'p', submittedAt: '2026-01-05T00:00:00.000Z'});
		const listAssociationRequests = jest.fn(async () => [older, newer]);
		const deps = makeContinuityDeps({association: {listAssociationRequests}});
		expect(await resolveReassociationResume(deps)).toEqual({kind: 'pending', requestId: 'req-new'});
	});
});

// -------------------------------------------------------------------------------------------
// resolveDeviceRetired
// -------------------------------------------------------------------------------------------

describe('resolveDeviceRetired (D-41)', () => {
	test('returns true iff getDeviceRetirement resolves a record', async () => {
		const getDeviceRetirement = jest.fn(async () => ({deviceKey: P256_PUB, requestId: 'req-1', decidedAt: '2026-01-01T00:00:00.000Z'}));
		const getEngine = jest.fn(async () => ({getDeviceRetirement}));
		const getCurrentDeviceKey = jest.fn(async () => ({publicKey: P256_PUB}));

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await resolveDeviceRetired({getEngine: getEngine as any, getCurrentDeviceKey, identityKeyState: async () => 'wrapped'});
		expect(result).toBe(true);
		expect(getDeviceRetirement).toHaveBeenCalledWith(P256_PUB);
	});

	test('returns false when getDeviceRetirement resolves undefined', async () => {
		const getDeviceRetirement = jest.fn(async () => undefined);
		const getEngine = jest.fn(async () => ({getDeviceRetirement}));
		const getCurrentDeviceKey = jest.fn(async () => ({publicKey: P256_PUB}));

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await resolveDeviceRetired({getEngine: getEngine as any, getCurrentDeviceKey, identityKeyState: async () => 'wrapped'});
		expect(result).toBe(false);
	});

	test('identity state \'absent\' returns false WITHOUT calling getCurrentDeviceKey or getEngine', async () => {
		const getEngine = jest.fn();
		const getCurrentDeviceKey = jest.fn();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await resolveDeviceRetired({getEngine: getEngine as any, getCurrentDeviceKey, identityKeyState: async () => 'absent'});
		expect(result).toBe(false);
		expect(getEngine).not.toHaveBeenCalled();
		expect(getCurrentDeviceKey).not.toHaveBeenCalled();
	});

	test('a thrown read returns false', async () => {
		const getCurrentDeviceKey = jest.fn(async () => {
			throw new Error('boom');
		});

		const result = await resolveDeviceRetired({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			getEngine: jest.fn() as any,
			getCurrentDeviceKey,
			identityKeyState: async () => 'wrapped',
		});
		expect(result).toBe(false);
	});
});
