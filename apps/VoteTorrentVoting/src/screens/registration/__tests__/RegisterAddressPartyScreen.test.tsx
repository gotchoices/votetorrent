/**
 * Unit tests for RegisterAddressPartyScreen (REG-03, Step 2) — write-through address fields +
 * party selection, always-enabled Back/Continue. Fully mocks `@react-navigation/native`
 * (spy-able `navigate`/`goBack`), `providers/VotingAppProvider` (token gate), and `providers/
 * RegistrationDraftProvider` (spy-able `updateField`), mirroring `ConfirmationScreen.test.tsx`'s
 * full-replace mocking pattern.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ScrollView} from 'react-native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockUpdateField = jest.fn();

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({navigate: mockNavigate, goBack: mockGoBack}),
	useTheme: () => ({
		colors: {
			primary: '#2196f3',
			background: '#fbfbfb',
			text: '#000000',
			textSecondary: '#7d7d7d',
			light: '#ffffff',
			border: '#e0e0e0',
			card: '#ffffff',
			secondaryButtonSurface: '#f5f5f5',
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
const RegisterAddressPartyScreen = require('../RegisterAddressPartyScreen').default;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<RegisterAddressPartyScreen />);
	});
	return tr;
}

beforeEach(() => {
	mockNavigate.mockClear();
	mockGoBack.mockClear();
	mockUpdateField.mockClear();
});

describe('RegisterAddressPartyScreen (REG-03, Step 2)', () => {
	it('renders StepProgressBar step 2, 3 address fields, and a PartyChipSelector with 4 options', () => {
		const tr = renderScreen();
		expect(tr.root.findByProps({testID: 'step-segment-2'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-address-1'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-address-2'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-address-3'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'party-chip-democratic'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'party-chip-republican'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'party-chip-independent'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'party-chip-other'})).toBeDefined();
	});

	it('selecting a party chip calls updateField(party, stable key) — not the localized label', () => {
		const tr = renderScreen();
		const chip = tr.root.findByProps({testID: 'party-chip-republican'});
		renderer.act(() => {
			chip.props.onPress();
		});
		expect(mockUpdateField).toHaveBeenCalledWith('party', 'republican');
	});

	it('Back fires navigation.goBack()', () => {
		const tr = renderScreen();
		const back = tr.root.findByProps({testID: 'register-back'});
		renderer.act(() => {
			back.props.onPress();
		});
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it('Continue navigates to RegisterConfirm; both CTAs always enabled', () => {
		const tr = renderScreen();
		const back = tr.root.findByProps({testID: 'register-back'});
		const cont = tr.root.findByProps({testID: 'register-continue'});
		expect(back.props.disabled).toBeFalsy();
		expect(cont.props.disabled).toBeFalsy();
		renderer.act(() => {
			cont.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegisterConfirm');
	});

	it('address field onChangeText calls updateField write-through', () => {
		const tr = renderScreen();
		const address1 = tr.root.findByProps({testID: 'register-address-1'});
		renderer.act(() => {
			address1.props.onChangeText('123 Main St');
		});
		expect(mockUpdateField).toHaveBeenCalledWith('addressLine1', '123 Main St');
	});

	// Manual-QA gap-closure (Phase 41 re-verification): the footer Back/Continue row must stay a
	// sibling OUTSIDE the ScrollView (not scrolled away), mirroring the RegisterConfirmScreen fix,
	// so it's always reachable above the bottom tab bar regardless of content height.
	it('renders address/party content inside a ScrollView, with register-back/register-continue as siblings outside it', () => {
		const tr = renderScreen();
		const scrollViews = tr.root.findAllByType(ScrollView);
		expect(scrollViews.length).toBe(1);
		expect(scrollViews[0].findAllByProps({testID: 'party-chip-democratic'}).length).toBeGreaterThan(0);
		expect(scrollViews[0].findAllByProps({testID: 'register-back'}).length).toBe(0);
		expect(scrollViews[0].findAllByProps({testID: 'register-continue'}).length).toBe(0);
		expect(tr.root.findByProps({testID: 'register-back'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-continue'})).toBeDefined();
	});
});
