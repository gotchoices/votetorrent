/**
 * Unit tests for RegistrationScreen (REG-01/REG-05) — the real not-registered/registered card
 * host. Mocks `useNavigation` (spy-able jest.fn()) while keeping the rest of
 * `@react-navigation/native` real (ThemeProvider + useTheme) so the composed `RegistrationCard`
 * renders through the real theme, and mocks `useVotingApp`/`useRegistrationDraft` to drive
 * fixture provider state without mounting either real provider — mirrors
 * `RegistrationCard.test.tsx`'s theme-wrapping convention and
 * `DeviceAttestationScreen.test.tsx`'s navigation-mock convention.
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

jest.mock('../../../providers/VotingAppProvider', () => {
	const actual = jest.requireActual('../../../providers/VotingAppProvider');
	return {
		...actual,
		useVotingApp: jest.fn(),
	};
});

jest.mock('../../../providers/RegistrationDraftProvider', () => {
	const actual = jest.requireActual('../../../providers/RegistrationDraftProvider');
	return {
		...actual,
		useRegistrationDraft: jest.fn(),
	};
});

import {useVotingApp} from '../../../providers/VotingAppProvider';
import {useRegistrationDraft} from '../../../providers/RegistrationDraftProvider';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RegistrationScreen = require('../RegistrationScreen').default;

const mockUseVotingApp = useVotingApp as jest.Mock;
const mockUseRegistrationDraft = useRegistrationDraft as jest.Mock;

function setProviderState(overrides: {
	isRegistered?: boolean;
	registeredAt?: string | null;
	draft?: RegistrationDraft;
}) {
	mockUseVotingApp.mockReturnValue({
		isInitialized: true,
		isRegistered: overrides.isRegistered ?? false,
		setIsRegistered: jest.fn(),
		registeredAt: overrides.registeredAt ?? null,
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

describe('RegistrationScreen (REG-01/REG-05)', () => {
	beforeEach(() => {
		mockNavigate.mockClear();
	});

	it('not-registered: Register-now CTA navigates to DeviceAttestation', () => {
		setProviderState({isRegistered: false});
		const tr = renderScreen();

		const cta = tr.root.findByProps({testID: 'registration-card-register-now'});
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('DeviceAttestation');
	});

	it('registered: Update CTA navigates to RegisterPersonal (NOT DeviceAttestation, D-04)', () => {
		setProviderState({
			isRegistered: true,
			registeredAt: '2025-01-01T00:00:00.000Z',
			draft: {...EMPTY_DRAFT, firstName: 'Jane', lastName: 'Doe'},
		});
		const tr = renderScreen();

		const cta = tr.root.findByProps({testID: 'registration-card-update'});
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegisterPersonal');
		expect(mockNavigate).not.toHaveBeenCalledWith('DeviceAttestation');
	});

	it('registered: help (?) navigates to RegistrationInfo', () => {
		setProviderState({isRegistered: true, registeredAt: '2025-01-01T00:00:00.000Z'});
		const tr = renderScreen();

		const helpButton = tr.root.findByProps({testID: 'registration-card-help'});
		renderer.act(() => {
			helpButton.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegistrationInfo');
	});

	it('contains no Phase-39 dev-trigger Pressables', () => {
		setProviderState({isRegistered: false});
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).not.toContain('Open Device Attestation (dev)');
		expect(text).not.toContain('Open Confirmation (dev)');
	});
});
