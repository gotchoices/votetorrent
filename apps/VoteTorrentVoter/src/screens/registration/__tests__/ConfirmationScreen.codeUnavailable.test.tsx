/**
 * ConfirmationScreen pending view: unavailable code handling (gap6/WR-07 same dead end, CU-1..CU-3).
 * Harness copied from ConfirmationScreen.test.tsx.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Linking, Platform} from 'react-native';
import i18n from '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockPopToTop = jest.fn();
const mockSendIntent = jest.fn(async (..._args: unknown[]) => undefined);

let latestFocusCallback: (() => void) | null = null;

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({popToTop: mockPopToTop}),
	useFocusEffect: (cb: () => void) => {
		latestFocusCallback = cb;
		// eslint-disable-next-line @typescript-eslint/no-var-requires, react-hooks/rules-of-hooks
		require('react').useEffect(() => {
			cb();
		}, [cb]);
	},
	useTheme: () => ({
		colors: {
			primary: '#2196f3',
			background: '#fbfbfb',
			text: '#000000',
			textSecondary: '#7d7d7d',
			light: '#ffffff',
			card: '#ffffff',
			link: '#0b5fff',
		},
		fonts: {
			regular: {fontFamily: 'System', fontWeight: '400'},
			medium: {fontFamily: 'System', fontWeight: '500'},
			bold: {fontFamily: 'System', fontWeight: '700'},
		},
		type: {
			h2: {fontSize: 28, lineHeight: 34},
			h4: {fontSize: 20, lineHeight: 26},
			body: {fontSize: 16, lineHeight: 22},
			caption: {fontSize: 16, lineHeight: 20},
			display: {fontSize: 40, lineHeight: 48},
		},
		radii: {pill: 999},
	}),
}));

// Route the public `Linking.sendIntent` through mockSendIntent. A jest.mock of the deep
// `react-native/Libraries/Linking/Linking` path stopped working on RN 0.79+ (internal modules
// moved to `export default`, so a factory without `default` yields an undefined Linking).

// ---- Mocked engine boundary: getEngine('network') ----

const callOrder: string[] = [];

const mockGetDetails = jest.fn(async () => ({
	network: {primaryAuthorityId: 'authority-1'},
}));
const mockNetworkEngine = {getDetails: mockGetDetails};

// Plan 28 (D-45) — the real `continuity.ts`'s `mintRegistrationCodeForSubmit` reaches
// getEngine('association').deriveRegistrationCode(registrantId, sign) directly.
const mockDeriveRegistrationCode = jest.fn(async (_registrantId: string, _sign: unknown) => 'ABCDE12345');
const mockAssociationEngine = {deriveRegistrationCode: mockDeriveRegistrationCode};

// 64 D-28: the election the registration binds to is read from the joined network's own list.
// Pushes NOTHING to callOrder, so the exact callOrder assertions stay unchanged.
const mockGetElections = jest.fn(async () => [] as Array<{id: string; date: number}>);

const mockGetEngine = jest.fn(async (engineName: string) => {
	if (engineName === 'network') {
		return mockNetworkEngine;
	}
	if (engineName === 'association') {
		return mockAssociationEngine;
	}
	if (engineName === 'elections') {
		return {getElections: mockGetElections};
	}
	throw new Error(`unexpected getEngine call: ${engineName}`);
});

const SEEDED_ELECTION_ID = 'election-1';
let mockSeededElectionId: string | undefined = SEEDED_ELECTION_ID;
const P256_PUB = 'P256_PUB';
const CHALLENGE_NONCE = 'challenge-nonce-abc';
const DEVICE_IDENTITY_PUBLIC_KEY = 'DEVICE_IDENTITY_SECP256K1_PUBLIC_KEY';

// The officer signer — must NEVER be passed to any transport mock (identity-compared, not a
// string check).
const mockSign = jest.fn(async () => ({
	signerUserId: 'device-user-1',
	signerKey: 'device-pub-key',
	signature: 'stub-officer-signature',
}));

// WR-02: the provider's explicit, user-confirmed identity replacement (re-runs the boot).
const mockCreateNewIdentity = jest.fn(async (): Promise<void> => undefined);

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({
		createNewIdentity: mockCreateNewIdentity,
		seededElectionId: mockSeededElectionId,
		// Kept on the provider mock (51-12 owns the provider blast radius) even though this
		// rewritten screen never destructures it — the point under test is that it is never REACHED,
		// not that the provider stopped exposing it.
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
	activeKeys: [{key: DEVICE_IDENTITY_PUBLIC_KEY, type: 'mobile', expiration: 9999999999999}],
}));
jest.mock('../../../engines/device-user', () => ({
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
}));

// The voter's OWN device signer (secp256k1, software) — distinct object identity from mockSign
// (the officer signer) even though both close over the same underlying key in the real app. This
// distinctness is exactly what the "never passes the officer signer" test proves.
const mockDeviceSign = jest.fn(async (_digest: Uint8Array) => ({
	signerUserId: 'device-user-1',
	signerKey: DEVICE_IDENTITY_PUBLIC_KEY,
	signature: 'device-identity-signature',
}));
const mockCreateDeviceSigner = jest.fn(async (..._args: unknown[]) => mockDeviceSign);
jest.mock('../../../engines/device-signer', () => ({
	createDeviceSigner: (...args: unknown[]) => mockCreateDeviceSigner(...args),
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
const mockSignDeviceKeyDigest = jest.fn(async (_digest: Uint8Array) => ({
	signerUserId: '',
	signerKey: P256_PUB,
	signature: 'p256-request-signature',
}));
const mockResolveAttestationProducer = jest.fn((..._args: unknown[]) => ({
	provisionDeviceKey: mockProvisionDeviceKey,
	produce: mockProduce,
	signDeviceKeyDigest: mockSignDeviceKeyDigest,
}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: (...args: unknown[]) => mockResolveAttestationProducer(...args),
}));

// ---- Mocked D-08 transport boundary: resolveVoterRequestTransports() ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registrationRequestInits: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registrationSubmitCalls: any[] = [];
const mockRegistrationSubmitRequest = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (init: any, requesterKey: string, signatureOrCallback: unknown, extras?: unknown) => {
		callOrder.push('registration.submitRequest');
		registrationRequestInits.push(init);
		registrationSubmitCalls.push({init, requesterKey, signatureOrCallback, extras});
		return init.id as string;
	},
);

let capturedAssociationRequestId: string | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const associationSubmitRequestCalls: any[] = [];
const mockAssociationSubmitRequest = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (init: any, requesterKey: string, signatureOrCallback: unknown) => {
		callOrder.push('association.submitRequest');
		capturedAssociationRequestId = init.id;
		associationSubmitRequestCalls.push({init, requesterKey, signatureOrCallback});
		return init.id as string;
	},
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const associationSubmitAttestationCalls: any[] = [];
const mockAssociationSubmitAttestation = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (answer: any, requesterKey: string, signatureOrCallback: unknown) => {
		callOrder.push('association.submitAttestation');
		associationSubmitAttestationCalls.push({answer, requesterKey, signatureOrCallback});
	},
);

const mockPollDecisions = jest.fn(async (_sinceCursor?: string) => {
	callOrder.push('association.pollDecisions');
	return [
		{
			requestId: capturedAssociationRequestId,
			status: 'c',
			challengeNonce: CHALLENGE_NONCE,
			cursor: 'cursor-1',
		},
	];
});

const mockRegistrationTransport = {
	submitRequest: mockRegistrationSubmitRequest,
	pollDecisions: jest.fn(async () => []),
};
const mockOwnAssociationRequestIds = jest.fn(async (_requesterKey: string) => [] as string[]);
const mockOwnStagedRegistrationRequestIds = jest.fn(async (_requesterKey: string) => [] as string[]);
const mockAssociationTransport = {
	submitRequest: mockAssociationSubmitRequest,
	submitAttestation: mockAssociationSubmitAttestation,
	pollDecisions: mockPollDecisions,
};

type ResolvedTransports = {
	registrationTransport: typeof mockRegistrationTransport;
	associationTransport: typeof mockAssociationTransport;
	registrationRoute: 'peer' | 'rest-bridge';
	ownAssociationRequestIds: typeof mockOwnAssociationRequestIds;
	ownStagedRegistrationRequestIds: typeof mockOwnStagedRegistrationRequestIds;
};
// Plan 28 (D-45): per-test route override — defaults to 'peer' (62-22's existing default).
let mockRegistrationRoute: 'peer' | 'rest-bridge' = 'peer';
// Phase 62 Plan 22 (D-28/D-32): the resolver is now ASYNC (`Promise<VoterRequestTransports |
// undefined>`), called with `{getEngine, authorityId}` rather than no arguments.
const mockResolveVoterRequestTransports = jest.fn(
	async (..._args: unknown[]): Promise<ResolvedTransports | undefined> => ({
		registrationTransport: mockRegistrationTransport,
		associationTransport: mockAssociationTransport,
		registrationRoute: mockRegistrationRoute,
		ownAssociationRequestIds: mockOwnAssociationRequestIds,
		ownStagedRegistrationRequestIds: mockOwnStagedRegistrationRequestIds,
	}),
);
jest.mock('../attach-voter-request-transport', () => ({
	resolveVoterRequestTransports: (...args: unknown[]) => mockResolveVoterRequestTransports(...args),
}));

// Plan 28 (D-45): mock `resolveRegistrationCodeAvailability` only — everything else (including
// the signer-propagation helper `mintRegistrationCodeForSubmit`, exercised for real against
// `mockAssociationEngine` above) comes from the real module.
const mockResolveRegistrationCodeAvailability = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (..._args: unknown[]): Promise<any> => ({kind: 'unavailable'}),
);
jest.mock('../../../engines/continuity', () => ({
	...jest.requireActual('../../../engines/continuity'),
	resolveRegistrationCodeAvailability: (...args: unknown[]) => mockResolveRegistrationCodeAvailability(...args),
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

/** Flushes chained microtasks. The rewritten ceremony has more awaited steps than the old one
 * (device signer resolution, two transport submits, a bounded decision poll, the attestation
 * submit), and the poll-exhaustion test drives up to MAX_POLL_ATTEMPTS (20) loop iterations — so
 * this flushes generously rather than counting exact ticks. */
async function flushMicrotasks(times = 60) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

async function pressConfirm(tr: renderer.ReactTestRenderer, testID = 'confirmation-confirm-face-id', flushes = 60) {
	const cta = tr.root.findByProps({testID});
	await renderer.act(async () => {
		cta.props.onPress();
		await flushMicrotasks(flushes);
	});
}

/**
 * 57-17/57-18 scroll-container gap closure (mirrors
 * apps/VoteTorrentAuthority/src/screens/settings/SettingsScreen.scrollContainer.test.tsx — the
 * canonical model). Walks the RENDERED react-test-renderer JSON tree looking for a host node
 * whose `type` is `RCTScrollView`, rather than grepping source text — a source grep would also
 * pass on an imported-but-unrendered or branch-only `ScrollView`, which is exactly the class of
 * gap 57-18's static gate cannot see (it only proves reachability at the JSX-source level, not
 * that a given SCREEN STATE still renders the container it started with).
 */
type TreeNode = {
	type: string;
	props: Record<string, unknown>;
	children: Array<TreeNode | string> | null;
};

function findHostNodeByType(json: unknown, targetType: string): TreeNode | null {
	if (json === null || json === undefined) return null;
	const nodes: unknown[] = Array.isArray(json) ? json : [json];
	for (const node of nodes) {
		if (node === null || typeof node !== 'object') continue;
		const typed = node as TreeNode;
		if (typed.type === targetType) {
			return typed;
		}
		if (typed.children) {
			const found = findHostNodeByType(typed.children, targetType);
			if (found) return found;
		}
	}
	return null;
}

beforeEach(() => {
	mockGetElections.mockReset();
	mockGetElections.mockImplementation(async () => []);
	mockPopToTop.mockClear();
	mockClearDraft.mockClear();
	mockSign.mockClear();
	mockCreateDeviceSigner.mockClear();
	mockDeviceSign.mockClear();
	mockGetOrCreateDeviceUser.mockClear();
	mockCreateNewIdentity.mockClear();
	mockSendIntent.mockClear();
	jest.spyOn(Linking, 'sendIntent').mockImplementation((...args: Parameters<typeof Linking.sendIntent>) => mockSendIntent(...args));
	mockProvisionDeviceKey.mockClear();
	mockProduce.mockClear();
	mockSignDeviceKeyDigest.mockClear();
	mockRegistrationSubmitRequest.mockClear();
	mockAssociationSubmitRequest.mockClear();
	mockAssociationSubmitAttestation.mockClear();
	mockPollDecisions.mockClear();
	mockResolveVoterRequestTransports.mockClear();
	mockOwnAssociationRequestIds.mockClear();
	mockOwnStagedRegistrationRequestIds.mockClear();
	mockDeriveRegistrationCode.mockClear();
	mockResolveRegistrationCodeAvailability.mockClear();
	mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'unavailable'}));
	mockRegistrationRoute = 'peer';

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
	mockPollDecisions.mockImplementation(async (_sinceCursor?: string) => {
		callOrder.push('association.pollDecisions');
		return [
			{
				requestId: capturedAssociationRequestId,
				status: 'c',
				challengeNonce: CHALLENGE_NONCE,
				cursor: 'cursor-1',
			},
		];
	});
	mockResolveVoterRequestTransports.mockImplementation(async () => ({
		registrationTransport: mockRegistrationTransport,
		associationTransport: mockAssociationTransport,
		registrationRoute: mockRegistrationRoute,
		ownAssociationRequestIds: mockOwnAssociationRequestIds,
		ownStagedRegistrationRequestIds: mockOwnStagedRegistrationRequestIds,
	}));

	callOrder.length = 0;
	capturedAssociationRequestId = undefined;
	registrationRequestInits.length = 0;
	registrationSubmitCalls.length = 0;
	associationSubmitRequestCalls.length = 0;
	associationSubmitAttestationCalls.length = 0;
	mockDraft = {...sampleDraft};
});


describe('ConfirmationScreen — unavailable registration code (CU)', () => {
	async function pend() {
		const tr = renderScreen();
		await pressConfirm(tr);
		await renderer.act(async () => {
			await flushMicrotasks(10);
		});
		return tr;
	}
	const count = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAllByProps({testID: id}).length;

	it('CU-1: read-failed renders the retryable text; Retry re-reads once and an available result renders the card', async () => {
		mockResolveRegistrationCodeAvailability.mockResolvedValueOnce({kind: 'unavailable', reason: 'read-failed', registrantKnown: true});
		const tr = await pend();
		expect(count(tr, 'confirmation-code-unavailable')).toBeGreaterThan(0);
		expect(JSON.stringify(tr.toJSON())).toContain('code.unavailable');
		expect(JSON.stringify(tr.toJSON())).toContain('code.retryButton');
		expect(count(tr, 'confirmation-pending')).toBeGreaterThan(0);

		const before = mockResolveRegistrationCodeAvailability.mock.calls.length;
		mockResolveRegistrationCodeAvailability.mockResolvedValueOnce({kind: 'available', code: 'ABCDE12345'});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'confirmation-code-retry'}).props.onPress();
			await flushMicrotasks(10);
		});
		expect(mockResolveRegistrationCodeAvailability.mock.calls.length).toBe(before + 1);
		expect(count(tr, 'confirmation-code-unavailable')).toBe(0);
		expect(JSON.stringify(tr.toJSON())).toContain('ABCDE-12345');
	});

	it('CU-2: holder-key-missing renders the existing not-available text, no Retry', async () => {
		mockResolveRegistrationCodeAvailability.mockResolvedValueOnce({kind: 'unavailable', reason: 'holder-key-missing', registrantKnown: true});
		const tr = await pend();
		expect(count(tr, 'confirmation-code-not-available')).toBeGreaterThan(0);
		expect(count(tr, 'confirmation-code-retry')).toBe(0);
	});

	it('CU-2: not-registered renders nothing in the code area (no continue-on-another-device link here)', async () => {
		mockResolveRegistrationCodeAvailability.mockResolvedValueOnce({kind: 'not-registered'});
		const tr = await pend();
		for (const id of ['confirmation-code-not-available', 'confirmation-code-unavailable', 'confirmation-code-retry', 'continue-device-entry-link']) {
			expect(count(tr, id)).toBe(0);
		}
	});

	it('CU-3: an unavailable result with no reason renders nothing in the code area', async () => {
		mockResolveRegistrationCodeAvailability.mockResolvedValueOnce({kind: 'unavailable'});
		const tr = await pend();
		for (const id of ['confirmation-code-not-available', 'confirmation-code-unavailable', 'confirmation-code-retry']) {
			expect(count(tr, id)).toBe(0);
		}
		expect(count(tr, 'confirmation-pending')).toBeGreaterThan(0);
	});
});
