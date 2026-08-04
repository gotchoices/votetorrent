/**
 * Unit tests for RegisterConfirmScreen (REG-03, Step 3) — full-bleed redesign: RegisterFormHeader
 * ("Confirm"), a single review card with label-left/value-right rows, and a full-width "Submit".
 * Submit navigates to Confirmation but does NOT flip isRegistered (D-05). Mocks nav/theme/providers.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ScrollView, Text} from 'react-native';
import '../../../i18n';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockPopToTop = jest.fn();
const mockSetIsRegistered = jest.fn();

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
	useVoterApp: () => ({isInitialized: true, setIsRegistered: mockSetIsRegistered}),
}));

// party is the stable KEY ('republican'), resolved to the locale label at render time.
const draft: Record<string, string> = {
	firstName: 'Jane',
	lastName: 'Doe',
	dob: '01/23/1990',
	email: 'jane@example.com',
	phone: '5551234567',
	addressLine1: '123 Main St',
	addressLine2: '',
	addressLine3: 'Salt Lake City, UT',
	party: 'republican',
};

jest.mock('../../../providers/RegistrationDraftProvider', () => ({
	useRegistrationDraft: () => ({draft}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RegisterConfirmScreen = require('../RegisterConfirmScreen').default;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<RegisterConfirmScreen />);
	});
	return tr;
}

function rowValue(tr: renderer.ReactTestRenderer, key: string): string {
	const row = tr.root.findByProps({testID: `register-review-${key}`});
	// the value Text is the last Text child of the row
	const texts = row.findAllByType(Text);
	return texts[texts.length - 1].props.children;
}

beforeEach(() => {
	mockNavigate.mockClear();
	mockGoBack.mockClear();
	mockPopToTop.mockClear();
	mockSetIsRegistered.mockClear();
	draft.party = 'republican';
});

describe('RegisterConfirmScreen (REG-03, Step 3)', () => {
	it('renders StepDots step 3 and the 6 review rows with the literal draft values', () => {
		const tr = renderScreen();
		expect(tr.root.findByProps({testID: 'step-dot-3'})).toBeDefined();
		expect(rowValue(tr, 'fullName')).toBe('Jane Doe');
		expect(rowValue(tr, 'dob')).toBe('01/23/1990');
		expect(rowValue(tr, 'email')).toBe('jane@example.com');
		expect(rowValue(tr, 'phone')).toBe('5551234567');
		expect(rowValue(tr, 'address')).toBe('123 Main St, Salt Lake City, UT');
		expect(rowValue(tr, 'party')).toBe('Republican Party');
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

	it('Submit navigates to Confirmation and does NOT flip isRegistered (D-05)', () => {
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-submit'}).props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('Confirmation');
		expect(mockSetIsRegistered).not.toHaveBeenCalled();
	});

	it('renders review rows inside a ScrollView, with register-back/register-submit outside it', () => {
		const tr = renderScreen();
		const scrollViews = tr.root.findAllByType(ScrollView);
		expect(scrollViews.length).toBe(1);
		// back lives in the header (inside the scroll); submit is the pinned sibling below it.
		expect(scrollViews[0].findAllByProps({testID: 'register-submit'}).length).toBe(0);
		expect(tr.root.findAllByProps({testID: 'register-submit'}).length).toBeGreaterThan(0);
		expect(scrollViews[0].findAllByProps({testID: 'register-review-fullName'}).length).toBeGreaterThan(0);
	});

	it('renders an empty party review value when draft.party is unselected (empty-key guard)', () => {
		draft.party = '';
		const tr = renderScreen();
		expect(rowValue(tr, 'party')).toBe('');
	});
});
