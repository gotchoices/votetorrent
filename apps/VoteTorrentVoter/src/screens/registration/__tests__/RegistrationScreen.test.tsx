/**
 * Unit tests for RegistrationScreen (REG-01/REG-05) — the real not-registered/registered card
 * host. Mocks `useNavigation` (spy-able jest.fn()) while keeping the rest of
 * `@react-navigation/native` real (ThemeProvider + useTheme) so the composed `RegistrationCard`
 * renders through the real theme, and mocks `useVoterApp`/`useRegistrationDraft` to drive
 * fixture provider state without mounting either real provider — mirrors
 * `RegistrationCard.test.tsx`'s theme-wrapping convention and
 * `DeviceAttestationScreen.test.tsx`'s navigation-mock convention.
 *
 * Phase 44-07 (D-02): `isRegistered`/`registeredAt`/`setIsRegistered` are no longer
 * `useVoterApp()` context fields — `RegistrationScreen` now owns them as local component state,
 * driven via its own `__DEV__`-gated dev-toggle (testID `registration-dev-toggle`) rather than a
 * mocked context setter (see `RegistrationScreen.tsx`'s file header comment). The mocked
 * `useVoterApp` now only needs to supply `isInitialized`.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {lightTheme} from '../../../theme/themes';
import {EMPTY_DRAFT} from '../../../providers/RegistrationDraftProvider';
import type {RegistrationDraft} from '../../../providers/RegistrationDraftProvider';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockNavigate = jest.fn();
let latestFocusCallback: (() => void) | null = null;

jest.mock('@react-navigation/native', () => {
	const actual = jest.requireActual('@react-navigation/native');
	return {
		...actual,
		useNavigation: () => ({navigate: mockNavigate}),
		// Plan 28 (D-45): the real `useFocusEffect` needs a NavigationContainer ancestor this test
		// never mounts (mirrors `ConfirmationScreen.test.tsx`'s own shim) — runs the callback on
		// mount/dependency-change and exposes it so a test can re-fire a "focus".
		useFocusEffect: (cb: () => void) => {
			latestFocusCallback = cb;
			// eslint-disable-next-line @typescript-eslint/no-var-requires, react-hooks/rules-of-hooks
			require('react').useEffect(() => {
				const cleanup = cb();
				return typeof cleanup === 'function' ? cleanup : undefined;
			}, [cb]);
		},
	};
});

// Phase 44-07 (D-02/D-04): do NOT jest.requireActual the real VoterAppProvider module here —
// it now transitively imports CadreNodeProvider (real @serfab/cadre-core +
// @optimystic/db-p2p-storage-rn, ESM-only native deps this Jest RN environment cannot resolve).
// This test never renders <VoterAppProvider> (only RegistrationScreen's useVoterApp() call,
// mocked below), so a plain inert stand-in is sufficient.
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: jest.fn(),
	VoterAppProvider: ({children}: {children: React.ReactNode}) => children,
}));

jest.mock('../../../providers/RegistrationDraftProvider', () => {
	const actual = jest.requireActual('../../../providers/RegistrationDraftProvider');
	return {
		...actual,
		useRegistrationDraft: jest.fn(),
	};
});

// Plan 28 (D-45): mock resolveRegistrationCodeAvailability only — a pure stand-in, never the real
// engine reads (this test drives no real network/engine tree).
const mockResolveRegistrationCodeAvailability = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (..._args: unknown[]): Promise<any> => ({kind: 'unavailable'}),
);
jest.mock('../../../engines/continuity', () => ({
	resolveRegistrationCodeAvailability: (...args: unknown[]) => mockResolveRegistrationCodeAvailability(...args),
}));
const mockResolveRegistrationStatus = jest.fn(async (..._args: unknown[]): Promise<{kind: string}> => ({kind: 'notRegistered'}));
jest.mock('../../../engines/registration-status', () => ({
	resolveRegistrationStatus: (...args: unknown[]) => mockResolveRegistrationStatus(...args),
}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: () => ({
		provisionDeviceKey: async () => ({publicKey: 'P256_PUB'}),
	}),
}));

import {useVoterApp} from '../../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../../providers/RegistrationDraftProvider';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RegistrationScreen = require('../RegistrationScreen').default;

const mockUseVotingApp = useVoterApp as jest.Mock;
const mockUseRegistrationDraft = useRegistrationDraft as jest.Mock;
const mockGetEngine = jest.fn(async () => {
	throw new Error('getEngine is not available in this test — mock resolveRegistrationCodeAvailability instead');
});

function setProviderState(overrides: {draft?: RegistrationDraft; hasNetwork?: boolean} = {}) {
	mockUseVotingApp.mockReturnValue({
		isInitialized: true,
		getEngine: mockGetEngine,
		// Spike 100: a network is open unless a test says otherwise (the join link then hides).
		hasNetwork: overrides.hasNetwork ?? true,
	});
	mockUseRegistrationDraft.mockReturnValue({
		draft: overrides.draft ?? EMPTY_DRAFT,
		updateField: jest.fn(),
		resetDraft: jest.fn(),
	});
}

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<RegistrationScreen />
			</ThemeProvider>,
		);
	});
	return tr;
}

/** Presses RegistrationScreen's own __DEV__-gated dev-toggle to flip local isRegistered true
 * (Phase 44-07: isRegistered is local component state, not a mocked context field). */
function flipToRegistered(tr: renderer.ReactTestRenderer) {
	const toggle = tr.root.findByProps({testID: 'registration-dev-toggle'});
	renderer.act(() => {
		toggle.props.onPress();
	});
}

describe('RegistrationScreen (REG-01/REG-05)', () => {
	beforeEach(() => {
		mockNavigate.mockClear();
		mockResolveRegistrationCodeAvailability.mockClear();
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'unavailable'}));
		mockResolveRegistrationStatus.mockReset();
		mockResolveRegistrationStatus.mockImplementation(async () => ({kind: 'notRegistered'}));
		latestFocusCallback = null;
	});

	it('not-registered: Register-now CTA navigates to DeviceAttestation', () => {
		setProviderState();
		const tr = renderScreen();

		const cta = tr.root.findByProps({testID: 'registration-card-register-now'});
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('DeviceAttestation');
	});

	it('registered: Update CTA navigates to RegisterPersonal (NOT DeviceAttestation, D-04)', () => {
		setProviderState({draft: {...EMPTY_DRAFT, firstName: 'Jane', lastName: 'Doe'}});
		const tr = renderScreen();
		flipToRegistered(tr);

		const cta = tr.root.findByProps({testID: 'registration-card-update'});
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegisterPersonal');
		expect(mockNavigate).not.toHaveBeenCalledWith('DeviceAttestation');
	});

	it('registered: help (?) navigates to RegistrationInfo', () => {
		setProviderState();
		const tr = renderScreen();
		flipToRegistered(tr);

		const helpButton = tr.root.findByProps({testID: 'registration-card-help'});
		renderer.act(() => {
			helpButton.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegistrationInfo');
	});

	it('contains no Phase-39 dev-trigger Pressables', () => {
		setProviderState();
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).not.toContain('Open Device Attestation (dev)');
		expect(text).not.toContain('Open Confirmation (dev)');
	});
});

describe('RegistrationScreen — registered card follows the engine (D-100, UAT 65 gap 5)', () => {
	beforeEach(() => {
		mockNavigate.mockClear();
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'unavailable'}));
		mockResolveRegistrationStatus.mockReset();
		mockResolveRegistrationStatus.mockImplementation(async () => ({kind: 'notRegistered'}));
		latestFocusCallback = null;
	});

	async function mountAsync() {
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			for (let i = 0; i < 10; i++) await Promise.resolve();
		});
		return tr;
	}
	const registeredCard = (tr: renderer.ReactTestRenderer) =>
		tr.root.findAllByProps({testID: 'registration-card-update'}).length > 0;

	it('R-1 a registered read renders the registered card', async () => {
		mockResolveRegistrationStatus.mockImplementation(async () => ({kind: 'registered'}));
		const tr = await mountAsync();
		expect(registeredCard(tr)).toBe(true);
	});

	it.each(['pending', 'notRegistered', 'indeterminate'])('R-2 a %s read renders the not-registered card', async kind => {
		mockResolveRegistrationStatus.mockImplementation(async () => ({kind}));
		const tr = await mountAsync();
		expect(registeredCard(tr)).toBe(false);
		expect(tr.root.findAllByProps({testID: 'registration-card-register-now'}).length).toBeGreaterThan(0);
	});

	it('R-3 a re-focus re-reads and a later registered read flips the card', async () => {
		const tr = await mountAsync();
		expect(registeredCard(tr)).toBe(false);
		mockResolveRegistrationStatus.mockImplementation(async () => ({kind: 'registered'}));
		await renderer.act(async () => {
			latestFocusCallback!();
			for (let i = 0; i < 10; i++) await Promise.resolve();
		});
		expect(registeredCard(tr)).toBe(true);
	});

	it('R-4 the __DEV__ toggle still flips the card regardless of the read', async () => {
		mockResolveRegistrationStatus.mockImplementation(async () => ({kind: 'registered'}));
		const tr = await mountAsync();
		expect(registeredCard(tr)).toBe(true);
		flipToRegistered(tr); // effective value true -> toggles to false
		expect(registeredCard(tr)).toBe(false);
		flipToRegistered(tr);
		expect(registeredCard(tr)).toBe(true);
	});
});

describe('RegistrationScreen — registration code re-show / entry links (D-40/D-45)', () => {
	beforeEach(() => {
		mockNavigate.mockClear();
		mockResolveRegistrationCodeAvailability.mockClear();
		latestFocusCallback = null;
	});

	async function flush(times = 10) {
		for (let i = 0; i < times; i++) {
			await Promise.resolve();
		}
	}

	it("'available' renders code.showAgainLink; pressing it re-resolves and reveals the card with the fresh code", async () => {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'available', code: 'ABCDE12345'}));
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		const link = tr.root.findByProps({testID: 'registration-code-show-again-link'});
		const flatStyle = Object.assign({}, ...[].concat(link.props.style));
		expect(flatStyle.minHeight).toBeGreaterThanOrEqual(44);

		const callsBefore = mockResolveRegistrationCodeAvailability.mock.calls.length;
		mockResolveRegistrationCodeAvailability.mockImplementationOnce(async () => ({kind: 'available', code: 'ABCDEFGHJK'}));
		await renderer.act(async () => {
			link.props.onPress();
			await flush();
		});
		expect(mockResolveRegistrationCodeAvailability.mock.calls.length).toBeGreaterThan(callsBefore);

		const value = tr.root.findByProps({testID: 'registration-code-value'});
		expect(value.props.children).toBe('ABCDE-FGHJK');
	});

	it("'available' then a second resolve returning 'unavailable' shows the card's unavailable state", async () => {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'available', code: 'ABCDE12345'}));
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		mockResolveRegistrationCodeAvailability.mockImplementationOnce(async () => ({kind: 'unavailable'}));
		const link = tr.root.findByProps({testID: 'registration-code-show-again-link'});
		await renderer.act(async () => {
			link.props.onPress();
			await flush();
		});

		expect(tr.root.findAllByProps({testID: 'registration-code-value'})).toHaveLength(0);
	});

	it("'not-registered' renders newDevice.entryLink, whose press navigates to ContinueOnAnotherDevice", async () => {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'not-registered'}));
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		const link = tr.root.findByProps({testID: 'continue-device-entry-link'});
		renderer.act(() => {
			link.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('ContinueOnAnotherDevice');
	});

	it.each(['not-sent', 'not-holder'])(
		"'%s' renders neither link but renders the code.notAvailableOnDevice notice, with no numberOfLines",
		async kind => {
			mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind}));
			setProviderState();
			let tr!: renderer.ReactTestRenderer;
			await renderer.act(async () => {
				tr = renderer.create(
					<ThemeProvider value={lightTheme}>
						<RegistrationScreen />
					</ThemeProvider>,
				);
				await flush();
			});

			expect(tr.root.findAllByProps({testID: 'registration-code-show-again-link'})).toHaveLength(0);
			expect(tr.root.findAllByProps({testID: 'continue-device-entry-link'})).toHaveLength(0);
			const notice = tr.root.findByProps({testID: 'registration-code-not-available'});
			expect(notice.props.numberOfLines).toBeUndefined();
		},
	);

	it("'unavailable' renders the registration-code-not-available notice (code.notAvailableOnDevice), no numberOfLines, neither link", async () => {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'unavailable'}));
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		expect(tr.root.findAllByProps({testID: 'registration-code-show-again-link'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'continue-device-entry-link'})).toHaveLength(0);
		const notice = tr.root.findByProps({testID: 'registration-code-not-available'});
		expect(notice.props.numberOfLines).toBeUndefined();
	});

	it('renders registration-code-checking until the availability read settles, then the settled branch', async () => {
		let resolveRead!: (v: {kind: 'not-registered'}) => void;
		mockResolveRegistrationCodeAvailability.mockImplementation(
			() => new Promise(resolve => {
				resolveRead = resolve as typeof resolveRead;
			}),
		);
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		expect(tr.root.findAllByProps({testID: 'registration-code-checking'}).length).toBeGreaterThan(0);
		for (const id of ['registration-code-show-again-link', 'continue-device-entry-link', 'registration-code-not-available']) {
			expect(tr.root.findAllByProps({testID: id})).toHaveLength(0);
		}

		await renderer.act(async () => {
			resolveRead({kind: 'not-registered'});
			await flush();
		});
		expect(tr.root.findAllByProps({testID: 'registration-code-checking'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'continue-device-entry-link'}).length).toBeGreaterThan(0);
	});
});

describe('RegistrationScreen failed code read (gap6/WR-07, S-1)', () => {
	async function flush(times = 10) {
		for (let i = 0; i < times; i++) await Promise.resolve();
	}
	async function mountWith(result: unknown) {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => result);
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});
		return tr;
	}
	const ids = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAllByProps({testID: id}).length;

	beforeEach(() => {
		mockResolveRegistrationCodeAvailability.mockClear();
	});

	it('read-failed, registrant unknown: Try Again text + control and the continue-on-another-device link', async () => {
		const tr = await mountWith({kind: 'unavailable', reason: 'read-failed', registrantKnown: false});
		expect(ids(tr, 'registration-code-unavailable')).toBeGreaterThan(0);
		expect(ids(tr, 'registration-code-retry')).toBeGreaterThan(0);
		expect(ids(tr, 'continue-device-entry-link')).toBeGreaterThan(0);
		expect(ids(tr, 'registration-code-not-available')).toBe(0);
		expect(JSON.stringify(tr.toJSON())).toContain("isn't available right now");
	});

	it('read-failed, registrant known: Try Again without the entry link; Try Again re-runs the read and shows the result', async () => {
		const tr = await mountWith({kind: 'unavailable', reason: 'read-failed', registrantKnown: true});
		expect(ids(tr, 'registration-code-retry')).toBeGreaterThan(0);
		expect(ids(tr, 'continue-device-entry-link')).toBe(0);
		const callsBefore = mockResolveRegistrationCodeAvailability.mock.calls.length;
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'available', code: 'ABCDE12345'}));
		await renderer.act(async () => {
			tr.root.findByProps({testID: 'registration-code-retry'}).props.onPress();
			await flush();
		});
		expect(mockResolveRegistrationCodeAvailability.mock.calls.length).toBe(callsBefore + 1);
		expect(ids(tr, 'registration-code-retry')).toBe(0);
		expect(ids(tr, 'registration-code-show-again-link')).toBeGreaterThan(0);
	});

	it('holder-key-missing keeps the permanent not-available text', async () => {
		const tr = await mountWith({kind: 'unavailable', reason: 'holder-key-missing', registrantKnown: true});
		expect(ids(tr, 'registration-code-not-available')).toBeGreaterThan(0);
		expect(ids(tr, 'registration-code-retry')).toBe(0);
	});

	it('an unavailable result with no reason keeps the not-available text', async () => {
		const tr = await mountWith({kind: 'unavailable'});
		expect(ids(tr, 'registration-code-not-available')).toBeGreaterThan(0);
		expect(ids(tr, 'registration-code-retry')).toBe(0);
	});
});

describe('RegistrationScreen — join entry link (spike 100)', () => {
	const hasJoinLink = (tr: renderer.ReactTestRenderer) =>
		tr.root.findAll(node => node.props.testID === 'join-network-entry-link').length > 0;

	it('with no network open, offers the join link and opens JoinNetwork', () => {
		setProviderState({hasNetwork: false});
		mockNavigate.mockClear();
		const tr = renderScreen();
		const link = tr.root.find(node => node.props.testID === 'join-network-entry-link');
		renderer.act(() => {
			link.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('JoinNetwork');
	});

	it('hides the join link once a network is open', () => {
		setProviderState({hasNetwork: true});
		expect(hasJoinLink(renderScreen())).toBe(false);
	});
});
