/**
 * Unit tests for ConfirmationScreen (REG-04/D-05) — the Face-ID confirming tap. Fully mocks
 * `@react-navigation/native` (spy-able `popToTop`), `providers/VotingAppProvider`,
 * `providers/RegistrationDraftProvider`, and `engines/device-user` so the real ceremony can be
 * exercised without a real navigator/provider/engine tree, mirroring Authority's
 * `NetworksScreen.bootstrap.test.tsx` full-replace mocking pattern.
 *
 * Phase 44-08 (the phase's capstone plan): the mock `setIsRegistered`/plain-`popToTop` assertions
 * are REPLACED by assertions on the real register -> issueAttestationChallenge -> setAttestation
 * (D-03 stub) -> associate-commit call ORDER, plus the success (clearDraft + popToTop) and
 * failure (error rendered, no clearDraft/popToTop) paths.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockPopToTop = jest.fn();

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

// ---- Mocked engine boundary (D-02/D-05): getEngine('network'|'registration'|'association') ----

const callOrder: string[] = [];

const mockGetDetails = jest.fn(async () => ({
	network: {primaryAuthorityId: 'authority-1'},
}));
const mockNetworkEngine = {getDetails: mockGetDetails};

const mockRegister = jest.fn(async () => {
	callOrder.push('register');
});
const mockRegistrationEngine = {register: mockRegister};

const CHALLENGE_NONCE = 'challenge-nonce-abc';
const mockIssueAttestationChallenge = jest.fn(async (registrantId: string, deviceKey: string) => {
	callOrder.push('issueAttestationChallenge');
	return {
		nonce: CHALLENGE_NONCE,
		authorityId: 'authority-1',
		registrantId,
		deviceKey,
		expiration: '2100-01-01T00:00:00Z',
	};
});

let capturedAttestation: unknown;
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
		setDeviceKey: jest.fn((_deviceKey: string) => builder),
		setNonce: jest.fn((_nonce: string) => builder),
		setAttestation: jest.fn((attestation: unknown) => {
			callOrder.push('setAttestation');
			capturedAttestation = attestation;
			return builder;
		}),
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

jest.mock('../../../providers/VotingAppProvider', () => ({
	useVotingApp: () => ({
		seededElectionId: 'election-1',
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

jest.mock('../../../providers/RegistrationDraftProvider', () => ({
	useRegistrationDraft: () => ({
		draft: sampleDraft,
		clearDraft: mockClearDraft,
	}),
}));

jest.mock('../../../engines/device-user', () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({
		id: 'device-user-1',
		name: 'Dev Voter',
		activeKeys: [{key: 'device-pub-key', type: 'mobile', expiration: 9999999999999}],
	})),
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

async function pressConfirm(tr: renderer.ReactTestRenderer) {
	const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
	await renderer.act(async () => {
		cta.props.onPress();
		// Flush the ceremony's chained microtasks (register -> challenge -> associate).
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
	callOrder.length = 0;
	capturedAttestation = undefined;
});

describe('ConfirmationScreen (REG-04/D-05)', () => {
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
		'pressing the CTA drives register -> issueAttestationChallenge -> setAttestation(stub) -> ' +
			'associate commit, then clears the draft and pops to top (D-05 confirming gesture)',
		async () => {
			const tr = renderScreen();
			await pressConfirm(tr);

			expect(callOrder).toEqual(['register', 'issueAttestationChallenge', 'setAttestation', 'associate.commit']);
			expect(mockClearDraft).toHaveBeenCalledTimes(1);
			expect(mockPopToTop).toHaveBeenCalledTimes(1);
			// The stub attestation passed to setAttestation must carry the challenge nonce (T-44-09).
			expect((capturedAttestation as {platformDetails: {nonce: string}}).platformDetails.nonce).toBe(
				CHALLENGE_NONCE,
			);
		},
	);

	it('renders an error and retry affordance when register() rejects — no clearDraft/popToTop', async () => {
		mockRegister.mockRejectedValueOnce(new Error('register failed: field policy violation'));

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('register failed: field policy violation');
		expect(text).toContain('Try Again');
		expect(mockClearDraft).not.toHaveBeenCalled();
		expect(mockPopToTop).not.toHaveBeenCalled();
		// The ceremony must not have proceeded past the failed step.
		expect(callOrder).toEqual([]);
	});

	it('renders an error and does not pop when a later step (associate commit) rejects', async () => {
		mockCommit.mockRejectedValueOnce(new Error('associate failed: attestation verification failed'));

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('associate failed: attestation verification failed');
		expect(mockClearDraft).not.toHaveBeenCalled();
		expect(mockPopToTop).not.toHaveBeenCalled();
		// The ceremony reached (and attempted) the associate commit before rejecting.
		expect(callOrder).toEqual(['register', 'issueAttestationChallenge', 'setAttestation']);
	});
});
