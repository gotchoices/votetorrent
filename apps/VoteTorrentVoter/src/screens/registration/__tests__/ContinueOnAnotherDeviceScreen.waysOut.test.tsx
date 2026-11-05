/**
 * ContinueOnAnotherDeviceScreen ways out (initial/G5 WR-02, REVIEW/IN-10) and read-only key lookup on
 * re-open. Harness copied from ContinueOnAnotherDeviceScreen.test.tsx. S-2..S-5.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Keyboard, View} from 'react-native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from
import {REASSOCIATION_UNRESOLVED_REGISTRANT_ID} from '@votetorrent/vote-core';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockPopToTop = jest.fn();

type NavListener = (e: {preventDefault: () => void}) => void;
const navigationListeners: Record<string, NavListener[]> = {};
const mockAddListener = jest.fn((event: string, cb: NavListener) => {
	navigationListeners[event] = navigationListeners[event] ?? [];
	navigationListeners[event].push(cb);
	return () => {
		navigationListeners[event] = (navigationListeners[event] ?? []).filter(l => l !== cb);
	};
});
function fireBeforeRemove(): {defaultPrevented: boolean} {
	const state = {defaultPrevented: false};
	for (const cb of navigationListeners.beforeRemove ?? []) {
		cb({preventDefault: () => (state.defaultPrevented = true)});
	}
	return state;
}

let latestFocusCallback: (() => void) | null = null;

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		popToTop: mockPopToTop,
		addListener: mockAddListener,
	}),
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
			border: '#e0e0e0',
			card: '#ffffff',
			error: '#d32f2f',
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
		},
		radii: {pill: 999},
	}),
}));

const AUTHORITY_ID = 'auth-1';
const SEEDED_ELECTION_ID = 'election-1';
const P256_PUB = 'P256_NEW_DEVICE_PUB';

const mockGetDetails = jest.fn(async () => ({network: {primaryAuthorityId: AUTHORITY_ID}}));
const mockNetworkEngine = {getDetails: mockGetDetails};
const mockListAssociationRequests = jest.fn(async () => [] as unknown[]);
const mockAssociationEngine = {listAssociationRequests: mockListAssociationRequests};

const mockGetElections = jest.fn(async () => [] as Array<{id: string; date: number}>);

const mockGetEngine = jest.fn(async (engineName: string) => {
	if (engineName === 'network') return mockNetworkEngine;
	if (engineName === 'association') return mockAssociationEngine;
	if (engineName === 'elections') return {getElections: mockGetElections};
	throw new Error(`unexpected getEngine call: ${engineName}`);
});

const mockCreateNewIdentity = jest.fn(async (): Promise<void> => undefined);

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({
		createNewIdentity: mockCreateNewIdentity,
		getEngine: mockGetEngine,
		seededElectionId: SEEDED_ELECTION_ID,
	}),
}));

const mockProvisionDeviceKey = jest.fn(async () => ({publicKey: P256_PUB}));
const mockGetCurrentDeviceKey = jest.fn(async () => ({publicKey: P256_PUB}));
const mockProduce = jest.fn(async (challenge: {nonce: string}) => ({
	publicKey: P256_PUB,
	deviceId: 'DEVICE_ID',
	attestationTime: Date.now(),
	certificateChain: ['CERT'],
	platformDetails: {type: 'Android' as const, safetyNetAttestation: 'x', keystorePublicKey: P256_PUB, nonce: challenge.nonce},
}));
const mockSignDeviceKeyDigest = jest.fn(async (_digest: Uint8Array) => ({
	signerUserId: '',
	signerKey: P256_PUB,
	signature: 'p256-sig',
}));
const mockResolveAttestationProducer = jest.fn((..._args: unknown[]) => ({
	provisionDeviceKey: mockProvisionDeviceKey,
	getCurrentDeviceKey: mockGetCurrentDeviceKey,
	produce: mockProduce,
	signDeviceKeyDigest: mockSignDeviceKeyDigest,
}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: (...args: unknown[]) => mockResolveAttestationProducer(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const associationSubmitRequestCalls: any[] = [];
const mockAssociationSubmitRequest = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (init: any, requesterKey: string, signatureOrCallback: unknown, extras: unknown) => {
		associationSubmitRequestCalls.push({init, requesterKey, signatureOrCallback, extras});
		return init.id as string;
	},
);
const mockSubmitAttestation = jest.fn(async () => undefined);
let pollDecisionsImpl: (sinceCursor?: string) => Promise<unknown[]> = async () => [];
const mockPollDecisions = jest.fn((sinceCursor?: string) => pollDecisionsImpl(sinceCursor));

const mockTransports = {
	registrationTransport: {submitRequest: jest.fn(), pollDecisions: jest.fn(async () => [])},
	associationTransport: {
		submitRequest: mockAssociationSubmitRequest,
		submitAttestation: mockSubmitAttestation,
		pollDecisions: mockPollDecisions,
	},
	registrationRoute: 'peer' as const,
	ownAssociationRequestIds: jest.fn(async () => [] as string[]),
	ownStagedRegistrationRequestIds: jest.fn(async () => [] as string[]),
};

const mockResolveVoterRequestTransports = jest.fn(async (..._args: unknown[]): Promise<typeof mockTransports | undefined> => mockTransports);
jest.mock('../attach-voter-request-transport', () => ({
	resolveVoterRequestTransports: (...args: unknown[]) => mockResolveVoterRequestTransports(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ContinueOnAnotherDeviceScreen = require('../ContinueOnAnotherDeviceScreen').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {revealOffsetFor} = require('../ContinueOnAnotherDeviceScreen');

const renderedTrees: renderer.ReactTestRenderer[] = [];

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<ContinueOnAnotherDeviceScreen />);
	});
	renderedTrees.push(tr);
	return tr;
}

// Unmounts every tree rendered by a test (the screen registers AppState/Keyboard listeners on
// mount, per its own pending-ceremony polling contract) — never leaving one running into the
// next test avoids a "worker process failed to exit gracefully" warning from leaked listeners.
afterEach(() => {
	while (renderedTrees.length > 0) {
		const tr = renderedTrees.pop()!;
		renderer.act(() => {
			tr.unmount();
		});
	}
});

async function flush(times = 30) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

async function mountAndFlush(times = 30) {
	const tr = renderScreen();
	await renderer.act(async () => {
		await flush(times);
	});
	return tr;
}

beforeEach(() => {
	mockNavigate.mockClear();
	mockCreateNewIdentity.mockClear();
	mockGoBack.mockClear();
	mockPopToTop.mockClear();
	mockAddListener.mockClear();
	mockGetDetails.mockClear();
	mockListAssociationRequests.mockClear();
	mockListAssociationRequests.mockImplementation(async () => []);
	mockGetEngine.mockClear();
	mockProvisionDeviceKey.mockClear();
	mockGetCurrentDeviceKey.mockClear();
	mockProvisionDeviceKey.mockImplementation(async () => ({publicKey: P256_PUB}));
	mockProduce.mockClear();
	mockSignDeviceKeyDigest.mockClear();
	mockAssociationSubmitRequest.mockClear();
	mockSubmitAttestation.mockClear();
	mockSubmitAttestation.mockImplementation(async () => undefined);
	mockPollDecisions.mockClear();
	mockResolveVoterRequestTransports.mockClear();
	mockResolveVoterRequestTransports.mockImplementation(async () => mockTransports);
	associationSubmitRequestCalls.length = 0;
	navigationListeners.beforeRemove = [];
	navigationListeners.focus = [];
	latestFocusCallback = null;
	pollDecisionsImpl = async () => [];
});

const PENDING_ROW = {
	requestId: 'resumed-req-1',
	authorityId: AUTHORITY_ID,
	registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
	deviceKey: P256_PUB,
	status: 'p',
	submittedAt: '2026-01-01T00:00:00.000Z',
	receivedAt: '2026-01-01T00:00:01.000Z',
};

function identityError(reason: string): Error {
	return Object.assign(new Error(`device identity key unavailable (${reason})`), {
		name: 'DeviceIdentityKeyUnavailableError',
		reason,
	});
}

const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;
afterEach(() => {
	(globalThis as {__DEV__?: boolean}).__DEV__ = originalDev;
});

async function mountPendingWithAdvanceFailure(err: Error) {
	mockListAssociationRequests.mockImplementation(async () => [PENDING_ROW]);
	pollDecisionsImpl = async () => [{requestId: 'resumed-req-1', status: 'c', challengeNonce: 'nonce-1', cursor: '1'}];
	mockSubmitAttestation.mockRejectedValue(err);
	return mountAndFlush(60);
}

describe('ContinueOnAnotherDevice ways out', () => {
	it('S-2: pending + terminal failure: close renders, beforeRemove is not prevented, Back to Registration pops to root', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = false;
		const tr = await mountPendingWithAdvanceFailure(Object.assign(new Error('x'), {code: 'DEVICE_INTEGRITY_FAILED'}));
		expect(tr.root.findAllByProps({testID: 'continue-device-pending-error'}).length).toBeGreaterThan(0);
		expect(tr.root.findByProps({testID: 'continue-device-close'})).toBeDefined();
		expect(fireBeforeRemove().defaultPrevented).toBe(false);
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-back-to-registration'}).props.onPress();
		});
		expect(mockPopToTop).toHaveBeenCalledTimes(1);
	});

	it('S-3: pending without failure: a back gesture is prevented; Check Back Later pops to root through the guard', async () => {
		mockListAssociationRequests.mockImplementation(async () => [PENDING_ROW]);
		const tr = await mountAndFlush();
		expect(JSON.stringify(tr.toJSON())).toContain('Waiting for approval');
		expect(fireBeforeRemove().defaultPrevented).toBe(true);
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Check Back Later');
		expect(text).toContain('Your request stays with the authority');
		// React Navigation's popToTop emits `beforeRemove` on this screen; model that here so a guard
		// that swallows the intentional exit fails this test (REVIEW CR-R4-01).
		let popPrevented: boolean | null = null;
		mockPopToTop.mockImplementationOnce(() => {
			popPrevented = fireBeforeRemove().defaultPrevented;
		});
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-check-back-later'}).props.onPress();
		});
		expect(mockPopToTop).toHaveBeenCalledTimes(1);
		expect(popPrevented).toBe(false);
	});

	it('S-4: pending + identity-lost: recovery view AND Back to Registration; beforeRemove not prevented', async () => {
		const tr = await mountPendingWithAdvanceFailure(identityError('no-wrap-key'));
		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view').length).toBeGreaterThan(0);
		expect(fireBeforeRemove().defaultPrevented).toBe(false);
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-back-to-registration'}).props.onPress();
		});
		expect(mockPopToTop).toHaveBeenCalledTimes(1);
	});
});

describe('ContinueOnAnotherDevice re-open keeps the device key', () => {
	it('S-5: an existing key is read; provisionDeviceKey is never called; the pending request is found', async () => {
		mockListAssociationRequests.mockImplementation(async () => [PENDING_ROW]);
		const tr = await mountAndFlush();
		expect(mockGetCurrentDeviceKey).toHaveBeenCalled();
		expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
		expect(JSON.stringify(tr.toJSON())).toContain('Waiting for approval');
	});

	it('S-5: DEVICE_KEY_ABSENT from the read provisions exactly once', async () => {
		mockGetCurrentDeviceKey.mockRejectedValueOnce(Object.assign(new Error('absent'), {code: 'DEVICE_KEY_ABSENT'}));
		await mountAndFlush();
		expect(mockProvisionDeviceKey).toHaveBeenCalledTimes(1);
	});

	it('S-5: submitting evidence never provisions again once a key was resolved at mount', async () => {
		const tr = await mountAndFlush();
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush();
		});
		expect(mockAssociationSubmitRequest).toHaveBeenCalledTimes(1);
		expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
	});
});
