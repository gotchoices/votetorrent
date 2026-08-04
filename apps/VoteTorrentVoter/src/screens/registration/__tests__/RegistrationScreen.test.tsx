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

jest.mock('@react-navigation/native', () => {
	const actual = jest.requireActual('@react-navigation/native');
	return {
		...actual,
		useNavigation: () => ({navigate: mockNavigate}),
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

import {useVoterApp} from '../../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../../providers/RegistrationDraftProvider';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RegistrationScreen = require('../RegistrationScreen').default;

const mockUseVotingApp = useVoterApp as jest.Mock;
const mockUseRegistrationDraft = useRegistrationDraft as jest.Mock;

function setProviderState(overrides: {draft?: RegistrationDraft} = {}) {
	mockUseVotingApp.mockReturnValue({
		isInitialized: true,
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
