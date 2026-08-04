/**
 * Unit tests for RegisterPersonalScreen (REG-03, Step 1) — full-bleed redesign: RegisterFormHeader
 * (back-arrow + close), grouped field cards with placeholder labels, masked DOB, and a validating
 * Continue (required + email/phone/dob). Fully mocks navigation/theme/providers (no real tree).
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ScrollView} from 'react-native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockPopToTop = jest.fn();
const mockUpdateField = jest.fn();

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({navigate: mockNavigate, goBack: mockGoBack, popToTop: mockPopToTop}),
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
			progressFill: '#2196f3',
			progressTrack: '#e0e0e0',
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
			caption: {fontSize: 14, lineHeight: 18},
		},
		radii: {pill: 999, lg: 16, md: 12, sm: 8},
	}),
}));

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({isInitialized: true}),
}));

const mockValid = {
	firstName: 'Jane',
	lastName: 'Doe',
	dob: '01/02/2003',
	email: 'jane@example.com',
	phone: '8011234567',
	addressLine1: '10 Example Rd',
	addressLine2: '',
	addressLine3: '',
	party: 'independent',
};
const mockDraft: Record<string, string> = {...mockValid};

jest.mock('../../../providers/RegistrationDraftProvider', () => ({
	useRegistrationDraft: () => ({draft: mockDraft, updateField: mockUpdateField}),
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
	mockGoBack.mockClear();
	mockPopToTop.mockClear();
	mockUpdateField.mockClear();
	Object.assign(mockDraft, mockValid); // reset to a valid baseline
});

describe('RegisterPersonalScreen (REG-03, Step 1)', () => {
	it('renders StepDots step 1, the header controls, and 5 write-through fields', () => {
		const tr = renderScreen();
		expect(tr.root.findByProps({testID: 'step-dot-1'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-back'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-close'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-first-name'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-last-name'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-dob'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-email'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-phone'})).toBeDefined();
	});

	it('firing register-first-name onChangeText calls updateField(firstName, value) — write-through', () => {
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-first-name'}).props.onChangeText('Ada');
		});
		expect(mockUpdateField).toHaveBeenCalledWith('firstName', 'Ada');
	});

	it('DOB field masks free input into MM/DD/YYYY on write-through', () => {
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-dob'}).props.onChangeText('11111999');
		});
		expect(mockUpdateField).toHaveBeenCalledWith('dob', '11/11/1999');
	});

	it('Continue with a valid mockDraft navigates to RegisterAddressParty', () => {
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-continue'}).props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegisterAddressParty');
	});

	it('Continue with empty required fields does NOT navigate and surfaces field errors', () => {
		Object.keys(mockDraft).forEach(k => (mockDraft[k] = ''));
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-continue'}).props.onPress();
		});
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(tr.root.findAllByProps({testID: 'register-first-name-error'}).length).toBeGreaterThan(0);
		expect(tr.root.findAllByProps({testID: 'register-email-error'}).length).toBeGreaterThan(0);
	});

	it('Continue with a malformed email does NOT navigate and flags the email field', () => {
		mockDraft.email = 'not-an-email';
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-continue'}).props.onPress();
		});
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(tr.root.findAllByProps({testID: 'register-email-error'}).length).toBeGreaterThan(0);
	});

	it('header back fires goBack; close fires popToTop', () => {
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-back'}).props.onPress();
		});
		expect(mockGoBack).toHaveBeenCalled();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-close'}).props.onPress();
		});
		expect(mockPopToTop).toHaveBeenCalled();
	});

	it('renders the form content inside a ScrollView with the pinned Continue as a sibling', () => {
		const tr = renderScreen();
		const scrollViews = tr.root.findAllByType(ScrollView);
		expect(scrollViews.length).toBe(1);
		// Continue is a sibling BELOW the ScrollView (not scrolled), so it is not found inside it.
		expect(scrollViews[0].findAllByProps({testID: 'register-continue'}).length).toBe(0);
		expect(tr.root.findAllByProps({testID: 'register-continue'}).length).toBeGreaterThan(0);
	});
});
