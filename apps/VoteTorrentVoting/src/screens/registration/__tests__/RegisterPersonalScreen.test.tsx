/**
 * Unit tests for RegisterPersonalScreen (REG-03, Step 1) — write-through fields + always-enabled
 * Continue. Fully mocks `@react-navigation/native` (spy-able `navigate`), `providers/
 * VotingAppProvider` (token gate), and `providers/RegistrationDraftProvider` (spy-able
 * `updateField`), mirroring `ConfirmationScreen.test.tsx`'s full-replace mocking pattern so no
 * real navigator/provider tree is required.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ScrollView} from 'react-native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockNavigate = jest.fn();
const mockUpdateField = jest.fn();

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({navigate: mockNavigate}),
	useTheme: () => ({
		colors: {
			primary: '#2196f3',
			background: '#fbfbfb',
			text: '#000000',
			textSecondary: '#7d7d7d',
			light: '#ffffff',
			border: '#e0e0e0',
			card: '#ffffff',
			progressFill: '#2196f3',
			progressTrack: '#e0e0e0',
		},
		fonts: {
			regular: {fontFamily: 'System', fontWeight: '400'},
			medium: {fontFamily: 'System', fontWeight: '500'},
		},
		type: {
			h4: {fontSize: 20, lineHeight: 26},
			body: {fontSize: 16, lineHeight: 22},
			caption: {fontSize: 14, lineHeight: 18},
		},
		radii: {pill: 999, md: 8},
	}),
}));

jest.mock('../../../providers/VotingAppProvider', () => ({
	useVotingApp: () => ({isInitialized: true}),
}));

const draft = {
	firstName: '',
	lastName: '',
	dob: '',
	email: '',
	phone: '',
	addressLine1: '',
	addressLine2: '',
	addressLine3: '',
	party: '',
};

jest.mock('../../../providers/RegistrationDraftProvider', () => ({
	useRegistrationDraft: () => ({draft, updateField: mockUpdateField}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RegisterPersonalScreen = require('../RegisterPersonalScreen').default;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<RegisterPersonalScreen />);
	});
	return tr;
}

beforeEach(() => {
	mockNavigate.mockClear();
	mockUpdateField.mockClear();
});

describe('RegisterPersonalScreen (REG-03, Step 1)', () => {
	it('renders StepProgressBar step 1 and 5 write-through fields', () => {
		const tr = renderScreen();
		expect(tr.root.findByProps({testID: 'step-segment-1'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-first-name'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-last-name'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-dob'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-email'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-phone'})).toBeDefined();
	});

	it('firing register-first-name onChangeText calls updateField(firstName, value) — write-through', () => {
		const tr = renderScreen();
		const firstNameInput = tr.root.findByProps({testID: 'register-first-name'});
		renderer.act(() => {
			firstNameInput.props.onChangeText('Jane');
		});
		expect(mockUpdateField).toHaveBeenCalledWith('firstName', 'Jane');
	});

	it('Continue is always enabled and navigates to RegisterAddressParty', () => {
		const tr = renderScreen();
		const cta = tr.root.findByProps({testID: 'register-continue'});
		expect(cta.props.disabled).toBeFalsy();
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegisterAddressParty');
	});

	// Manual-QA gap-closure (Phase 41 re-verification): defensive ScrollView wrap so field
	// content can't get clipped by the bottom tab bar on smaller viewports (same overflow risk
	// pattern confirmed on RegisterConfirmScreen).
	it('renders the form content inside a ScrollView', () => {
		const tr = renderScreen();
		const scrollViews = tr.root.findAllByType(ScrollView);
		expect(scrollViews.length).toBe(1);
		expect(scrollViews[0].findAllByProps({testID: 'register-continue'}).length).toBeGreaterThan(0);
	});
});
