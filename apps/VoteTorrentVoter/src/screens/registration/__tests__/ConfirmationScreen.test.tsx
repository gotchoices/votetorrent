/**
 * Unit tests for ConfirmationScreen (REG-04/D-03/D-05/D-09/D-11) — the Face-ID confirming tap.
 * Fully mocks `@react-navigation/native` (spy-able `popToTop`), `providers/VoterAppProvider`,
 * `providers/RegistrationDraftProvider`, `engines/device-user`, and `engines/attestation-producer`
 * (D-11 two-step seam) so the real ceremony can be exercised without a real navigator/provider/
 * engine tree, mirroring Authority's `NetworksScreen.bootstrap.test.tsx` full-replace mocking
 * pattern.
 *
 * Phase 45-06 (this plan) — asserts the reordered/rebound ceremony: `provisionDeviceKey` runs
 * BEFORE `register`/`issueAttestationChallenge`; `issueAttestationChallenge` and `setDeviceKey`
 * both receive the P-256 pubkey (never the secp256k1 `activeKeys[0]` key); `seededElectionId` is
 * threaded as the trailing arg; and the D-09 three-way failure UX (recoverable-action /
 * recoverable-transient / terminal) renders the correct classified copy + CTA shape.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockPopToTop = jest.fn();
const mockSendIntent = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({popToTop: mockPopToTop}),
	useTheme: () => ({
		colors: {
			primary: '#2196f3',
			background: '#fbfbfb',
			text: '#000000',
			textSecondary: '#7d7d7d',
			light: '#ffffff',
		},
		fonts: {
			regular: {fontFamily: 'System', fontWeight: '400'},
			medium: {fontFamily: 'System', fontWeight: '500'},
		},
		type: {
			h2: {fontSize: 28, lineHeight: 34},
			body: {fontSize: 16, lineHeight: 22},
			caption: {fontSize: 16, lineHeight: 20},
		},
		radii: {pill: 999},
	}),
}));

jest.mock('react-native/Libraries/Linking/Linking', () => ({
	sendIntent: (...args: unknown[]) => mockSendIntent(...args),
}));

// ---- Mocked engine boundary (D-02/D-05): getEngine('network'|'registration'|'association') ----

const callOrder: string[] = [];

const mockGetDetails = jest.fn(async () => ({
	network: {primaryAuthorityId: 'authority-1'},
}));
const mockNetworkEngine = {getDetails: mockGetDetails};

// Capture every RegisterInit the ceremony submits, so tests can assert the stable
// registrantId (WR-02) and the furnished field details (WR-04).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registerInits: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRegister = jest.fn(async (init: any) => {
	callOrder.push('register');
	registerInits.push(init);
});
const mockRegistrationEngine = {register: mockRegister};

const CHALLENGE_NONCE = 'challenge-nonce-abc';
const P256_PUB = 'P256_PUB';
const SEEDED_ELECTION_ID = 'election-1';

interface IssueChallengeCall {
	registrantId: string;
	deviceKey: string;
	expiration: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	signatureOrCallback: any;
	electionId?: string;
}
const issueChallengeCalls: IssueChallengeCall[] = [];
const mockIssueAttestationChallenge = jest.fn(
	async (
		registrantId: string,
		deviceKey: string,
		expiration: string,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		signatureOrCallback: any,
		electionId?: string,
	) => {
		callOrder.push('issueAttestationChallenge');
		issueChallengeCalls.push({registrantId, deviceKey, expiration, signatureOrCallback, electionId});
		return {
			nonce: CHALLENGE_NONCE,
			authorityId: 'authority-1',
			registrantId,
			deviceKey,
			expiration: '2100-01-01T00:00:00Z',
		};
	},
);

let capturedSetDeviceKey: unknown;
const mockCommit = jest.fn(async () => {
	callOrder.push('associate.commit');
});

interface MockAssociateBuilder {
	setRegistrantId: jest.Mock<MockAssociateBuilder, [string]>;
	setDeviceKey: jest.Mock<MockAssociateBuilder, [string]>;
	setNonce: jest.Mock<MockAssociateBuilder, [string]>;
	setAttestation: jest.Mock<MockAssociateBuilder, [unknown]>;
	setSignatureOrCallback: jest.Mock<MockAssociateBuilder, [unknown]>;
	commit: jest.Mock<Promise<void>, []>;
}

function makeAssociateBuilder(): MockAssociateBuilder {
	const builder: MockAssociateBuilder = {
		setRegistrantId: jest.fn((_registrantId: string) => builder),
		setDeviceKey: jest.fn((deviceKey: string) => {
			capturedSetDeviceKey = deviceKey;
			return builder;
		}),
		setNonce: jest.fn((_nonce: string) => builder),
		setAttestation: jest.fn((_attestation: unknown) => builder),
		setSignatureOrCallback: jest.fn((_signatureOrCallback: unknown) => builder),
		commit: mockCommit,
	};
	return builder;
}

const mockAssociationEngine = {
	issueAttestationChallenge: mockIssueAttestationChallenge,
	buildAssociate: jest.fn(() => makeAssociateBuilder()),
};

const mockGetEngine = jest.fn(async (engineName: string) => {
	if (engineName === 'network') {
		return mockNetworkEngine;
	}
	if (engineName === 'registration') {
		return mockRegistrationEngine;
	}
	if (engineName === 'association') {
		return mockAssociationEngine;
	}
	throw new Error(`unexpected getEngine call: ${engineName}`);
});

const mockSign = jest.fn(async () => ({
	signerUserId: 'device-user-1',
	signerKey: 'device-pub-key',
	signature: 'stub-signature',
}));

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({
		seededElectionId: SEEDED_ELECTION_ID,
		sign: mockSign,
		getEngine: mockGetEngine,
	}),
}));

const mockClearDraft = jest.fn();
const sampleDraft = {
	firstName: 'Jane',
	lastName: 'Doe',
	dob: '01/01/1990',
	email: 'jane@example.com',
	phone: '555-1234',
	addressLine1: '123 Main St',
	addressLine2: '',
	addressLine3: '',
	party: 'democratic',
};
// Mutable so individual tests can vary the draft (e.g. a blank required field for WR-04);
// reset to a fresh copy of sampleDraft in beforeEach.
let mockDraft = {...sampleDraft};

jest.mock('../../../providers/RegistrationDraftProvider', () => ({
	useRegistrationDraft: () => ({
		draft: mockDraft,
		clearDraft: mockClearDraft,
	}),
}));

const mockGetOrCreateDeviceUser = jest.fn(async (..._args: unknown[]) => ({
	id: 'device-user-1',
	name: 'Dev Voter',
	activeKeys: [{key: 'SECP256K1_DEVICE_KEY_MUST_NOT_BE_USED', type: 'mobile', expiration: 9999999999999}],
}));
jest.mock('../../../engines/device-user', () => ({
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
}));

const mockProvisionDeviceKey = jest.fn(async () => {
	callOrder.push('provisionDeviceKey');
	return {publicKey: P256_PUB};
});
const mockProduce = jest.fn(async (challenge: {nonce: string}) => {
	callOrder.push('produce');
	return {
		publicKey: P256_PUB,
		deviceId: 'DEVICE_ID',
		attestationTime: Date.now(),
		certificateChain: ['CERT'],
		platformDetails: {type: 'Android' as const, safetyNetAttestation: 'x', keystorePublicKey: P256_PUB, nonce: challenge.nonce},
	};
});
const mockResolveAttestationProducer = jest.fn((..._args: unknown[]) => ({
	provisionDeviceKey: mockProvisionDeviceKey,
	produce: mockProduce,
}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: (...args: unknown[]) => mockResolveAttestationProducer(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ConfirmationScreen = require('../ConfirmationScreen').default;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<ConfirmationScreen />);
	});
	return tr;
}

async function pressConfirm(tr: renderer.ReactTestRenderer, testID = 'confirmation-confirm-face-id') {
	const cta = tr.root.findByProps({testID});
	await renderer.act(async () => {
		cta.props.onPress();
		// Flush the ceremony's chained microtasks (provisionDeviceKey -> register -> challenge
		// -> produce -> associate commit).
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	mockPopToTop.mockClear();
	mockClearDraft.mockClear();
	mockRegister.mockClear();
	mockIssueAttestationChallenge.mockClear();
	mockCommit.mockClear();
	mockProvisionDeviceKey.mockClear();
	mockProduce.mockClear();
	mockGetOrCreateDeviceUser.mockClear();
	mockSendIntent.mockClear();
	mockProvisionDeviceKey.mockImplementation(async () => {
		callOrder.push('provisionDeviceKey');
		return {publicKey: P256_PUB};
	});
	mockProduce.mockImplementation(async (challenge: {nonce: string}) => {
		callOrder.push('produce');
		return {
			publicKey: P256_PUB,
			deviceId: 'DEVICE_ID',
			attestationTime: Date.now(),
			certificateChain: ['CERT'],
			platformDetails: {type: 'Android' as const, safetyNetAttestation: 'x', keystorePublicKey: P256_PUB, nonce: challenge.nonce},
		};
	});
	callOrder.length = 0;
	capturedSetDeviceKey = undefined;
	registerInits.length = 0;
	issueChallengeCalls.length = 0;
	mockDraft = {...sampleDraft};
});

describe('ConfirmationScreen (REG-04/D-03/D-05/D-09/D-11)', () => {
	it("renders the 'You're all set!' heading and the confirm CTA", () => {
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("You're all set!");

		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		expect(cta).toBeDefined();
	});

	it('does NOT navigate on mount (only on the deliberate press)', () => {
		renderScreen();
		expect(mockPopToTop).not.toHaveBeenCalled();
	});

	it(
		'pressing the CTA drives provisionDeviceKey -> register -> issueAttestationChallenge -> ' +
			'produce -> associate commit, then clears the draft and pops to top (D-05/D-11)',
		async () => {
			const tr = renderScreen();
			await pressConfirm(tr);

			expect(callOrder).toEqual([
				'provisionDeviceKey',
				'register',
				'issueAttestationChallenge',
				'produce',
				'associate.commit',
			]);
			expect(mockClearDraft).toHaveBeenCalledTimes(1);
			expect(mockPopToTop).toHaveBeenCalledTimes(1);
		},
	);

	it('binds the challenge + association DeviceKey to the P-256 provisioned key, never the secp256k1 activeKeys[0] key (D-03)', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		expect(issueChallengeCalls).toHaveLength(1);
		expect(issueChallengeCalls[0].deviceKey).toBe(P256_PUB);
		expect(issueChallengeCalls[0].deviceKey).not.toBe('SECP256K1_DEVICE_KEY_MUST_NOT_BE_USED');
		expect(capturedSetDeviceKey).toBe(P256_PUB);
	});

	it('threads sign as arg 4 and seededElectionId as the trailing arg 5 to issueAttestationChallenge (D-11/45-04)', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		expect(issueChallengeCalls).toHaveLength(1);
		expect(issueChallengeCalls[0].signatureOrCallback).toBe(mockSign);
		expect(issueChallengeCalls[0].electionId).toBe(SEEDED_ELECTION_ID);
	});

	it('renders a transient-error retry affordance when register() rejects — no clearDraft/popToTop', async () => {
		mockRegister.mockRejectedValueOnce(new Error('register failed: field policy violation'));

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		expect(text).toContain('Try Again');
		expect(mockClearDraft).not.toHaveBeenCalled();
		expect(mockPopToTop).not.toHaveBeenCalled();
		// The ceremony must not have proceeded past the failed step.
		expect(callOrder).toEqual(['provisionDeviceKey']);
	});

	it('reuses the same registrantId across a retry (WR-02 — no duplicate/orphaned Registrant rows)', async () => {
		// First attempt: register() succeeds but the later associate commit rejects, so the
		// ceremony fails mid-flight and the CTA becomes "Try Again".
		mockCommit.mockRejectedValueOnce(new Error('associate failed: transient'));

		const tr = renderScreen();
		await pressConfirm(tr); // attempt 1 — register ok, commit fails
		await pressConfirm(tr); // attempt 2 — retry of the SAME submission

		expect(registerInits).toHaveLength(2);
		expect(registerInits[0].registrant.id).toBe(registerInits[1].registrant.id);
	});

	it('does not furnish a blank required field to register (WR-04 — empty required rejected by policy)', async () => {
		// A blank required private field (email) must NOT be furnished as {name:'email', value:''}
		// — that would satisfy the engine's name-presence check and slip past policy. With the
		// empty entry dropped, email is genuinely absent, so validateFieldPolicy rejects it.
		mockDraft = {...sampleDraft, email: '', phone: ''};

		const tr = renderScreen();
		await pressConfirm(tr);

		expect(registerInits).toHaveLength(1);
		const details = registerInits[0].private.details as Array<{name: string; value: string}>;
		const names = details.map(d => d.name);
		expect(names).not.toContain('email');
		expect(names).not.toContain('phone');
		// No furnished detail is ever an empty-valued placeholder.
		expect(details.every(d => d.value !== '')).toBe(true);
	});

	it('renders a transient-error retry affordance when a later step (associate commit) rejects', async () => {
		mockCommit.mockRejectedValueOnce(new Error('associate failed: attestation verification failed'));

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		expect(mockClearDraft).not.toHaveBeenCalled();
		expect(mockPopToTop).not.toHaveBeenCalled();
		// The ceremony reached (and attempted) the associate commit before rejecting.
		expect(callOrder).toEqual(['provisionDeviceKey', 'register', 'issueAttestationChallenge', 'produce']);
	});

	describe('D-09 three-way failure UX', () => {
		it('NO_BIOMETRICS_ENROLLED renders the setup prompt + deep-link CTA, and a separate retry — no clearDraft/popToTop', async () => {
			mockProduce.mockRejectedValueOnce({code: 'NO_BIOMETRICS_ENROLLED'});

			const tr = renderScreen();
			await pressConfirm(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('Set up fingerprint or face unlock to continue');
			expect(text).toContain('Set up device unlock');
			expect(mockClearDraft).not.toHaveBeenCalled();
			expect(mockPopToTop).not.toHaveBeenCalled();

			const setupCta = tr.root.findByProps({testID: 'confirmation-setup-cta'});
			await renderer.act(async () => {
				setupCta.props.onPress();
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(mockSendIntent).toHaveBeenCalledWith('android.settings.BIOMETRIC_ENROLL');

			// The existing retry affordance re-runs onConfirm reusing the same registrantId.
			const retryCta = tr.root.findByProps({testID: 'confirmation-retry-cta'});
			expect(retryCta).toBeDefined();
		});

		it('falls back to SECURITY_SETTINGS when BIOMETRIC_ENROLL intent fails', async () => {
			mockProduce.mockRejectedValueOnce({code: 'NO_BIOMETRICS_ENROLLED'});
			mockSendIntent.mockImplementationOnce(async () => {
				throw new Error('intent not resolvable');
			});

			const tr = renderScreen();
			await pressConfirm(tr);

			const setupCta = tr.root.findByProps({testID: 'confirmation-setup-cta'});
			await renderer.act(async () => {
				setupCta.props.onPress();
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(mockSendIntent).toHaveBeenNthCalledWith(1, 'android.settings.BIOMETRIC_ENROLL');
			expect(mockSendIntent).toHaveBeenNthCalledWith(2, 'android.settings.SECURITY_SETTINGS');
		});

		it("a transient-class code (e.g. LOCKOUT) renders the generic transient copy with a 'Try Again' retry", async () => {
			mockProduce.mockRejectedValueOnce({code: 'LOCKOUT'});

			const tr = renderScreen();
			await pressConfirm(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('Something went wrong verifying your device. Try again.');
			expect(text).toContain('Try Again');
			const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
			expect(cta).toBeDefined();
		});

		it('a terminal-class code (release build, __DEV__ false) renders the terminal wall with NO retry CTA', async () => {
			const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;
			(globalThis as {__DEV__?: boolean}).__DEV__ = false;
			mockProvisionDeviceKey.mockRejectedValueOnce({code: 'NO_STRONGBOX_OR_TEE'});

			const tr = renderScreen();
			await pressConfirm(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain("This device can't be used to vote");
			expect(tr.root.findAllByProps({testID: 'confirmation-confirm-face-id'})).toHaveLength(0);
			expect(tr.root.findAllByProps({testID: 'confirmation-retry-cta'})).toHaveLength(0);
			expect(tr.root.findAllByProps({testID: 'confirmation-setup-cta'})).toHaveLength(0);

			(globalThis as {__DEV__?: boolean}).__DEV__ = originalDev;
		});
	});
});
