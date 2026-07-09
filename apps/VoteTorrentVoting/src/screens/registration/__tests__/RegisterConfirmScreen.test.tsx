/**
 * Unit tests for RegisterConfirmScreen (REG-03, Step 3) — read-only review of the draft, Submit
 * navigates to Confirmation WITHOUT flipping isRegistered (D-05). Fully mocks
 * `@react-navigation/native` (spy-able `navigate`/`goBack`), `providers/VotingAppProvider`
 * (spy-able `setIsRegistered`, so we can assert it is never called), and `providers/
 * RegistrationDraftProvider` (fixture draft), mirroring `ConfirmationScreen.test.tsx`'s
 * full-replace mocking pattern.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ScrollView} from 'react-native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetIsRegistered = jest.fn();

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({navigate: mockNavigate, goBack: mockGoBack}),
	useTheme: () => ({
		colors: {
			primary: '#2196f3',
			background: '#fbfbfb',
			text: '#000000',
			textSecondary: '#7d7d7d',
			light: '#ffffff',
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
	useVotingApp: () => ({isInitialized: true, setIsRegistered: mockSetIsRegistered}),
}));

// party is the stable KEY ('republican'), not a localized label — RegisterConfirmScreen
// resolves it to the current-locale label at render time (Manual-QA gap-closure, Phase 41).
const draft = {
	firstName: 'Jane',
	lastName: 'Doe',
	dob: '01/23/1990',
	email: 'jane@example.com',
	phone: '555-1234',
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

beforeEach(() => {
	mockNavigate.mockClear();
	mockGoBack.mockClear();
	mockSetIsRegistered.mockClear();
});

describe('RegisterConfirmScreen (REG-03, Step 3)', () => {
	it('renders StepProgressBar step 3 and 6 review rows with the literal draft values', () => {
		const tr = renderScreen();
		expect(tr.root.findByProps({testID: 'step-segment-3'})).toBeDefined();

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Jane Doe');
		expect(text).toContain('01/23/1990');
		expect(text).toContain('jane@example.com');
		expect(text).toContain('555-1234');
		expect(text).toContain('Republican Party');
		expect(text).toContain('123 Main St, Salt Lake City, UT');
	});

	it('Back fires navigation.goBack()', () => {
		const tr = renderScreen();
		const back = tr.root.findByProps({testID: 'register-back'});
		renderer.act(() => {
			back.props.onPress();
		});
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it('Submit navigates to Confirmation and does NOT flip isRegistered (D-05)', () => {
		const tr = renderScreen();
		const submit = tr.root.findByProps({testID: 'register-submit'});
		renderer.act(() => {
			submit.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('Confirmation');
		expect(mockSetIsRegistered).not.toHaveBeenCalled();
	});

	// Manual-QA gap-closure (Phase 41 re-verification): the footer Back/Submit row was clipped
	// by the bottom tab bar because the review content rendered inside a single non-scrolling
	// View. Assert the review rows live inside a ScrollView, and the footer buttons are siblings
	// OUTSIDE it (not scrolled away), so Submit stays reachable regardless of review-content height.
	it('renders review rows inside a ScrollView, with register-back/register-submit as siblings outside it', () => {
		const tr = renderScreen();
		const scrollViews = tr.root.findAllByType(ScrollView);
		expect(scrollViews.length).toBe(1);

		const reviewRow = tr.root.findByProps({testID: 'register-review-fullName'});
		expect(scrollViews[0].findAllByProps({testID: 'register-review-fullName'})).toContain(reviewRow);

		expect(scrollViews[0].findAllByProps({testID: 'register-back'}).length).toBe(0);
		expect(scrollViews[0].findAllByProps({testID: 'register-submit'}).length).toBe(0);
		expect(tr.root.findByProps({testID: 'register-back'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-submit'})).toBeDefined();
	});

	// Manual-QA gap-closure (Phase 41 re-verification): party is a stable KEY resolved via
	// t('form.party.' + key) at this display site — with no party selected (''), the guard must
	// render an empty value rather than the broken t('form.party.') string.
	it('renders an empty party review row when draft.party is unselected (empty-key guard)', () => {
		const originalParty = draft.party;
		draft.party = '';
		try {
			const tr = renderScreen();
			const text = JSON.stringify(tr.toJSON());
			expect(text).not.toContain('form.party.');
			expect(tr.root.findByProps({testID: 'register-review-party'})).toBeDefined();
		} finally {
			draft.party = originalParty;
		}
	});
});
