/**
 * Unit tests for ConfirmationScreen (D-01/D-02/D-03/D-05/D-07/D-08/D-09/D-11/D-12/D-18) — the
 * Face-ID confirming tap. Fully mocks `@react-navigation/native` (spy-able `popToTop`),
 * `providers/VoterAppProvider`, `providers/RegistrationDraftProvider`, `engines/device-user`,
 * `engines/device-signer`, `engines/attestation-producer` (D-11 two-step seam), and
 * `./attach-voter-request-transport` so the rewritten ceremony can be exercised without a real
 * navigator/provider/engine tree or a real network, mirroring Authority's full-replace mocking
 * pattern.
 *
 * Plan 11 — asserts the REWRITTEN ceremony: the screen submits a self-signed registration-request
 * document and a self-signed association-request document (never `register()`/
 * `issueAttestationChallenge()`/`associate()`/`.commit()`), polls (bounded) for a challenge-issued
 * decision notice, still runs `producer.produce(challenge)` in the same biometric-last position,
 * then submits a self-signed attestation-answer document — all through mocked
 * `IRegistrationRequestTransport`/`IAssociationRequestTransport` interfaces, never a concrete
 * binding. The officer signer (`useVoterApp().sign`) must never be passed to any transport mock,
 * proven by IDENTITY comparison, not a string/name check.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Linking, Platform, Text} from 'react-native';
import i18n from '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockPopToTop = jest.fn();
const mockSendIntent = jest.fn(async (..._args: unknown[]) => undefined);

let latestFocusCallback: (() => void) | null = null;

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({popToTop: mockPopToTop}),
	useFocusEffect: (cb: () => void) => {
		latestFocusCallback = cb;
		// eslint-disable-next-line @typescript-eslint/no-var-requires, react-hooks/rules-of-hooks
		require('react').useEffect(() => cb(), [cb]);
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
// Read-only lookup a retry uses to confirm the attempt's key is still there (spike 104).
const mockGetCurrentDeviceKey = jest.fn(async () => {
	callOrder.push('getCurrentDeviceKey');
	return {publicKey: P256_PUB};
});
const mockResolveAttestationProducer = jest.fn((..._args: unknown[]) => ({
	provisionDeviceKey: mockProvisionDeviceKey,
	getCurrentDeviceKey: mockGetCurrentDeviceKey,
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
const mockResolveRegistrationStatus = jest.fn(async (..._args: unknown[]) => ({kind: 'pending'}));
jest.mock('../../../engines/registration-status', () => ({
	resolveRegistrationStatus: (...args: unknown[]) => mockResolveRegistrationStatus(...args),
}));
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	pollForNotice,
	decisionWaitClock,
	DECISION_WAIT_DEADLINE_MS,
	DECISION_POLL_INTERVAL_MS,
	DECISION_WAIT_MAX_MS,
} = require('../ConfirmationScreen');

/** Awaits microtasks until `predicate` holds; a named failure after `maxTicks`. */
async function flushUntil(predicate: () => boolean, maxTicks = 5000) {
	for (let i = 0; i < maxTicks; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(`flushUntil: the predicate never held within ${maxTicks} microtask ticks`);
}

/**
 * An instant decision wait over a virtual clock: `sleep` returns at once and moves the clock, so
 * the 180 s deadline is reached without any real or faked timer. Returns its restore function.
 */
function installInstantDecisionWait() {
	let virtualNow = 1_000_000;
	const clock = decisionWaitClock as {now(): number; sleep(ms: number): Promise<void>};
	const nowSpy = jest.spyOn(clock, 'now').mockImplementation(() => virtualNow);
	const sleepSpy = jest.spyOn(clock, 'sleep').mockImplementation(async (ms: number) => {
		virtualNow += ms;
	});
	return () => {
		nowSpy.mockRestore();
		sleepSpy.mockRestore();
	};
}

/** The label of a pressable whose only text child is its label. */
function labelOf(node: renderer.ReactTestInstance): unknown {
	return node.findByType(Text).props.children;
}

/** `mockPollDecisions` with a loose notice type, for the cases that script their own notices. */
const looseMockPollDecisions = mockPollDecisions as unknown as jest.Mock<Promise<unknown[]>, [string?]>;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {promise, resolve, reject};
}

/** Local console spy: the shared Voter console-leak helper arrives with a later plan. */
function spyAllConsole() {
	const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => ({
		method,
		spy: jest.spyOn(console, method).mockImplementation(() => undefined),
	}));
	return {
		calls: () => spies.flatMap(({method, spy}) => spy.mock.calls.map(args => ({method, args}))),
		restore: () => spies.forEach(({spy}) => spy.mockRestore()),
	};
}

// D-100: a pending screen holds a 10 s outcome-poll interval; every tree is unmounted after each
// test so none outlives it (an unmount clears the interval, so jest can exit).
const renderedTrees: renderer.ReactTestRenderer[] = [];
afterEach(() => {
	while (renderedTrees.length > 0) {
		const tr = renderedTrees.pop()!;
		try {
			renderer.act(() => {
				tr.unmount();
			});
		} catch {
			// already unmounted by the test
		}
	}
});

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<ConfirmationScreen />);
	});
	renderedTrees.push(tr);
	return tr;
}

/** Flushes chained microtasks. The rewritten ceremony has more awaited steps than the old one
 * (device signer resolution, two transport submits, a bounded decision poll, the attestation
 * submit), and the decision wait polls on a clock, not a fixed attempt count — so this flushes
 * generously rather than counting exact ticks. */
async function flushMicrotasks(times = 60) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

async function pressConfirm(tr: renderer.ReactTestRenderer, testID = 'confirmation-confirm-face-id', flushes = 120) {
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
	mockResolveRegistrationStatus.mockReset();
	mockResolveRegistrationStatus.mockImplementation(async () => ({kind: 'pending'}));
	mockClearDraft.mockClear();
	mockSign.mockClear();
	mockCreateDeviceSigner.mockClear();
	mockDeviceSign.mockClear();
	mockGetOrCreateDeviceUser.mockClear();
	mockCreateNewIdentity.mockClear();
	mockSendIntent.mockClear();
	jest.spyOn(Linking, 'sendIntent').mockImplementation((...args: Parameters<typeof Linking.sendIntent>) => mockSendIntent(...args));
	mockProvisionDeviceKey.mockClear();
	mockGetCurrentDeviceKey.mockClear();
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
	mockGetCurrentDeviceKey.mockImplementation(async () => {
		callOrder.push('getCurrentDeviceKey');
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

describe('ConfirmationScreen (D-01/D-02/D-03/D-05/D-07/D-08/D-09/D-11/D-12/D-18)', () => {
	it("renders the 'You're all set!' heading and the confirm CTA", () => {
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("You're all set!");

		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		expect(cta).toBeDefined();
	});

	describe('platform-appropriate biometric copy', () => {
		const originalOS = Platform.OS;
		afterEach(() => {
			Object.defineProperty(Platform, 'OS', {value: originalOS, configurable: true});
		});

		it('iOS keeps the Face ID framing', () => {
			Object.defineProperty(Platform, 'OS', {value: 'ios', configurable: true});
			const text = JSON.stringify(renderScreen().toJSON());
			expect(text).toContain('Confirm your registration with Face ID');
			expect(text).toContain('Look at your device to confirm');
			expect(text).toContain('Confirm with Face ID');
		});

		it('Android never mentions Face ID — fingerprint / face unlock framing instead', () => {
			Object.defineProperty(Platform, 'OS', {value: 'android', configurable: true});
			const text = JSON.stringify(renderScreen().toJSON());
			expect(text).not.toContain('Face ID');
			expect(text).not.toContain('Look at your device');
			expect(text).toContain('Confirm your registration with your fingerprint or face unlock');
			expect(text).toContain('Follow the prompt on your device to confirm');
			expect(text).toContain('Confirm with biometrics');
		});
	});

	describe('localized pending + retry copy (no hard-coded English)', () => {
		afterEach(async () => {
			await renderer.act(async () => {
				await i18n.changeLanguage('en');
			});
		});

		it('en: the pending text and the retry label come from the bundle', async () => {
			const ok = renderScreen();
			await pressConfirm(ok);
			expect(JSON.stringify(ok.toJSON())).toContain(
				'Your registration has been submitted. This screen updates when the election office approves your device.',
			);

			mockProduce.mockRejectedValueOnce({code: 'LOCKOUT'});
			const failed = renderScreen();
			await pressConfirm(failed);
			expect(JSON.stringify(failed.toJSON())).toContain('Try Again');
		});

		it('es: the pending text and the retry label render in Spanish', async () => {
			await renderer.act(async () => {
				await i18n.changeLanguage('es');
			});
			const ok = renderScreen();
			await pressConfirm(ok);
			const okText = JSON.stringify(ok.toJSON());
			expect(okText).toContain('Tu registro se envió. Esta pantalla se actualiza cuando la oficina electoral apruebe tu dispositivo.');
			expect(okText).not.toContain('Your registration has been submitted');

			mockProduce.mockRejectedValueOnce({code: 'LOCKOUT'});
			const failed = renderScreen();
			await pressConfirm(failed);
			const failedText = JSON.stringify(failed.toJSON());
			expect(failedText).toContain('Intentar de nuevo');
			expect(failedText).not.toContain('Try Again');
		});
	});

	it('does NOT navigate on mount (only on the deliberate press)', () => {
		renderScreen();
		// D-100 replacing 51-11: no popToTop until Done or Back to registration is pressed.
		expect(mockPopToTop).not.toHaveBeenCalled();
	});

	it(
		'pressing the CTA drives: registration submitRequest -> association submitRequest -> ' +
			'pollDecisions (challenge issued) -> produce -> submitAttestation, in that exact order, ' +
			'each exactly once, then shows the pending state (D-05/D-11/D-18)',
		async () => {
			const tr = renderScreen();
			await pressConfirm(tr);

			expect(callOrder).toEqual([
				'provisionDeviceKey',
				'registration.submitRequest',
				'association.submitRequest',
				'association.pollDecisions',
				'produce',
				'association.submitAttestation',
			]);
			expect(mockRegistrationSubmitRequest).toHaveBeenCalledTimes(1);
			expect(mockAssociationSubmitRequest).toHaveBeenCalledTimes(1);
			expect(mockPollDecisions).toHaveBeenCalledTimes(1);
			expect(mockProduce).toHaveBeenCalledTimes(1);
			expect(mockAssociationSubmitAttestation).toHaveBeenCalledTimes(1);

			// Order is also proven via jest's own invocation-call-order counters, not merely the
			// hand-rolled log above.
			const orders = [
				mockRegistrationSubmitRequest.mock.invocationCallOrder[0],
				mockAssociationSubmitRequest.mock.invocationCallOrder[0],
				mockPollDecisions.mock.invocationCallOrder[0],
				mockProduce.mock.invocationCallOrder[0],
				mockAssociationSubmitAttestation.mock.invocationCallOrder[0],
			];
			expect(orders).toEqual([...orders].sort((a, b) => a - b));

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('submitted');
			expect(mockClearDraft).toHaveBeenCalledTimes(1);
			// D-100 (replacing 51-11's no-popToTop pin): reaching pending does not pop by itself;
			// popToTop runs only when Done or Back to registration is pressed.
			expect(mockPopToTop).not.toHaveBeenCalled();
		},
	);

	it('never passes the officer signer (useVoterApp().sign) to any transport mock — identity, not string, comparison (D-01/D-07)', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		const allArgs = [
			...registrationSubmitCalls.flatMap(c => [c.requesterKey, c.signatureOrCallback]),
			...associationSubmitRequestCalls.flatMap(c => [c.requesterKey, c.signatureOrCallback]),
			...associationSubmitAttestationCalls.flatMap(c => [c.requesterKey, c.signatureOrCallback]),
		];
		expect(allArgs).not.toContain(mockSign);
		expect(mockSign).not.toHaveBeenCalled();
	});

	it('binds the association request to the P-256 provisioned key, never the secp256k1 device identity key (D-02/D-03)', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		expect(associationSubmitRequestCalls).toHaveLength(1);
		expect(associationSubmitRequestCalls[0].init.deviceKey).toBe(P256_PUB);
		expect(associationSubmitRequestCalls[0].requesterKey).toBe(P256_PUB);
		expect(associationSubmitRequestCalls[0].init.deviceKey).not.toBe(DEVICE_IDENTITY_PUBLIC_KEY);
	});

	it('threads seededElectionId onto the association request and the registration payload (D-11/D-10)', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		expect(associationSubmitRequestCalls[0].init.electionId).toBe(SEEDED_ELECTION_ID);
		expect(registrationRequestInits[0].payload.electionId).toBe(SEEDED_ELECTION_ID);
	});

	it('the transport resolver returning undefined (no delivery path, D-28) surfaces the generic failure class and does not crash', async () => {
		mockResolveVoterRequestTransports.mockResolvedValueOnce(undefined);

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		expect(mockRegistrationSubmitRequest).not.toHaveBeenCalled();
		expect(mockClearDraft).not.toHaveBeenCalled();
	});

	it("the transport resolver rejecting with {code: 'no-recipients'} (D-32/D-04 zero recipients) surfaces the same generic failure class", async () => {
		mockResolveVoterRequestTransports.mockRejectedValueOnce({code: 'no-recipients'});

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		expect(mockRegistrationSubmitRequest).not.toHaveBeenCalled();
		expect(mockClearDraft).not.toHaveBeenCalled();
	});

	it('a vote-engine IntakeError from submitRequest surfaces the intake-unavailable copy (never device blame, never raw text) with a retry', async () => {
		const intakeError = Object.assign(new Error('createIntakeSealer.seal: no-recipients'), {
			name: 'IntakeError',
			code: 'no-recipients',
		});
		mockRegistrationSubmitRequest.mockRejectedValueOnce(intakeError);

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("We couldn't send your registration to the authority right now. Try again later.");
		expect(text).not.toContain('Something went wrong verifying your device');
		expect(text).not.toContain('no-recipients');
		expect(text).not.toContain('createIntakeSealer');
		expect(tr.root.findByProps({testID: 'confirmation-confirm-face-id'})).toBeDefined();
		expect(text).toContain('Try Again');
		expect(mockClearDraft).not.toHaveBeenCalled();
		// D-100 replacing 51-11: no popToTop until Done or Back to registration is pressed.
		expect(mockPopToTop).not.toHaveBeenCalled();
	});

	it('classifyAttestationFailure maps NoElectionConfiguredError to no-election and leaves IntakeError alone', () => {
		const {classifyAttestationFailure} = require('../../../engines/attestation-failure');
		expect(classifyAttestationFailure(Object.assign(new Error('x'), {name: 'NoElectionConfiguredError'}))).toBe('no-election');
		expect(classifyAttestationFailure(Object.assign(new Error('x'), {name: 'IntakeError', code: 'no-recipients'}))).toBe(
			'intake-unavailable',
		);
	});

	it('no election on this phone shows its own copy, never device blame, and never touches the device key', async () => {
		mockSeededElectionId = undefined;
		try {
			const tr = renderScreen();
			await pressConfirm(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('There is no election to register for on this phone yet.');
			expect(text).not.toContain('verifying your device');
			expect(text).not.toContain("This device can't be used to vote");
			expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
			// Retrying cannot help: no retry CTA, no retry label.
			expect(tr.root.findAllByProps({testID: 'confirmation-confirm-face-id'}).length).toBe(0);
			expect(text).not.toContain('Try Again');
		} finally {
			mockSeededElectionId = SEEDED_ELECTION_ID;
		}
	});

	it('a pollDecisions that never yields a challenge-issued notice before the deadline surfaces the decision-timeout copy', async () => {
		mockPollDecisions.mockImplementation(async () => {
			callOrder.push('association.pollDecisions');
			return [];
		});
		const restore = installInstantDecisionWait();
		try {
			const tr = renderScreen();
			await renderer.act(async () => {
				tr.root.findByProps({testID: 'confirmation-confirm-face-id'}).props.onPress();
				await flushUntil(() => mockPollDecisions.mock.calls.length >= Math.ceil(DECISION_WAIT_DEADLINE_MS / DECISION_POLL_INTERVAL_MS));
				await flushMicrotasks(60);
			});

			const timeoutCopy = i18n.getFixedT('en', 'registration')('confirmation.error.decisionTimeout');
			expect(timeoutCopy).not.toBe('confirmation.error.decisionTimeout');
			expect(tr.root.findByProps({testID: 'confirmation-error'}).props.children).toBe(timeoutCopy);
			expect(JSON.stringify(tr.toJSON())).not.toContain('Something went wrong verifying your device. Try again.');
			expect(mockProduce).not.toHaveBeenCalled();
			expect(mockAssociationSubmitAttestation).not.toHaveBeenCalled();
			expect(mockClearDraft).not.toHaveBeenCalled();
			// Bounded by the deadline, not by an attempt count.
			expect(mockPollDecisions.mock.calls.length).toBe(Math.ceil(DECISION_WAIT_DEADLINE_MS / DECISION_POLL_INTERVAL_MS));
		} finally {
			restore();
		}
	});

	it('a produce() rejection surfaces the generic failure class and submitAttestation is NOT called', async () => {
		mockProduce.mockRejectedValueOnce(new Error('produce failed: attestation error'));

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		expect(mockAssociationSubmitAttestation).not.toHaveBeenCalled();
		expect(mockClearDraft).not.toHaveBeenCalled();
		// D-100 replacing 51-11: no popToTop until Done or Back to registration is pressed.
		expect(mockPopToTop).not.toHaveBeenCalled();
	});

	it('reuses the same registration-request id across a retry (WR-02 — no duplicate/orphaned rows)', async () => {
		// First attempt: both requests submit fine but the attestation-answer submit rejects, so the
		// ceremony fails mid-flight and the CTA becomes "Try Again".
		mockAssociationSubmitAttestation.mockRejectedValueOnce(new Error('submitAttestation failed: transient'));

		const tr = renderScreen();
		await pressConfirm(tr); // attempt 1 — both submits + poll + produce ok, submitAttestation fails
		await pressConfirm(tr, 'confirmation-confirm-face-id'); // attempt 2 — retry of the SAME submission

		expect(registrationRequestInits).toHaveLength(2);
		expect(registrationRequestInits[0].id).toBe(registrationRequestInits[1].id);
		expect(associationSubmitRequestCalls).toHaveLength(2);
		expect(associationSubmitRequestCalls[0].init.id).toBe(associationSubmitRequestCalls[1].init.id);
		expect(associationSubmitRequestCalls[0].init.registrantId).toBe(associationSubmitRequestCalls[1].init.registrantId);
	});

	// Spike 104: on Android `provisionDeviceKey` mints a NEW key every call, so a retry that
	// re-provisioned would re-submit the cached association request (naming the old key) signed by a
	// key it does not name. A retry keeps the attempt's key; only a gone or changed key starts over.
	describe('retry keeps the attempt key (spike 104)', () => {
		it('a retry reads the key back and never re-provisions while it is unchanged', async () => {
			mockAssociationSubmitAttestation.mockRejectedValueOnce(new Error('submitAttestation failed: transient'));

			const tr = renderScreen();
			await pressConfirm(tr); // attempt 1 fails at the answer submit
			await pressConfirm(tr, 'confirmation-confirm-face-id'); // attempt 2

			expect(mockProvisionDeviceKey).toHaveBeenCalledTimes(1);
			expect(mockGetCurrentDeviceKey).toHaveBeenCalledTimes(1);
			expect(associationSubmitRequestCalls[1].init).toBe(associationSubmitRequestCalls[0].init);
			expect(associationSubmitRequestCalls[1].requesterKey).toBe(P256_PUB);
		});

		it.each([
			['a different key under the alias', async () => ({publicKey: 'P256_PUB_ROTATED'})],
			['DEVICE_KEY_ABSENT', async () => Promise.reject(Object.assign(new Error('absent'), {code: 'DEVICE_KEY_ABSENT'}))],
			['DEVICE_KEY_INVALIDATED', async () => Promise.reject(Object.assign(new Error('invalidated'), {code: 'DEVICE_KEY_INVALIDATED'}))],
		])('%s: re-provisions and makes a NEW association request for the new key, keeping the registration request', async (_name, lookup) => {
			mockAssociationSubmitAttestation.mockRejectedValueOnce(new Error('submitAttestation failed: transient'));
			const tr = renderScreen();
			await pressConfirm(tr); // attempt 1

			mockGetCurrentDeviceKey.mockImplementationOnce(lookup as () => Promise<{publicKey: string}>);
			mockProvisionDeviceKey.mockImplementationOnce(async () => ({publicKey: 'P256_PUB_NEW'}));
			await pressConfirm(tr, 'confirmation-confirm-face-id'); // attempt 2

			expect(mockProvisionDeviceKey).toHaveBeenCalledTimes(2);
			expect(registrationRequestInits[1]).toBe(registrationRequestInits[0]);
			const [first, second] = associationSubmitRequestCalls;
			expect(second.init).not.toBe(first.init);
			expect(second.init.id).not.toBe(first.init.id);
			expect(second.init.deviceKey).toBe('P256_PUB_NEW');
			expect(second.requesterKey).toBe('P256_PUB_NEW');
			expect(second.init.registrantId).toBe(first.init.registrantId);
		});

		it('any other lookup failure fails the attempt without minting a new key', async () => {
			mockAssociationSubmitAttestation.mockRejectedValueOnce(new Error('submitAttestation failed: transient'));
			const tr = renderScreen();
			await pressConfirm(tr); // attempt 1

			mockGetCurrentDeviceKey.mockImplementationOnce(async () =>
				Promise.reject(Object.assign(new Error('read failed'), {code: 'DEVICE_KEY_READ_FAILED'})),
			);
			await pressConfirm(tr, 'confirmation-confirm-face-id'); // attempt 2

			expect(mockProvisionDeviceKey).toHaveBeenCalledTimes(1);
			expect(associationSubmitRequestCalls).toHaveLength(1);
			expect(JSON.stringify(tr.toJSON())).toContain('Try Again');
		});
	});

	it(
		'idempotent retry (D-05/D-32): a failure before the deadline, then a successful retry, re-submits the ' +
			'SAME registration and association init objects (not merely equal ids), with identical submittedAt',
		async () => {
			// Attempt 1: EVERY poll call returns [] (never a challenge-issued notice), so the wait runs
			// to its deadline (instant virtual clock) and the attempt fails with the decision-timeout copy.
			mockPollDecisions.mockImplementation(async () => {
				callOrder.push('association.pollDecisions');
				return [];
			});
			const restore = installInstantDecisionWait();
			let tr!: renderer.ReactTestRenderer;
			try {
				tr = renderScreen();
				await renderer.act(async () => {
					tr.root.findByProps({testID: 'confirmation-confirm-face-id'}).props.onPress();
					await flushUntil(() => mockPollDecisions.mock.calls.length >= Math.ceil(DECISION_WAIT_DEADLINE_MS / DECISION_POLL_INTERVAL_MS));
					await flushMicrotasks(60);
				}); // attempt 1 — the wait runs out

				const timeoutCopy = i18n.getFixedT('en', 'registration')('confirmation.error.decisionTimeout');
				expect(timeoutCopy).not.toBe('confirmation.error.decisionTimeout');
				expect(tr.root.findByProps({testID: 'confirmation-error'}).props.children).toBe(timeoutCopy);
				expect(mockPollDecisions.mock.calls.length).toBe(Math.ceil(DECISION_WAIT_DEADLINE_MS / DECISION_POLL_INTERVAL_MS));
			} finally {
				restore();
			}

			// Attempt 2 ("Try Again"): restore the default pollDecisions implementation (the 'c'
			// notice), so the retry completes to the pending state.
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
			await pressConfirm(tr, 'confirmation-confirm-face-id'); // attempt 2 — retry succeeds

			const text2 = JSON.stringify(tr.toJSON());
			expect(text2).toContain('submitted');

			expect(registrationRequestInits).toHaveLength(2);
			// Object IDENTITY (toBe), not merely equal fields — the exact same init object is
			// re-submitted on retry.
			expect(registrationRequestInits[0]).toBe(registrationRequestInits[1]);
			expect(registrationRequestInits[0].submittedAt).toBe(registrationRequestInits[1].submittedAt);

			expect(associationSubmitRequestCalls).toHaveLength(2);
			expect(associationSubmitRequestCalls[0].init).toBe(associationSubmitRequestCalls[1].init);
			expect(associationSubmitRequestCalls[0].init.submittedAt).toBe(associationSubmitRequestCalls[1].init.submittedAt);
		},
	);

	it('does not furnish a blank required field on the registration payload (WR-04 — empty required rejected by policy)', async () => {
		// A blank required private field (email) must NOT be furnished as {name:'email', value:''}
		// — that would satisfy the engine's name-presence check and slip past policy. With the
		// empty entry dropped, email is genuinely absent, so validateFieldPolicy rejects it.
		mockDraft = {...sampleDraft, email: '', phone: ''};

		const tr = renderScreen();
		await pressConfirm(tr);

		expect(registrationRequestInits).toHaveLength(1);
		const details = registrationRequestInits[0].payload.private.details as Array<{name: string; value: string}>;
		const names = details.map(d => d.name);
		expect(names).not.toContain('email');
		expect(names).not.toContain('phone');
		// No furnished detail is ever an empty-valued placeholder.
		expect(details.every(d => d.value !== '')).toBe(true);
	});

	describe('D-09 three-way failure UX', () => {
		const originalOS = Platform.OS;
		afterEach(() => {
			Object.defineProperty(Platform, 'OS', {value: originalOS, configurable: true});
		});

		it('NO_BIOMETRICS_ENROLLED names Face ID on ios', async () => {
			Object.defineProperty(Platform, 'OS', {value: 'ios', configurable: true});
			mockProduce.mockRejectedValueOnce({code: 'NO_BIOMETRICS_ENROLLED'});
			const tr = renderScreen();
			await pressConfirm(tr);
			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('Set up Face ID to continue');
			expect(text).not.toContain('fingerprint');
		});

		it('NO_BIOMETRICS_ENROLLED renders the setup prompt + deep-link CTA, and a separate retry — no clearDraft/popToTop', async () => {
			Object.defineProperty(Platform, 'OS', {value: 'android', configurable: true});
			mockProduce.mockRejectedValueOnce({code: 'NO_BIOMETRICS_ENROLLED'});

			const tr = renderScreen();
			await pressConfirm(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('Set up fingerprint or face unlock to continue');
			expect(text).toContain('Set up device unlock');
			expect(mockClearDraft).not.toHaveBeenCalled();
			// D-100 replacing 51-11: no popToTop until Done or Back to registration is pressed.
			expect(mockPopToTop).not.toHaveBeenCalled();

			const setupCta = tr.root.findByProps({testID: 'confirmation-setup-cta'});
			await renderer.act(async () => {
				setupCta.props.onPress();
				await flushMicrotasks(10);
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
				await flushMicrotasks(10);
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

		describe("'identity-lost' — the identity can no longer be unwrapped (WR-02)", () => {
			const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;
			afterEach(() => {
				(globalThis as {__DEV__?: boolean}).__DEV__ = originalDev;
			});

			function identityError(reason: string): Error {
				return Object.assign(new Error(`device identity key unavailable (${reason})`), {
					name: 'DeviceIdentityKeyUnavailableError',
					reason,
				});
			}

			// 62-REVIEW WR-04: this is the REAL provider's release state. Outside __DEV__ the provider
			// never writes seededElectionId (only the dev seed does), so it is undefined here, and the
			// permanent reason comes from where production raises it: createDeviceSigner's unwrap
			// (getOrCreateDeviceUser returns the wrapped record without unwrapping). The identity is
			// read before the election and network preconditions, so the voter meets the recovery
			// view, never the no-election copy that would otherwise hide the loss.
			it('release build (__DEV__ false, no seeded election): a lost identity read from createDeviceSigner renders the recovery view before any precondition, and Create -> Confirm calls createNewIdentity once', async () => {
				(globalThis as {__DEV__?: boolean}).__DEV__ = false;
				mockSeededElectionId = undefined;
				mockCreateDeviceSigner.mockRejectedValueOnce(identityError('no-wrap-key'));
				try {
					const tr = renderScreen();
					await pressConfirm(tr);

					expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view').length).toBeGreaterThan(0);
					const text = JSON.stringify(tr.toJSON());
					expect(text).not.toContain('There is no election to register for on this phone yet.');
					expect(text).not.toContain('Something went wrong verifying your device');
					expect(text).not.toContain('no-wrap-key');
					expect(text).not.toContain('DeviceIdentityKeyUnavailableError');
					expect(tr.root.findAllByProps({testID: 'confirmation-confirm-face-id'})).toHaveLength(0);
					expect(tr.root.findAllByProps({testID: 'confirmation-retry-cta'})).toHaveLength(0);
					expect(tr.root.findAllByProps({testID: 'confirmation-error'})).toHaveLength(0);
					expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
					expect(mockCreateDeviceSigner).toHaveBeenCalledWith('Device User');
					// Nothing after the identity read ran: no hardware key, no network, no transport.
					expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
					expect(mockResolveVoterRequestTransports).not.toHaveBeenCalled();
					expect(mockRegistrationSubmitRequest).not.toHaveBeenCalled();

					renderer.act(() => {
						tr.root.findByProps({testID: 'identity-recovery-create'}).props.onPress();
					});
					expect(mockCreateNewIdentity).not.toHaveBeenCalled();
					await renderer.act(async () => {
						tr.root.findByProps({testID: 'identity-recovery-confirm'}).props.onPress();
						await flushMicrotasks(5);
					});
					expect(mockCreateNewIdentity).toHaveBeenCalledTimes(1);
				} finally {
					mockSeededElectionId = SEEDED_ELECTION_ID;
				}
			});

			it('release build, readable identity, no seeded election: the identity read runs (no prompt) and the no-election copy still shows', async () => {
				(globalThis as {__DEV__?: boolean}).__DEV__ = false;
				mockSeededElectionId = undefined;
				try {
					const tr = renderScreen();
					await pressConfirm(tr);

					const text = JSON.stringify(tr.toJSON());
					expect(text).toContain('There is no election to register for on this phone yet.');
					expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view')).toHaveLength(0);
					expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
					expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
					expect(mockProduce).not.toHaveBeenCalled();
				} finally {
					mockSeededElectionId = SEEDED_ELECTION_ID;
				}
			});

			it.each(['tag-mismatch', 'key-mismatch'])('__DEV__ true: %s also renders the recovery view', async reason => {
				(globalThis as {__DEV__?: boolean}).__DEV__ = true;
				mockGetOrCreateDeviceUser.mockRejectedValueOnce(identityError(reason));

				const tr = renderScreen();
				await pressConfirm(tr);

				expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view').length).toBeGreaterThan(0);
			});

			it('a transient identity reason keeps the generic transient copy and its Try Again', async () => {
				(globalThis as {__DEV__?: boolean}).__DEV__ = false;
				mockGetOrCreateDeviceUser.mockRejectedValueOnce(identityError('wrap-unavailable'));

				const tr = renderScreen();
				await pressConfirm(tr);

				const text = JSON.stringify(tr.toJSON());
				expect(text).toContain('Something went wrong verifying your device. Try again.');
				expect(text).toContain('Try Again');
				expect(tr.root.findAll(n => n.props.testID === 'identity-recovery-view')).toHaveLength(0);
				expect(tr.root.findByProps({testID: 'confirmation-confirm-face-id'})).toBeDefined();
			});
		});

		it('a terminal-class code (release build, __DEV__ false) renders the terminal wall with NO retry CTA', async () => {
			const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;
			(globalThis as {__DEV__?: boolean}).__DEV__ = false;
			// 64 D-28: a release build no longer honours the dev seed, so the joined network must list
			// the election for the ceremony to reach the device key.
			mockGetElections.mockImplementation(async () => [{id: 'joined-election-7', date: Date.now() + 86_400_000}]);
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

describe('ConfirmationScreen — registration code on submit (D-45)', () => {
	it('peer route: deriveRegistrationCode is called once with (registrantId, the device signer), and submitRequest receives 4 arguments, the 4th deep-equal {registrationCode}', async () => {
		mockRegistrationRoute = 'peer';
		const tr = renderScreen();
		await pressConfirm(tr);

		expect(mockDeriveRegistrationCode).toHaveBeenCalledTimes(1);
		const registrantId = registrationRequestInits[0].id;
		expect(mockDeriveRegistrationCode).toHaveBeenCalledWith(registrantId, mockDeviceSign);

		expect(mockRegistrationSubmitRequest).toHaveBeenCalledTimes(1);
		const call = mockRegistrationSubmitRequest.mock.calls[0];
		expect(call).toHaveLength(4);
		expect(call[3]).toEqual({registrationCode: 'ABCDE12345'});
	});

	it("peer route retry: after a failed attempt, \"Try Again\" does NOT re-derive the code, and the 4th argument deep-equals the first attempt's", async () => {
		mockRegistrationRoute = 'peer';
		mockAssociationSubmitAttestation.mockRejectedValueOnce(new Error('submitAttestation failed: transient'));
		const tr = renderScreen();
		await pressConfirm(tr); // attempt 1 — both submits + mint ok, submitAttestation fails
		await pressConfirm(tr, 'confirmation-confirm-face-id'); // attempt 2 — retry

		expect(mockDeriveRegistrationCode).toHaveBeenCalledTimes(1);
		expect(mockRegistrationSubmitRequest).toHaveBeenCalledTimes(2);
		expect(mockRegistrationSubmitRequest.mock.calls[0][3]).toEqual(mockRegistrationSubmitRequest.mock.calls[1][3]);
	});

	it('REST bridge route: deriveRegistrationCode is never called and submitRequest is called with exactly 3 arguments', async () => {
		mockRegistrationRoute = 'rest-bridge';
		const tr = renderScreen();
		await pressConfirm(tr);

		expect(mockDeriveRegistrationCode).not.toHaveBeenCalled();
		expect(mockRegistrationSubmitRequest).toHaveBeenCalledTimes(1);
		expect(mockRegistrationSubmitRequest.mock.calls[0]).toHaveLength(3);
	});

	it('a rejecting deriveRegistrationCode renders the transient error, with the retry CTA, and makes zero submitRequest calls', async () => {
		mockRegistrationRoute = 'peer';
		mockDeriveRegistrationCode.mockRejectedValueOnce(new Error('derive failed'));
		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		expect(cta).toBeDefined();
		expect(mockRegistrationSubmitRequest).not.toHaveBeenCalled();
	});
});

describe('ConfirmationScreen — registration code card (D-45)', () => {
	it('available: the card renders AFTER the pending text, inside the same RCTScrollView (never replacing it)', async () => {
		mockResolveRegistrationCodeAvailability.mockResolvedValue({kind: 'available', code: 'ABCDE12345'});
		const tr = renderScreen();
		await pressConfirm(tr);
		await renderer.act(async () => {
			await flushMicrotasks(10);
		});

		const text = JSON.stringify(tr.toJSON());
		const pendingIdx = text.indexOf('submitted');
		const codeIdx = text.indexOf('ABCDE-12345');
		expect(pendingIdx).toBeGreaterThan(-1);
		expect(codeIdx).toBeGreaterThan(pendingIdx);

		const scrollNode = findHostNodeByType(tr.toJSON(), 'RCTScrollView');
		expect(scrollNode).not.toBeNull();
	});

	it('not-sent / not-holder: no card renders; code.notAvailableOnDevice renders in its place', async () => {
		mockResolveRegistrationCodeAvailability.mockResolvedValueOnce({kind: 'not-sent'});
		const tr = renderScreen();
		await pressConfirm(tr);
		await renderer.act(async () => {
			await flushMicrotasks(10);
		});

		expect(tr.root.findByProps({testID: 'confirmation-code-not-available'})).toBeDefined();
		expect(tr.root.findAllByProps({testID: 'registration-code-value'})).toHaveLength(0);
	});

	it('unavailable / not-registered: neither the card nor the notAvailableOnDevice notice renders', async () => {
		mockResolveRegistrationCodeAvailability.mockResolvedValueOnce({kind: 'unavailable'});
		const tr = renderScreen();
		await pressConfirm(tr);
		await renderer.act(async () => {
			await flushMicrotasks(10);
		});

		expect(tr.root.findAllByProps({testID: 'confirmation-code-not-available'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'registration-code-value'})).toHaveLength(0);
	});

	it('re-firing the focus callback re-calls the resolver', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);
		const callsBefore = mockResolveRegistrationCodeAvailability.mock.calls.length;
		await renderer.act(async () => {
			latestFocusCallback?.();
			await flushMicrotasks(10);
		});
		expect(mockResolveRegistrationCodeAvailability.mock.calls.length).toBeGreaterThan(callsBefore);
	});
});

describe('ConfirmationScreen — scroll container regression guard (57-17/57-18)', () => {
	it('Test 1: the default (pre-submit) state renders a real RCTScrollView host node as its outermost scrollable', () => {
		const tr = renderScreen();
		const scrollNode = findHostNodeByType(tr.toJSON(), 'RCTScrollView');
		expect(scrollNode).not.toBeNull();
	});

	it('Test 2 (anti-vacuity): the walker returns null against a View-only synthetic tree', () => {
		const syntheticTree = {
			type: 'View',
			props: {},
			children: [
				{type: 'View', props: {}, children: null},
				{type: 'View', props: {}, children: [{type: 'View', props: {}, children: null}]},
			],
		};
		expect(findHostNodeByType(syntheticTree, 'RCTScrollView')).toBeNull();
	});

	it('Test 3: the reachable "confirmation-pending" branch still renders inside the RCTScrollView after a successful submit', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		// Confirm the pending testID actually rendered (precondition — otherwise Test 3 would be
		// vacuously true if the ceremony silently failed to reach the pending branch).
		const pendingNode = tr.root.findByProps({testID: 'confirmation-pending'});
		expect(pendingNode).toBeDefined();

		const scrollNode = findHostNodeByType(tr.toJSON(), 'RCTScrollView');
		expect(scrollNode).not.toBeNull();
	});

	it('Test 4: the reachable "confirmation-error" (transient failure) branch still renders inside the RCTScrollView', async () => {
		mockProduce.mockRejectedValueOnce({code: 'LOCKOUT'});

		const tr = renderScreen();
		await pressConfirm(tr);

		const errorNode = tr.root.findByProps({testID: 'confirmation-error'});
		expect(errorNode).toBeDefined();

		const scrollNode = findHostNodeByType(tr.toJSON(), 'RCTScrollView');
		expect(scrollNode).not.toBeNull();
	});
});

describe('ConfirmationScreen — current election on a joined network (D-28)', () => {
	const g = globalThis as {__DEV__?: boolean};
	const originalDev = g.__DEV__;
	afterEach(() => {
		g.__DEV__ = originalDev;
		mockSeededElectionId = SEEDED_ELECTION_ID;
	});

	it('registers with the listed election on a joined network: payload, association init and challenge all carry it', async () => {
		g.__DEV__ = false;
		mockSeededElectionId = undefined;
		mockGetElections.mockImplementation(async () => [{id: 'joined-election-7', date: Date.now() + 86_400_000}]);

		const tr = renderScreen();
		await pressConfirm(tr, 'confirmation-confirm-face-id', 120);

		expect(tr.root.findByProps({testID: 'confirmation-pending'})).toBeDefined();
		expect(registrationRequestInits[0].payload.electionId).toBe('joined-election-7');
		expect(associationSubmitRequestCalls[0].init.electionId).toBe('joined-election-7');
		expect(mockProduce.mock.calls[0][0]).toMatchObject({electionId: 'joined-election-7'});
	});

	it('reads the elections after the identity (WR-04) and before the device key', async () => {
		const tr = renderScreen();
		await pressConfirm(tr, 'confirmation-confirm-face-id', 120);

		const signer = mockCreateDeviceSigner.mock.invocationCallOrder[0];
		const elections = mockGetElections.mock.invocationCallOrder[0];
		const provision = mockProvisionDeviceKey.mock.invocationCallOrder[0];
		expect(signer).toBeLessThan(elections);
		expect(elections).toBeLessThan(provision);
	});

	it('release build with a seed and an empty list fails closed: no-election copy, no retry, no device key, no submit', async () => {
		g.__DEV__ = false;
		const tr = renderScreen();
		await pressConfirm(tr, 'confirmation-confirm-face-id', 120);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('There is no election to register for on this phone yet.');
		expect(tr.root.findAllByProps({testID: 'confirmation-confirm-face-id'})).toHaveLength(0);
		expect(text).not.toContain('Try Again');
		expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
		expect(mockRegistrationSubmitRequest).not.toHaveBeenCalled();
	});

	it('several listed elections: the nearest to now is used', async () => {
		const now = 1_900_000_000_000;
		const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
		try {
			mockGetElections.mockImplementation(async () => [
				{id: 'far', date: now + 90 * 86_400_000},
				{id: 'near', date: now + 86_400_000},
			]);
			const tr = renderScreen();
			await pressConfirm(tr, 'confirmation-confirm-face-id', 120);
			expect(registrationRequestInits[0].payload.electionId).toBe('near');
		} finally {
			spy.mockRestore();
		}
	});

	it('a rejected election read shows the transient copy and Try Again, never uses the seed, and is not memoised', async () => {
		g.__DEV__ = true;
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			mockGetElections.mockImplementationOnce(async () => {
				throw Object.assign(new Error('could not reach peer-xyz'), {name: 'PeerUnavailableError'});
			});
			const tr = renderScreen();
			await pressConfirm(tr, 'confirmation-confirm-face-id', 120);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('Something went wrong verifying your device. Try again.');
			expect(text).not.toContain('peer-xyz');
			expect(tr.root.findByProps({testID: 'confirmation-confirm-face-id'})).toBeDefined();
			expect(text).toContain('Try Again');
			expect(mockRegistrationSubmitRequest).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith('ConfirmationScreen: registration ceremony failed:', 'PeerUnavailableError');

			// Retry with a readable (empty) list: the dev seed stands in only now.
			await pressConfirm(tr, 'confirmation-confirm-face-id', 120);
			expect(tr.root.findByProps({testID: 'confirmation-pending'})).toBeDefined();
			expect(registrationRequestInits[0].payload.electionId).toBe(SEEDED_ELECTION_ID);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('memoises the election per attempt: Try Again reads once and reuses the same inits and challenge election', async () => {
		g.__DEV__ = false;
		mockSeededElectionId = undefined;
		mockGetElections.mockImplementationOnce(async () => [{id: 'first-election', date: Date.now() + 86_400_000}]);
		mockAssociationSubmitAttestation.mockRejectedValueOnce(new Error('submitAttestation failed: transient'));

		const tr = renderScreen();
		await pressConfirm(tr, 'confirmation-confirm-face-id', 120);
		mockGetElections.mockImplementation(async () => [{id: 'different-election', date: Date.now() + 86_400_000}]);
		await pressConfirm(tr, 'confirmation-confirm-face-id', 120);

		expect(mockGetElections).toHaveBeenCalledTimes(1);
		expect(mockProduce.mock.calls[1][0]).toMatchObject({electionId: 'first-election'});
		expect(registrationRequestInits[1]).toBe(registrationRequestInits[0]);
		expect(associationSubmitRequestCalls[1].init).toBe(associationSubmitRequestCalls[0].init);
	});
});

describe('pollForNotice — bounded wall-clock wait (D-27)', () => {
	const REQ = 'req-1';
	const TERMINAL = new Set(['c', 'r']);
	const notice = (status: string, cursor = 'k', requestId = REQ) => ({requestId, status, cursor, challengeNonce: 'n'});

	/** A virtual clock: `sleep` records its duration and moves `now`. */
	function virtualClock(extraJump = 0) {
		let t = 1_000_000;
		const sleeps: number[] = [];
		return {
			sleeps,
			now: () => t,
			sleep: async (ms: number) => {
				sleeps.push(ms);
				t += ms + extraJump;
			},
			advance: (ms: number) => {
				t += ms;
			},
		};
	}

	/** Reads answer `batches` in order, then `[]` for ever. */
	function scripted(batches: Array<Array<ReturnType<typeof notice>>>) {
		let read = 0;
		return jest.fn(async (_cursor?: string) => batches[read++] ?? []);
	}

	const options = (clock: ReturnType<typeof virtualClock>, shouldStop = () => false, deadlineMs: number = DECISION_WAIT_DEADLINE_MS) => ({
		now: clock.now,
		sleep: clock.sleep,
		deadlineMs,
		shouldStop,
	});

	it('(a) the first read is immediate: a matching notice returns with no sleep', async () => {
		const clock = virtualClock();
		const poll = scripted([[notice('c')]]);
		await expect(pollForNotice(poll, REQ, TERMINAL, options(clock))).resolves.toMatchObject({status: 'c'});
		expect(poll).toHaveBeenCalledTimes(1);
		expect(clock.sleeps).toEqual([]);
	});

	it('(b) empty reads then the notice: resolves after one interval-long sleep per empty read', async () => {
		const clock = virtualClock();
		const poll = scripted([[], [], [], [notice('c')]]);
		await expect(pollForNotice(poll, REQ, TERMINAL, options(clock))).resolves.toMatchObject({status: 'c'});
		expect(poll).toHaveBeenCalledTimes(4);
		expect(clock.sleeps).toEqual([DECISION_POLL_INTERVAL_MS, DECISION_POLL_INTERVAL_MS, DECISION_POLL_INTERVAL_MS]);
	});

	it('(c) forwards the last cursor of a batch to the next read', async () => {
		const clock = virtualClock();
		const poll = scripted([[notice('p', 'k1', 'other'), notice('p', 'k2', 'other')], [notice('c', 'k3')]]);
		await pollForNotice(poll, REQ, TERMINAL, options(clock));
		expect(poll.mock.calls.map(c => c[0])).toEqual([undefined, 'k2']);
	});

	it('(d) a non-terminal status for the request and notices for other requests never end the wait', async () => {
		const clock = virtualClock();
		const poll = scripted([[notice('p', 'a'), notice('c', 'b', 'other')], [notice('c', 'c')]]);
		await expect(pollForNotice(poll, REQ, TERMINAL, options(clock))).resolves.toMatchObject({cursor: 'c'});
		expect(poll).toHaveBeenCalledTimes(2);
	});

	it('(e) never answered: rejects as a timeout after exactly the reads the deadline allows, the last sleep clamped', async () => {
		const clock = virtualClock();
		const poll = scripted([]);
		await expect(pollForNotice(poll, REQ, TERMINAL, options(clock, () => false, 5000))).rejects.toMatchObject({
			name: 'DecisionWaitTimeoutError',
		});
		expect(poll).toHaveBeenCalledTimes(3);
		expect(clock.sleeps).toEqual([2000, 2000, 1000]);
	});

	it('(f) a clock jump past the deadline during a sleep times out with no further read', async () => {
		const clock = virtualClock(DECISION_WAIT_DEADLINE_MS + 1);
		const poll = scripted([]);
		await expect(pollForNotice(poll, REQ, TERMINAL, options(clock))).rejects.toMatchObject({name: 'DecisionWaitTimeoutError'});
		expect(poll).toHaveBeenCalledTimes(1);
	});

	describe('(g) Stop', () => {
		it('before any read: rejects as stopped after zero reads', async () => {
			const clock = virtualClock();
			const poll = scripted([[notice('c')]]);
			await expect(pollForNotice(poll, REQ, TERMINAL, options(clock, () => true))).rejects.toMatchObject({
				name: 'DecisionWaitStoppedError',
			});
			expect(poll).toHaveBeenCalledTimes(0);
		});

		it('during a read that returns a matching notice: the notice is discarded', async () => {
			const clock = virtualClock();
			let stop = false;
			let read = 0;
			const poll = jest.fn(async (_cursor?: string) => {
				read += 1;
				if (read === 2) {
					stop = true;
					return [notice('c')];
				}
				return [];
			});
			await expect(pollForNotice(poll, REQ, TERMINAL, options(clock, () => stop))).rejects.toMatchObject({
				name: 'DecisionWaitStoppedError',
			});
			expect(poll).toHaveBeenCalledTimes(2);
		});

		it('during a sleep: rejects as stopped with no further read', async () => {
			const clock = virtualClock();
			let stop = false;
			const poll = scripted([]);
			const opts = {
				...options(clock, () => stop),
				sleep: async (ms: number) => {
					stop = true;
					await clock.sleep(ms);
				},
			};
			await expect(pollForNotice(poll, REQ, TERMINAL, opts)).rejects.toMatchObject({name: 'DecisionWaitStoppedError'});
			expect(poll).toHaveBeenCalledTimes(1);
		});
	});

	it('(h) a poll rejection propagates as the very same object, with no further read', async () => {
		const clock = virtualClock();
		const error = new Error('read failed');
		const poll = jest.fn(async (_cursor?: string): Promise<never[]> => {
			throw error;
		});
		await expect(pollForNotice(poll, REQ, TERMINAL, options(clock))).rejects.toBe(error);
		expect(poll).toHaveBeenCalledTimes(1);
	});

	it.each([['Infinity', Infinity], ['0', 0], ['NaN', NaN]])('(i) a deadline of %s is bounded by DECISION_WAIT_MAX_MS', async (_label, deadlineMs) => {
		const clock = virtualClock();
		const poll = scripted([]);
		await expect(pollForNotice(poll, REQ, TERMINAL, options(clock, () => false, deadlineMs as number))).rejects.toMatchObject({
			name: 'DecisionWaitTimeoutError',
		});
		expect(poll).toHaveBeenCalledTimes(Math.ceil(DECISION_WAIT_MAX_MS / DECISION_POLL_INTERVAL_MS));
	});

	it('(j) the constants are finite, ordered and as designed', () => {
		expect(Number.isFinite(DECISION_WAIT_DEADLINE_MS)).toBe(true);
		expect(DECISION_WAIT_DEADLINE_MS).toBeGreaterThan(DECISION_POLL_INTERVAL_MS);
		expect(DECISION_WAIT_DEADLINE_MS).toBeLessThanOrEqual(DECISION_WAIT_MAX_MS);
		expect(DECISION_WAIT_MAX_MS).toBe(300_000);
		expect(DECISION_POLL_INTERVAL_MS).toBe(2000);
	});
});

describe('ConfirmationScreen — waiting for the decision (D-27, UI-SPEC A3)', () => {
	const mounted: renderer.ReactTestRenderer[] = [];
	const tReg = () => i18n.getFixedT('en', 'registration');

	beforeEach(() => {
		jest.useFakeTimers({doNotFake: ['queueMicrotask']});
	});
	afterEach(async () => {
		while (mounted.length > 0) {
			const tr = mounted.pop()!;
			renderer.act(() => {
				tr.unmount();
			});
		}
		jest.useRealTimers();
		await renderer.act(async () => {
			await i18n.changeLanguage('en');
		});
	});

	function mount() {
		const tr = renderScreen();
		mounted.push(tr);
		return tr;
	}

	const decision = (status: string, cursor = 'cursor-w') => ({
		requestId: capturedAssociationRequestId,
		status,
		challengeNonce: CHALLENGE_NONCE,
		cursor,
	});

	/** pollDecisions answers `batches` in order, then `[]`. */
	function scriptPolls(batches: Array<() => unknown[]>) {
		let read = 0;
		looseMockPollDecisions.mockImplementation(async (_sinceCursor?: string) => {
			callOrder.push('association.pollDecisions');
			const next = batches[read++];
			return next ? next() : [];
		});
	}

	const present = (tr: renderer.ReactTestRenderer, testID: string) => tr.root.findAllByProps({testID}).length > 0;

	async function press(tr: renderer.ReactTestRenderer, testID = 'confirmation-confirm-face-id') {
		await renderer.act(async () => {
			tr.root.findByProps({testID}).props.onPress();
			await flushMicrotasks(120);
		});
	}

	async function advance(ms: number) {
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(ms);
			await flushMicrotasks(60);
		});
	}

	const style = (node: {props: {style?: unknown}}) => Object.assign({}, ...([] as unknown[]).concat(node.props.style ?? []));

	it('(1) shows the A3 waiting state right after the press, hiding the CTA and the caption, after one read', async () => {
		scriptPolls([]);
		const tr = mount();
		await press(tr);

		expect(style(tr.root.findByProps({testID: 'confirmation-waiting'})).alignItems).toBe('center');
		const indicator = tr.root.findByProps({testID: 'confirmation-waiting-indicator'});
		expect(indicator.props.size).toBe('large');
		expect(indicator.props.color).toBe('#2196f3');
		expect(indicator.props.accessible).toBe(false);
		const text = tr.root.findByProps({testID: 'confirmation-waiting-text'});
		expect(text.props.children).toBe(tReg()('confirmation.waiting'));
		expect(text.props.children).not.toBe('confirmation.waiting');
		expect(text.props.numberOfLines).toBeUndefined();
		expect(text.props.accessibilityLiveRegion).toBe('polite');
		const stop = tr.root.findByProps({testID: 'confirmation-waiting-cancel'});
		expect(stop.props.accessibilityRole).toBe('button');
		expect(style(stop).minHeight).toBeGreaterThanOrEqual(44);
		expect(style(stop).borderWidth).toBe(1);
		expect(style(stop).borderColor).toBe('#2196f3');

		expect(present(tr, 'confirmation-confirm-face-id')).toBe(false);
		expect(present(tr, 'confirmation-retry-cta')).toBe(false);
		expect(present(tr, 'confirmation-error')).toBe(false);
		expect(JSON.stringify(tr.toJSON())).not.toContain(tReg()('confirmation.caption'));
		expect(mockPollDecisions).toHaveBeenCalledTimes(1);
	});

	it('(2) the officer approves inside the window: the first Confirm finishes with no Try Again', async () => {
		scriptPolls([() => [], () => [], () => [], () => [decision('c')]]);
		const tr = mount();
		await press(tr);
		await advance(3 * DECISION_POLL_INTERVAL_MS);

		expect(mockProduce).toHaveBeenCalledTimes(1);
		expect(mockAssociationSubmitAttestation).toHaveBeenCalledTimes(1);
		expect(present(tr, 'confirmation-pending')).toBe(true);
		expect(present(tr, 'confirmation-waiting')).toBe(false);
		expect(present(tr, 'confirmation-retry-cta')).toBe(false);
		expect(JSON.stringify(tr.toJSON())).not.toContain('Try Again');
	});

	it('(3) never answered: after the deadline the timeout copy and Try Again show, and the polling stops', async () => {
		scriptPolls([]);
		const tr = mount();
		await press(tr);
		await advance(DECISION_WAIT_DEADLINE_MS + DECISION_POLL_INTERVAL_MS);

		expect(present(tr, 'confirmation-waiting')).toBe(false);
		expect(tr.root.findByProps({testID: 'confirmation-error'}).props.children).toBe(tReg()('confirmation.error.decisionTimeout'));
		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		expect(labelOf(cta)).toBe('Try Again');
		expect(JSON.stringify(tr.toJSON())).not.toContain('Something went wrong');
		expect(mockProduce).not.toHaveBeenCalled();

		const reads = mockPollDecisions.mock.calls.length;
		await advance(10 * DECISION_POLL_INTERVAL_MS);
		expect(mockPollDecisions.mock.calls.length).toBe(reads);
	});

	it('(4) a clock jump past the deadline (app back from the background) times out at the next tick with no further read', async () => {
		scriptPolls([]);
		const tr = mount();
		await press(tr);
		expect(mockPollDecisions).toHaveBeenCalledTimes(1);

		jest.setSystemTime(Date.now() + DECISION_WAIT_DEADLINE_MS + 1);
		await advance(DECISION_POLL_INTERVAL_MS);

		expect(tr.root.findByProps({testID: 'confirmation-error'}).props.children).toBe(tReg()('confirmation.error.decisionTimeout'));
		expect(mockPollDecisions).toHaveBeenCalledTimes(1);
	});

	it('(5) Stop during a sleep ends the wait at once with the stopped copy, Try Again, and no further read or prompt', async () => {
		scriptPolls([]);
		const tr = mount();
		await press(tr);
		await press(tr, 'confirmation-waiting-cancel');

		expect(present(tr, 'confirmation-waiting')).toBe(false);
		expect(tr.root.findByProps({testID: 'confirmation-error'}).props.children).toBe(tReg()('confirmation.error.waitStopped'));
		expect(labelOf(tr.root.findByProps({testID: 'confirmation-confirm-face-id'}))).toBe('Try Again');

		const reads = mockPollDecisions.mock.calls.length;
		await advance(10 * DECISION_POLL_INTERVAL_MS);
		expect(mockPollDecisions.mock.calls.length).toBe(reads);
		expect(mockProduce).not.toHaveBeenCalled();
	});

	it('(6) Stop during an in-flight read discards a late notice: no prompt, no attestation answer', async () => {
		const late = deferred<unknown[]>();
		let read = 0;
		looseMockPollDecisions.mockImplementation(async (_sinceCursor?: string) => {
			read += 1;
			return read === 2 ? late.promise : [];
		});
		const tr = mount();
		await press(tr);
		await advance(DECISION_POLL_INTERVAL_MS); // read 2 is now in flight
		expect(mockPollDecisions).toHaveBeenCalledTimes(2);

		await press(tr, 'confirmation-waiting-cancel');
		await renderer.act(async () => {
			late.resolve([decision('c')]);
			await flushMicrotasks(60);
		});

		expect(tr.root.findByProps({testID: 'confirmation-error'}).props.children).toBe(tReg()('confirmation.error.waitStopped'));
		expect(mockProduce).not.toHaveBeenCalled();
		expect(mockAssociationSubmitAttestation).not.toHaveBeenCalled();
	});

	it('(7) unmount during an in-flight read: nothing runs afterwards, no state is set and nothing is logged', async () => {
		const late = deferred<unknown[]>();
		let read = 0;
		looseMockPollDecisions.mockImplementation(async (_sinceCursor?: string) => {
			read += 1;
			return read === 2 ? late.promise : [];
		});
		const tr = mount();
		await press(tr);
		await advance(DECISION_POLL_INTERVAL_MS);
		expect(mockPollDecisions).toHaveBeenCalledTimes(2);

		const consoleSpy = spyAllConsole();
		try {
			renderer.act(() => {
				tr.unmount();
			});
			await renderer.act(async () => {
				late.resolve([decision('c')]);
				await flushMicrotasks(60);
			});
			await advance(DECISION_WAIT_DEADLINE_MS + DECISION_POLL_INTERVAL_MS);

			expect(mockProduce).not.toHaveBeenCalled();
			expect(mockAssociationSubmitAttestation).not.toHaveBeenCalled();
			expect(mockClearDraft).not.toHaveBeenCalled();
			expect(mockPollDecisions).toHaveBeenCalledTimes(2);
			expect(consoleSpy.calls()).toEqual([]);
		} finally {
			consoleSpy.restore();
		}
	});

	it('(8) unmount during a sleep: the deadline passing adds no read and no console call', async () => {
		scriptPolls([]);
		const tr = mount();
		await press(tr);

		const consoleSpy = spyAllConsole();
		try {
			renderer.act(() => {
				tr.unmount();
			});
			await advance(DECISION_WAIT_DEADLINE_MS + DECISION_POLL_INTERVAL_MS);
			expect(mockPollDecisions).toHaveBeenCalledTimes(1);
			expect(consoleSpy.calls()).toEqual([]);
		} finally {
			consoleSpy.restore();
		}
	});

	it('(9) unmount at the identity read: once it settles nothing downstream runs', async () => {
		const identity = deferred<typeof mockDeviceSign>();
		mockCreateDeviceSigner.mockImplementationOnce(() => identity.promise);
		const tr = mount();
		await press(tr);

		renderer.act(() => {
			tr.unmount();
		});
		await renderer.act(async () => {
			identity.resolve(mockDeviceSign);
			await flushMicrotasks(120);
		});

		expect(mockGetElections).not.toHaveBeenCalled();
		expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
		expect(mockRegistrationSubmitRequest).not.toHaveBeenCalled();
		expect(mockAssociationSubmitRequest).not.toHaveBeenCalled();
		expect(mockPollDecisions).not.toHaveBeenCalled();
		expect(mockProduce).not.toHaveBeenCalled();
	});

	describe.each([
		['a timeout', async (tr: renderer.ReactTestRenderer) => advance(DECISION_WAIT_DEADLINE_MS + DECISION_POLL_INTERVAL_MS)],
		['a Stop', async (tr: renderer.ReactTestRenderer) => press(tr, 'confirmation-waiting-cancel')],
	])('(10, 11) Try Again after %s', (_name, endWait) => {
		it('re-enters the wait, re-submits the byte-identical inits, reuses the election id and finishes', async () => {
			scriptPolls([]);
			const tr = mount();
			await press(tr);
			await endWait(tr);
			expect(present(tr, 'confirmation-error')).toBe(true);

			// The retry: its first read is empty, the next carries the decision.
			let read = 0;
			looseMockPollDecisions.mockImplementation(async (_sinceCursor?: string) => {
				callOrder.push('association.pollDecisions');
				read += 1;
				return read === 1 ? [] : [decision('c')];
			});
			await press(tr);
			expect(present(tr, 'confirmation-waiting')).toBe(true);
			await advance(DECISION_POLL_INTERVAL_MS);

			expect(present(tr, 'confirmation-pending')).toBe(true);
			expect(registrationRequestInits).toHaveLength(2);
			expect(registrationRequestInits[1]).toBe(registrationRequestInits[0]);
			expect(associationSubmitRequestCalls[1].init).toBe(associationSubmitRequestCalls[0].init);
			expect(mockDeriveRegistrationCode).toHaveBeenCalledTimes(1);
			expect(mockProduce.mock.calls[0][0]).toMatchObject({electionId: registrationRequestInits[0].payload.electionId});
		});
	});

	it('(12) a rejected notice mid-wait leaves the waiting state for the generic transient copy and never prompts', async () => {
		scriptPolls([() => [], () => [decision('r')]]);
		const tr = mount();
		await press(tr);
		await advance(DECISION_POLL_INTERVAL_MS);

		expect(present(tr, 'confirmation-waiting')).toBe(false);
		expect(JSON.stringify(tr.toJSON())).toContain('Something went wrong verifying your device. Try again.');
		expect(mockProduce).not.toHaveBeenCalled();
	});
});

describe('ConfirmationScreen — decision-wait logging (D-27, A3 D-06)', () => {
	beforeEach(() => {
		jest.useFakeTimers({doNotFake: ['queueMicrotask']});
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	it('logs only the closed tokens across a timeout, a Stop and a success, and never an id, nonce, cursor or key', async () => {
		const consoleSpy = spyAllConsole();
		const trees: renderer.ReactTestRenderer[] = [];
		try {
			const press = async (tr: renderer.ReactTestRenderer, testID = 'confirmation-confirm-face-id') => {
				await renderer.act(async () => {
					tr.root.findByProps({testID}).props.onPress();
					await flushMicrotasks(120);
				});
			};
			const advance = async (ms: number) => {
				await renderer.act(async () => {
					await jest.advanceTimersByTimeAsync(ms);
					await flushMicrotasks(60);
				});
			};
			const never = () =>
				looseMockPollDecisions.mockImplementation(async (_sinceCursor?: string) => [
					{requestId: 'someone-else', status: 'p', cursor: 'cursor-never'},
				]);

			// 1) a timeout
			never();
			const timedOut = renderScreen();
			trees.push(timedOut);
			await press(timedOut);
			await advance(DECISION_WAIT_DEADLINE_MS + DECISION_POLL_INTERVAL_MS);
			// 2) a Stop
			never();
			const stopped = renderScreen();
			trees.push(stopped);
			await press(stopped);
			await press(stopped, 'confirmation-waiting-cancel');
			// 3) a success
			looseMockPollDecisions.mockImplementation(async (_sinceCursor?: string) => [
				{requestId: capturedAssociationRequestId, status: 'c', challengeNonce: CHALLENGE_NONCE, cursor: 'cursor-1'},
			]);
			const succeeded = renderScreen();
			trees.push(succeeded);
			await press(succeeded);
			expect(succeeded.root.findAllByProps({testID: 'confirmation-pending'}).length).toBeGreaterThan(0);

			const calls = consoleSpy.calls();
			const infos = calls.filter(c => c.method === 'info');
			expect(infos.filter(c => c.args[0] === 'ConfirmationScreen: decision wait: timed-out')).toHaveLength(1);
			expect(infos.filter(c => c.args[0] === 'ConfirmationScreen: decision wait: stopped')).toHaveLength(1);
			expect(calls.filter(c => String(c.args[0]).includes('registration ceremony failed:'))).toHaveLength(0);

			const closed = new Set([
				'ConfirmationScreen: decision wait: timed-out',
				'ConfirmationScreen: decision wait: stopped',
				'ConfirmationScreen: registration ceremony failed:',
			]);
			for (const call of calls) {
				if (typeof call.args[0] === 'string' && call.args[0].startsWith('ConfirmationScreen:')) {
					expect(closed.has(call.args[0])).toBe(true);
				}
			}

			const forbidden = [
				...associationSubmitRequestCalls.map(c => c.init.id as string),
				...registrationRequestInits.map(i => i.id as string),
				CHALLENGE_NONCE,
				'cursor-1',
				'cursor-never',
				P256_PUB,
				DEVICE_IDENTITY_PUBLIC_KEY,
			];
			const dump = JSON.stringify(calls);
			for (const value of forbidden) {
				expect(dump).not.toContain(value);
			}
		} finally {
			for (const tr of trees) {
				renderer.act(() => {
					tr.unmount();
				});
			}
			consoleSpy.restore();
		}
	});
});

describe('ConfirmationScreen — decision-wait copy in both locales (UI-SPEC A6 11a)', () => {
	beforeEach(() => {
		jest.useFakeTimers({doNotFake: ['queueMicrotask']});
	});
	afterEach(async () => {
		jest.useRealTimers();
		await renderer.act(async () => {
			await i18n.changeLanguage('en');
		});
	});

	async function mountIn(lng: string) {
		await renderer.act(async () => {
			await i18n.changeLanguage(lng);
		});
		looseMockPollDecisions.mockImplementation(async (_sinceCursor?: string) => []);
		const tr = renderScreen();
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'confirmation-confirm-face-id'}).props.onPress();
			await flushMicrotasks(120);
		});
		return tr;
	}

	it.each(['en', 'es'])('%s: the waiting text and the Stop label come from the bundle; the deadline shows the timeout copy and the retry label', async lng => {
		const tr = await mountIn(lng);
		const tLng = i18n.getFixedT(lng, 'registration');
		try {
			const waiting = tLng('confirmation.waiting');
			const stopLabel = tLng('confirmation.waitingCancel');
			expect(waiting).not.toBe('confirmation.waiting');
			expect(stopLabel).not.toBe('confirmation.waitingCancel');
			expect(tr.root.findByProps({testID: 'confirmation-waiting-text'}).props.children).toBe(waiting);
			expect(labelOf(tr.root.findByProps({testID: 'confirmation-waiting-cancel'}))).toBe(stopLabel);

			await renderer.act(async () => {
				await jest.advanceTimersByTimeAsync(DECISION_WAIT_DEADLINE_MS + DECISION_POLL_INTERVAL_MS);
				await flushMicrotasks(60);
			});
			expect(tr.root.findByProps({testID: 'confirmation-error'}).props.children).toBe(tLng('confirmation.error.decisionTimeout'));
			expect(labelOf(tr.root.findByProps({testID: 'confirmation-confirm-face-id'}))).toBe(tLng('confirmation.retryCta'));
		} finally {
			renderer.act(() => {
				tr.unmount();
			});
		}
	});

	it.each(['en', 'es'])('%s: Stop shows the stopped copy', async lng => {
		const tr = await mountIn(lng);
		try {
			await renderer.act(async () => {
				tr.root.findByProps({testID: 'confirmation-waiting-cancel'}).props.onPress();
				await flushMicrotasks(60);
			});
			expect(tr.root.findByProps({testID: 'confirmation-error'}).props.children).toBe(
				i18n.getFixedT(lng, 'registration')('confirmation.error.waitStopped'),
			);
		} finally {
			renderer.act(() => {
				tr.unmount();
			});
		}
	});
});


describe('ConfirmationScreen — outcome poll, completion and exits (D-100, UAT 65 gap 5)', () => {
	const mounted: renderer.ReactTestRenderer[] = [];

	beforeEach(() => {
		jest.useFakeTimers({doNotFake: ['queueMicrotask']});
	});
	afterEach(() => {
		while (mounted.length > 0) {
			const tr = mounted.pop()!;
			renderer.act(() => {
				tr.unmount();
			});
		}
		jest.useRealTimers();
	});

	const present = (tr: renderer.ReactTestRenderer, testID: string) => tr.root.findAllByProps({testID}).length > 0;

	async function submitToPending() {
		const tr = renderScreen();
		mounted.push(tr);
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'confirmation-confirm-face-id'}).props.onPress();
			await flushMicrotasks(200);
		});
		expect(present(tr, 'confirmation-pending')).toBe(true);
		return tr;
	}

	async function advance(ms: number) {
		await renderer.act(async () => {
			jest.advanceTimersByTime(ms);
			await flushMicrotasks(30);
		});
	}

	it('C-1 completes when a later poll reads registered; Done pops once', async () => {
		const tr = await submitToPending();
		mockResolveRegistrationStatus.mockImplementation(async () => ({kind: 'registered'}));
		await advance(10_000);
		expect(present(tr, 'confirmation-pending')).toBe(false);
		expect(present(tr, 'confirmation-registered')).toBe(true);
		expect(present(tr, 'confirmation-done')).toBe(true);
		expect(mockPopToTop).not.toHaveBeenCalled();
		renderer.act(() => {
			tr.root.findByProps({testID: 'confirmation-done'}).props.onPress();
		});
		expect(mockPopToTop).toHaveBeenCalledTimes(1);
	});

	it('C-2 pending shows Back to registration, which pops once', async () => {
		const tr = await submitToPending();
		renderer.act(() => {
			tr.root.findByProps({testID: 'confirmation-pending-back'}).props.onPress();
		});
		expect(mockPopToTop).toHaveBeenCalledTimes(1);
	});

	it('C-3 the poll stops after 10 min and the check-later line appears', async () => {
		const tr = await submitToPending();
		expect(present(tr, 'confirmation-pending-check-later')).toBe(false);
		await advance(600_000);
		await advance(10_000);
		expect(present(tr, 'confirmation-pending-check-later')).toBe(true);
		const calls = mockResolveRegistrationStatus.mock.calls.length;
		await advance(60_000);
		expect(mockResolveRegistrationStatus.mock.calls.length).toBe(calls);
	});

	it('C-4 unmount stops the poll', async () => {
		const tr = await submitToPending();
		renderer.act(() => {
			tr.unmount();
		});
		mounted.length = 0;
		const calls = mockResolveRegistrationStatus.mock.calls.length;
		await advance(60_000);
		expect(mockResolveRegistrationStatus.mock.calls.length).toBe(calls);
	});

	it('C-5 the status read uses the read-only device key lookup, never provisionDeviceKey', async () => {
		await submitToPending();
		mockProvisionDeviceKey.mockClear();
		mockGetCurrentDeviceKey.mockClear();
		const deps = mockResolveRegistrationStatus.mock.calls.at(-1)![0] as {getCurrentDeviceKey: () => Promise<unknown>};
		await deps.getCurrentDeviceKey();
		expect(mockGetCurrentDeviceKey).toHaveBeenCalledTimes(1);
		expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
	});

	it.each(['indeterminate', 'notRegistered', 'pending'])('C-6 a %s read keeps the pending state', async kind => {
		const tr = await submitToPending();
		mockResolveRegistrationStatus.mockImplementation(async () => ({kind}));
		await advance(10_000);
		expect(present(tr, 'confirmation-pending')).toBe(true);
		expect(present(tr, 'confirmation-done')).toBe(false);
	});
});
