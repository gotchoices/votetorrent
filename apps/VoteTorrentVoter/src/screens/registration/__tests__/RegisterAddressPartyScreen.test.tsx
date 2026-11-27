/**
 * Unit tests for RegisterAddressPartyScreen (REG-03, Step 2) — full-bleed redesign: RegisterFormHeader,
 * grouped address card, and a PARTY DROPDOWN (not chips) that stores the stable party KEY. Continue
 * validates (address line 1 + party required). Fully mocks navigation/theme/providers.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Keyboard, Platform, ScrollView, TextInput, View} from 'react-native';
import '../../../i18n';

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
	mockPopToTop.mockClear();
	mockUpdateField.mockClear();
	Object.assign(mockDraft, mockValid);
});

describe('RegisterAddressPartyScreen (REG-03, Step 2)', () => {
	it('renders StepDots step 2, 3 address fields, and a party dropdown', () => {
		const tr = renderScreen();
		expect(tr.root.findByProps({testID: 'step-dot-2'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-address-1'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-address-2'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-address-3'})).toBeDefined();
		expect(tr.root.findByProps({testID: 'register-party'})).toBeDefined();
	});

	it('every text input and both header icons resolve to a >= 44dp touch target', () => {
		const tr = renderScreen();
		for (const testID of ['register-address-1', 'register-address-2', 'register-address-3']) {
			// The host TextInput itself (not the FieldRow wrapper that forwards the testID).
			const input = tr.root.findAllByType(TextInput).find(n => n.props.testID === testID);
			const style = Object.assign({}, ...[].concat(input?.props.style ?? []));
			expect(style.minHeight).toBeGreaterThanOrEqual(44);
		}
		for (const testID of ['register-back', 'register-close']) {
			const style = Object.assign({}, ...[].concat(tr.root.findByProps({testID}).props.style ?? []));
			expect(style.minHeight).toBeGreaterThanOrEqual(44);
			expect(style.minWidth).toBeGreaterThanOrEqual(44);
			// No negative margin: on Android a part pushed outside the clipping ScrollView is
			// untappable, which shrank the effective target below the glyph's own box.
			expect(style.marginHorizontal ?? 0).toBeGreaterThanOrEqual(0);
			expect(style.marginLeft ?? 0).toBeGreaterThanOrEqual(0);
			expect(style.marginRight ?? 0).toBeGreaterThanOrEqual(0);
		}
	});

	it('picking a party option calls updateField(party, stable key) — not the localized label', () => {
		mockDraft.party = '';
		const tr = renderScreen();
		// testID is forwarded to Pressable's host view too — pick the node that actually has onPress.
		const pressable = (testID: string) =>
			tr.root.findAllByProps({testID}).find(n => typeof n.props.onPress === 'function')!;
		renderer.act(() => {
			pressable('register-party').props.onPress(); // open dropdown
		});
		renderer.act(() => {
			pressable('party-option-independent').props.onPress();
		});
		expect(mockUpdateField).toHaveBeenCalledWith('party', 'independent');
	});

	it('address field onChangeText calls updateField write-through', () => {
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-address-1'}).props.onChangeText('1 Analytical Way');
		});
		expect(mockUpdateField).toHaveBeenCalledWith('addressLine1', '1 Analytical Way');
	});

	it('Continue with a valid mockDraft navigates to RegisterConfirm', () => {
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-continue'}).props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegisterConfirm');
	});

	it('Continue with no address/party does NOT navigate and surfaces errors', () => {
		mockDraft.addressLine1 = '';
		mockDraft.party = '';
		const tr = renderScreen();
		renderer.act(() => {
			tr.root.findByProps({testID: 'register-continue'}).props.onPress();
		});
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(tr.root.findAllByProps({testID: 'register-address-1-error'}).length).toBeGreaterThan(0);
		expect(tr.root.findAllByProps({testID: 'register-party-error'}).length).toBeGreaterThan(0);
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

	it('renders content inside a ScrollView with the pinned Continue as a sibling', () => {
		const tr = renderScreen();
		const scrollViews = tr.root.findAllByType(ScrollView);
		expect(scrollViews.length).toBe(1);
		expect(scrollViews[0].findAllByProps({testID: 'register-continue'}).length).toBe(0);
		expect(tr.root.findAllByProps({testID: 'register-continue'}).length).toBeGreaterThan(0);
	});
});

/**
 * Android forces edge-to-edge on any app targeting SDK 35, which makes the manifest's
 * `adjustResize` a no-op: the window is not resized for the IME, so the ScrollView's max scroll
 * offset never grows and the pinned Continue CTA is stranded behind the keyboard. The screen has
 * to apply the inset itself — these pin that it does, on the real tree.
 */
describe('RegisterAddressPartyScreen — keyboard inset (Android edge-to-edge)', () => {
	const SHOW_EVENT = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
	const HIDE_EVENT = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

	let handlers: Record<string, (event?: unknown) => void>;

	beforeEach(() => {
		handlers = {};
		jest.spyOn(Keyboard, 'addListener').mockImplementation(((e: string, cb: any) => {
			handlers[e] = cb;
			return {remove: jest.fn()};
		}) as any);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	/** The screen's outermost View, which owns the bottom padding. */
	function rootPadding(tr: renderer.ReactTestRenderer): number {
		const style = tr.root.findAllByType(View)[0].props.style;
		return Object.assign({}, ...[].concat(style).map(s => s ?? {})).paddingBottom;
	}

	it('grows the root bottom padding by the keyboard height so the form can scroll clear', () => {
		const tr = renderScreen();
		const resting = rootPadding(tr);
		renderer.act(() => handlers[SHOW_EVENT]?.({endCoordinates: {height: 733}}));
		// ADDED to the resting safe-area padding, not max'd with it — the reported height stops
		// at the navigation bar, so max-ing leaves the CTA clipped by that much (measured 64px).
		expect(rootPadding(tr)).toBe(resting + 733);
	});

	it('restores the resting padding when the keyboard is dismissed', () => {
		const tr = renderScreen();
		const resting = rootPadding(tr);
		renderer.act(() => handlers[SHOW_EVENT]?.({endCoordinates: {height: 733}}));
		renderer.act(() => handlers[HIDE_EVENT]?.());
		expect(rootPadding(tr)).toBe(resting);
	});
});
