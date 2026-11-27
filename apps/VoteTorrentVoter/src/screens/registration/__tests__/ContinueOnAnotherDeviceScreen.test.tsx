/**
 * Unit tests for ContinueOnAnotherDeviceScreen (62-UI-SPEC Surfaces 8/9, D-40/D-41/D-43/D-45).
 * Mocks `@react-navigation/native`, `providers/VoterAppProvider`, `./attach-voter-request-transport`
 * and `engines/attestation-producer` — mirrors `ConfirmationScreen.test.tsx`'s full-replace mocking
 * pattern. Uses the REAL `engines/continuity.ts` so the screen is proven against it, not a stand-in.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Keyboard, Platform, View} from 'react-native';
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
let mockSeededElectionId: string | undefined = SEEDED_ELECTION_ID;
const P256_PUB = 'P256_NEW_DEVICE_PUB';

const mockGetDetails = jest.fn(async () => ({network: {primaryAuthorityId: AUTHORITY_ID}}));
const mockNetworkEngine = {getDetails: mockGetDetails};
const mockListAssociationRequests = jest.fn(async () => [] as unknown[]);
const mockAssociationEngine = {listAssociationRequestsByDeviceKey: mockListAssociationRequests};

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
		seededElectionId: mockSeededElectionId,
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
const ORIGINAL_PLATFORM_OS = Platform.OS;
afterEach(() => {
	Object.defineProperty(Platform, 'OS', {value: ORIGINAL_PLATFORM_OS, configurable: true});
	while (renderedTrees.length > 0) {
		const tr = renderedTrees.pop()!;
		renderer.act(() => {
			tr.unmount();
		});
	}
});

async function flush(times = 60) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

async function mountAndFlush(times = 60) {
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
	mockGetElections.mockReset();
	mockGetElections.mockImplementation(async () => []);
	mockSeededElectionId = SEEDED_ELECTION_ID;
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

describe('ContinueOnAnotherDeviceScreen — default branch (Surface 8, D-45)', () => {
	it('mounts with resume fresh: renders the title, code field, submit button, both links, and the close control; every Pressable resolves minHeight >= 44', async () => {
		const tr = await mountAndFlush();

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Continue on This Device');
		expect(text).toContain('Enter your code');
		expect(text).toContain('Continue with Code');
		expect(text).toContain("I don't have my code");
		expect(text).toContain('My registration is still pending');

		expect(tr.root.findByProps({testID: 'continue-device-close'})).toBeDefined();

		// Bootstrap READS the current key first and creates one only when none exists
		// (isDeviceKeyAbsent); provisioning on every mount minted a new Android key and orphaned the
		// pending request (initial/G5 WR-02 way-out fix, attestation-producer.ts:80). Two reads: one
		// bootstrap read + one resume read through resolveReassociationResume.
		expect(mockProvisionDeviceKey).toHaveBeenCalledTimes(0);
		expect(mockGetCurrentDeviceKey).toHaveBeenCalledTimes(2);

		const pressables = [
			'continue-device-close',
			'continue-device-code-submit',
			'continue-device-lost-code-link',
			'continue-device-restart-link',
		];
		for (const testID of pressables) {
			const node = tr.root.findByProps({testID});
			const style = Object.assign({}, ...[].concat(node.props.style ?? []));
			expect(style.minHeight).toBeGreaterThanOrEqual(44);
		}
	});

	it('code required: submitting an empty code shows codeRequired and makes zero submitRequest calls', async () => {
		const tr = await mountAndFlush();
		const submit = tr.root.findByProps({testID: 'continue-device-code-submit'});
		await renderer.act(async () => {
			submit.props.onPress();
			await flush();
		});
		expect(JSON.stringify(tr.toJSON())).toContain('Enter your registration code to continue.');
		expect(mockAssociationSubmitRequest).not.toHaveBeenCalled();
	});

	it('code submit (D-40/D-45): a valid code calls submitRequest once with the sentinel registrantId, the P-256 key, and normalized extras; lands on pending with no close control', async () => {
		const tr = await mountAndFlush();
		const input = tr.root.findByProps({testID: 'continue-device-code-input'});
		renderer.act(() => {
			input.props.onChangeText('wwwww-wwwww');
		});
		const submit = tr.root.findByProps({testID: 'continue-device-code-submit'});
		await renderer.act(async () => {
			submit.props.onPress();
			await flush();
		});

		expect(mockAssociationSubmitRequest).toHaveBeenCalledTimes(1);
		const call = associationSubmitRequestCalls[0];
		expect(call.init.registrantId).toBe(REASSOCIATION_UNRESOLVED_REGISTRANT_ID);
		expect(call.requesterKey).toBe(P256_PUB);
		expect(call.init.deviceKey).toBe(P256_PUB);
		expect(call.extras).toEqual({registrationCode: 'WWWWWWWWWW'});
		expect('identityFields' in call.extras).toBe(false);

		expect(JSON.stringify(tr.toJSON())).toContain('Waiting for approval');
		expect(tr.root.findAllByProps({testID: 'continue-device-close'})).toHaveLength(0);

		const prevented = fireBeforeRemove();
		expect(prevented.defaultPrevented).toBe(true);
	});
});

describe('ContinueOnAnotherDeviceScreen — fresh device key (63-18 never mint twice)', () => {
	it('no key yet: provisions exactly once at bootstrap; the resume lookup only reads', async () => {
		mockGetCurrentDeviceKey.mockRejectedValueOnce(Object.assign(new Error('absent'), {code: 'DEVICE_KEY_ABSENT'}));
		await mountAndFlush();
		expect(mockProvisionDeviceKey).toHaveBeenCalledTimes(1);
		expect(mockGetCurrentDeviceKey).toHaveBeenCalledTimes(2);
	});
});

describe('ContinueOnAnotherDeviceScreen — identity fallback (D-45)', () => {
	async function openIdentityBranch(tr: renderer.ReactTestRenderer) {
		const lostCode = tr.root.findByProps({testID: 'continue-device-lost-code-link'});
		await renderer.act(async () => {
			lostCode.props.onPress();
			await flush();
		});
	}

	it('tapping lostCodeLink renders the identity heading/body, eight fields, submit and backToCodeLink', async () => {
		const tr = await mountAndFlush();
		await openIdentityBranch(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Confirm Your Identity');
		expect(text).toContain('Submit for Review');
		expect(text).toContain('Use my code instead');
		for (const field of [
			'First Name',
			'Last Name',
			'MM/DD/YYYY',
			'Email',
			'Phone Number',
			'Address line 1',
			'Address line 2 (optional)',
			'Address line 3 (optional)',
		]) {
			expect(text).toContain(field);
		}
	});

	it('an empty first/last name shows the shared required error and makes zero submit calls', async () => {
		const tr = await mountAndFlush();
		await openIdentityBranch(tr);
		const submit = tr.root.findByProps({testID: 'continue-device-identity-submit'});
		await renderer.act(async () => {
			submit.props.onPress();
			await flush();
		});
		expect(JSON.stringify(tr.toJSON())).toContain('This field is required');
		expect(mockAssociationSubmitRequest).not.toHaveBeenCalled();
	});

	it('a valid submit sends identityFields extras only (no registrationCode key)', async () => {
		const tr = await mountAndFlush();
		await openIdentityBranch(tr);

		renderer.act(() => tr.root.findByProps({testID: 'continue-device-identity-firstName-input'}).props.onChangeText('Jane'));
		renderer.act(() => tr.root.findByProps({testID: 'continue-device-identity-lastName-input'}).props.onChangeText('Doe'));

		const submit = tr.root.findByProps({testID: 'continue-device-identity-submit'});
		await renderer.act(async () => {
			submit.props.onPress();
			await flush();
		});

		expect(mockAssociationSubmitRequest).toHaveBeenCalledTimes(1);
		const call = associationSubmitRequestCalls[0];
		expect(call.extras).toEqual({identityFields: [{name: 'firstName', value: 'Jane'}, {name: 'lastName', value: 'Doe'}]});
		expect('registrationCode' in call.extras).toBe(false);
	});

	it('backToCodeLink returns to the code branch', async () => {
		const tr = await mountAndFlush();
		await openIdentityBranch(tr);
		const back = tr.root.findByProps({testID: 'continue-device-back-to-code-link'});
		renderer.act(() => {
			back.props.onPress();
		});
		expect(JSON.stringify(tr.toJSON())).toContain('Registration Code');
	});
});

describe('ContinueOnAnotherDeviceScreen — restart (D-43)', () => {
	it('tapping restartLink renders the restart branch; confirm navigates to DeviceAttestation and submits nothing', async () => {
		const tr = await mountAndFlush();
		const restartLink = tr.root.findByProps({testID: 'continue-device-restart-link'});
		await renderer.act(async () => {
			restartLink.props.onPress();
			await flush();
		});

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Start a New Registration');
		expect(text).toContain('Start New Registration');

		const confirm = tr.root.findByProps({testID: 'continue-device-restart-confirm'});
		renderer.act(() => {
			confirm.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('DeviceAttestation');
		expect(mockAssociationSubmitRequest).not.toHaveBeenCalled();
	});
});

describe('ContinueOnAnotherDeviceScreen — challenge, approved, rejected', () => {
	async function submitCode(tr: renderer.ReactTestRenderer) {
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush();
		});
	}

	it('a challenge notice drives exactly one produce + one submitAttestation, then an approved notice renders the approved CTA calling popToTop()', async () => {
		let call = 0;
		pollDecisionsImpl = async () => {
			call += 1;
			if (call === 1) return [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'c', challengeNonce: 'nonce-1', cursor: '1'}];
			return [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'a', cursor: '2'}];
		};

		const tr = await mountAndFlush();
		await submitCode(tr);
		await renderer.act(async () => {
			await flush(60);
		});

		expect(mockProduce).toHaveBeenCalledTimes(1);
		expect(mockSubmitAttestation).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(tr.toJSON())).toContain('Device approved');

		const continueCta = tr.root.findByProps({testID: 'continue-device-approved-continue'});
		renderer.act(() => {
			continueCta.props.onPress();
		});
		expect(mockPopToTop).toHaveBeenCalledTimes(1);
	});

	it('a rejected notice renders the rejected heading (colors.error) and body, with no submit/retry Pressable and the close control back', async () => {
		pollDecisionsImpl = async () => [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'r', cursor: '1'}];

		const tr = await mountAndFlush();
		await submitCode(tr);
		await renderer.act(async () => {
			await flush(60);
		});

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Request not approved');
		expect(text).toContain('was not approved');
		expect(tr.root.findAllByProps({testID: 'continue-device-retry'})).toHaveLength(0);
		expect(tr.root.findByProps({testID: 'continue-device-close'})).toBeDefined();
	});
});

describe('ContinueOnAnotherDeviceScreen — resume', () => {
	it('an own sentinel "p" row mounts straight into pending without ever calling submitRequest; refocusing re-runs the poll', async () => {
		mockListAssociationRequests.mockImplementation(async () => [
			{
				requestId: 'resumed-req-1',
				authorityId: AUTHORITY_ID,
				registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
				deviceKey: P256_PUB,
				status: 'p',
				submittedAt: '2026-01-01T00:00:00.000Z',
				receivedAt: '2026-01-01T00:00:01.000Z',
			},
		]);

		const tr = await mountAndFlush();
		expect(JSON.stringify(tr.toJSON())).toContain('Waiting for approval');
		expect(mockAssociationSubmitRequest).not.toHaveBeenCalled();

		const callsBefore = mockPollDecisions.mock.calls.length;
		await renderer.act(async () => {
			latestFocusCallback?.();
			await flush();
		});
		expect(mockPollDecisions.mock.calls.length).toBeGreaterThan(callsBefore);
	});
});

describe('ContinueOnAnotherDeviceScreen — failures', () => {
	it('an undefined transport resolver renders submitError and keeps the code branch', async () => {
		mockResolveVoterRequestTransports.mockResolvedValueOnce(undefined);
		const tr = await mountAndFlush();
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush();
		});
		expect(JSON.stringify(tr.toJSON())).toContain('Could not send your request');
		// Stays in the code branch — the submit control is still present and pressable.
		expect(() => tr.root.findByProps({testID: 'continue-device-code-submit'})).not.toThrow();
	});

	it('a submitRequest rejecting with {code: "no-recipients"} renders submitError, and a retry with the SAME code passes the SAME init object (toBe) to submitRequest', async () => {
		mockAssociationSubmitRequest.mockRejectedValueOnce({code: 'no-recipients'});

		const tr = await mountAndFlush();
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush();
		});
		expect(JSON.stringify(tr.toJSON())).toContain('Could not send your request');

		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush();
		});
		// .mock.calls records BOTH invocations (the rejected-once call and the real retry) even
		// though the rejected-once call never reaches the jest.fn()'s own wrapped implementation
		// (and so never pushes into associationSubmitRequestCalls) — read args from .mock.calls
		// directly to prove the SAME init object (not merely equal ids) was reused.
		expect(mockAssociationSubmitRequest).toHaveBeenCalledTimes(2);
		const firstInit = mockAssociationSubmitRequest.mock.calls[0][0];
		const secondInit = mockAssociationSubmitRequest.mock.calls[1][0];
		expect(firstInit).toBe(secondInit);
	});

	it('a recoverable-action failure names Face ID on ios', async () => {
		Object.defineProperty(Platform, 'OS', {value: 'ios', configurable: true});
		mockProduce.mockRejectedValueOnce({code: 'NO_BIOMETRICS_ENROLLED'});
		pollDecisionsImpl = async () => [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'c', challengeNonce: 'nonce-1', cursor: '1'}];

		const tr = await mountAndFlush();
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush(60);
		});

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Set up Face ID to continue');
		expect(text).not.toContain('fingerprint');
	});

	it("a produce() failure classified 'recoverable-action' renders the setup prompt + setupCta and a retryButton retry", async () => {
		Object.defineProperty(Platform, 'OS', {value: 'android', configurable: true});
		mockProduce.mockRejectedValueOnce({code: 'NO_BIOMETRICS_ENROLLED'});
		pollDecisionsImpl = async () => [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'c', challengeNonce: 'nonce-1', cursor: '1'}];

		const tr = await mountAndFlush();
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush(60);
		});

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Set up fingerprint or face unlock to continue');
		expect(tr.root.findByProps({testID: 'continue-device-setup-cta'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'continue-device-retry'})).toBeDefined();
	});


	it("an IntakeError while advancing renders the intake-unavailable copy (not device blame, not the pending heading) with a retryButton retry", async () => {
		mockSubmitAttestation.mockRejectedValueOnce(
			Object.assign(new Error('createIntakeSealer.seal: no-recipients'), {name: 'IntakeError', code: 'no-recipients'}),
		);
		pollDecisionsImpl = async () => [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'c', challengeNonce: 'nonce-1', cursor: '1'}];

		const tr = await mountAndFlush();
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush(60);
		});

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("We couldn't send your registration to the authority right now. Try again later.");
		expect(text).not.toContain('Something went wrong verifying your device');
		expect(text).not.toContain('no-recipients');
		expect(tr.root.findAllByProps({testID: 'continue-device-pending-heading'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'continue-device-setup-cta'})).toHaveLength(0);
		expect(tr.root.findByProps({testID: 'continue-device-retry'})).toBeDefined();
	});
});

describe("ContinueOnAnotherDeviceScreen — 'identity-lost' (WR-02)", () => {
	function identityError(reason: string): Error {
		return Object.assign(new Error(`device identity key unavailable (${reason})`), {
			name: 'DeviceIdentityKeyUnavailableError',
			reason,
		});
	}

	async function submitCode(tr: renderer.ReactTestRenderer) {
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush(60);
		});
	}

	it('a lost identity while advancing renders the identity recovery view (no transient copy, no retry), and Create -> Confirm calls createNewIdentity once', async () => {
		mockSubmitAttestation.mockRejectedValueOnce(identityError('no-wrap-key'));
		pollDecisionsImpl = async () => [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'c', challengeNonce: 'nonce-1', cursor: '1'}];

		const tr = await mountAndFlush();
		await submitCode(tr);

		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view').length).toBeGreaterThan(0);
		const text = JSON.stringify(tr.toJSON());
		expect(text).not.toContain('Something went wrong verifying your device');
		expect(text).not.toContain('no-wrap-key');
		expect(tr.root.findAllByProps({testID: 'continue-device-retry'})).toHaveLength(0);

		renderer.act(() => {
			tr.root.findByProps({testID: 'identity-recovery-create'}).props.onPress();
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'identity-recovery-confirm'}).props.onPress();
			await flush(5);
		});
		expect(mockCreateNewIdentity).toHaveBeenCalledTimes(1);
	});

	it('a lost identity on submit renders the same recovery view, not the generic submit error', async () => {
		mockAssociationSubmitRequest.mockRejectedValueOnce(identityError('key-mismatch'));

		const tr = await mountAndFlush();
		await submitCode(tr);

		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view').length).toBeGreaterThan(0);
	});

	it('a transient identity reason while advancing keeps the transient copy and the retry', async () => {
		mockSubmitAttestation.mockRejectedValueOnce(identityError('native-error'));
		pollDecisionsImpl = async () => [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'c', challengeNonce: 'nonce-1', cursor: '1'}];

		const tr = await mountAndFlush();
		await submitCode(tr);

		expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view')).toHaveLength(0);
		expect(JSON.stringify(tr.toJSON())).toContain('Something went wrong verifying your device');
		expect(tr.root.findByProps({testID: 'continue-device-retry'})).toBeDefined();
	});
});

describe('ContinueOnAnotherDeviceScreen — IME geometry', () => {
	const SHOW_EVENT = 'keyboardWillChangeFrame';
	const HIDE_EVENT = 'keyboardWillHide';
	let handlers: Record<string, (event?: unknown) => void>;

	beforeEach(() => {
		handlers = {};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		jest.spyOn(Keyboard, 'addListener').mockImplementation(((e: string, cb: any) => {
			handlers[e] = cb;
			return {remove: jest.fn()};
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	function rootPadding(tr: renderer.ReactTestRenderer): number {
		const style = tr.root.findAllByType(View)[0].props.style;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return Object.assign({}, ...([] as any[]).concat(style).map((s: unknown) => s ?? {})).paddingBottom;
	}

	it('grows the root paddingBottom by exactly the reported keyboard height', async () => {
		const tr = await mountAndFlush();
		const resting = rootPadding(tr);
		renderer.act(() => handlers[SHOW_EVENT]?.({endCoordinates: {height: 300}}));
		expect(rootPadding(tr)).toBe(resting + 300);
	});

	it('restores the resting padding on dismiss', async () => {
		const tr = await mountAndFlush();
		const resting = rootPadding(tr);
		renderer.act(() => handlers[SHOW_EVENT]?.({endCoordinates: {height: 300}}));
		renderer.act(() => handlers[HIDE_EVENT]?.());
		expect(rootPadding(tr)).toBe(resting);
	});

	it('revealOffsetFor: focusing the code field scrolls so the field stays within the shrunken viewport', async () => {
		const tr = await mountAndFlush();
		const scroll = tr.root.findByProps({testID: 'continue-device-scroll'});
		renderer.act(() => {
			scroll.props.onLayout({nativeEvent: {layout: {height: 420, width: 300, x: 0, y: 0}}});
		});
		const field = tr.root.findByProps({testID: 'continue-device-code-field'});
		renderer.act(() => {
			field.props.onLayout({nativeEvent: {layout: {y: 520, height: 56, width: 280, x: 0}}});
		});

		const input = tr.root.findByProps({testID: 'continue-device-code-input'});
		renderer.act(() => {
			input.props.onFocus();
		});

		const y = revealOffsetFor({fieldY: 520, fieldHeight: 56, viewportHeight: 420, margin: 16});
		expect(520 - y).toBeGreaterThanOrEqual(0);
		expect(520 + 56 - y).toBeLessThanOrEqual(420);
	});
});

describe('ContinueOnAnotherDeviceScreen — current election (D-28)', () => {
	const g = globalThis as {__DEV__?: boolean};
	const originalDev = g.__DEV__;
	afterEach(() => {
		g.__DEV__ = originalDev;
	});

	async function submitCode(tr: renderer.ReactTestRenderer) {
		renderer.act(() => {
			tr.root.findByProps({testID: 'continue-device-code-input'}).props.onChangeText('wwwww-wwwww');
		});
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'continue-device-code-submit'}).props.onPress();
			await flush(120);
		});
	}

	function challengeOnce() {
		let call = 0;
		pollDecisionsImpl = async () => {
			call += 1;
			if (call === 1) return [{requestId: associationSubmitRequestCalls[0]?.init.id, status: 'c', challengeNonce: 'nonce-1', cursor: '1'}];
			return [];
		};
	}

	it('a joined network (no seed) submits and answers with the listed election, reading it once', async () => {
		g.__DEV__ = false;
		mockSeededElectionId = undefined;
		mockGetElections.mockImplementation(async () => [{id: 'joined-election-7', date: Date.now() + 86_400_000}]);
		challengeOnce();

		const tr = await mountAndFlush();
		await submitCode(tr);

		expect(associationSubmitRequestCalls[0].init.electionId).toBe('joined-election-7');
		expect(mockProduce).toHaveBeenCalledTimes(1);
		expect(mockProduce.mock.calls[0][0]).toMatchObject({electionId: 'joined-election-7'});
		expect(mockGetElections).toHaveBeenCalledTimes(1);
	});

	it('release build with a seed and an empty list omits electionId (OQ10) and still reaches pending', async () => {
		g.__DEV__ = false;
		challengeOnce();

		const tr = await mountAndFlush();
		await submitCode(tr);

		expect(associationSubmitRequestCalls[0].init).not.toHaveProperty('electionId');
		expect((mockProduce.mock.calls[0][0] as {electionId?: string}).electionId).toBeUndefined();
		expect(JSON.stringify(tr.toJSON())).toContain('Waiting for approval');
	});

	it('a dev build with an empty list keeps the seed (dev parity)', async () => {
		g.__DEV__ = true;

		const tr = await mountAndFlush();
		await submitCode(tr);

		expect(associationSubmitRequestCalls[0].init.electionId).toBe(SEEDED_ELECTION_ID);
	});

	it('a rejected election read on submit shows the submit error, leaks nothing and submits nothing', async () => {
		g.__DEV__ = true;
		mockGetElections.mockImplementation(async () => {
			throw Object.assign(new Error('peer-xyz unreachable'), {name: 'PeerUnavailableError'});
		});
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const tr = await mountAndFlush();
			await submitCode(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(tr.root.findByProps({testID: 'continue-device-submit-error'})).toBeDefined();
			expect(text).toContain('Could not send your request');
			expect(text).not.toContain('peer-xyz');
			expect(mockAssociationSubmitRequest).not.toHaveBeenCalled();
			const submitCalls = errorSpy.mock.calls.filter(c => c[0] === 'ContinueOnAnotherDeviceScreen: submit failed:');
			expect(submitCalls).toEqual([['ContinueOnAnotherDeviceScreen: submit failed:', 'PeerUnavailableError']]);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('resuming an own pending row while the election read rejects shows the pending error and never polls or prompts', async () => {
		g.__DEV__ = true;
		mockListAssociationRequests.mockImplementation(async () => [
			{
				requestId: 'resumed-req-1',
				authorityId: AUTHORITY_ID,
				registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
				deviceKey: P256_PUB,
				status: 'p',
				submittedAt: '2026-01-01T00:00:00.000Z',
				receivedAt: '2026-01-01T00:00:01.000Z',
			},
		]);
		mockGetElections.mockImplementation(async () => {
			throw new Error('read failed');
		});
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const tr = await mountAndFlush(120);
			expect(tr.root.findByProps({testID: 'continue-device-pending-error'})).toBeDefined();
			expect(mockPollDecisions).not.toHaveBeenCalled();
			expect(mockProduce).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});
});
