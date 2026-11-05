/**
 * Unit tests for RegistrationConfirmationCodeCard (62-UI-SPEC Surface 7, D-45). Real `lightTheme`
 * through `ThemeProvider`, real i18n (the global instance). The geometry gate uses a TEST-LOCAL
 * `GLYPH_EM` literal (never the imported `CODE_GLYPH_EM_BUDGET` constant) so a loosened budget in
 * the component cannot silently relax what this test actually measures.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Dimensions} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import {REGISTRATION_CODE_FORMATTED_LENGTH} from '@votetorrent/vote-core';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

// D-06/SHELL-03 (no-inline-mock-imports gate) — the component makes an unused token
// useVoterApp() call (mirrors RegisterPersonalScreen.tsx's own precedent); this test never mounts
// a real VoterAppProvider tree, so it needs the same inert stand-in RegistrationScreen.test.tsx
// uses.
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({isInitialized: true}),
}));

import {
	RegistrationConfirmationCodeCard,
	fitRegistrationCodeFontSize,
	CODE_GLYPH_EM_BUDGET,
} from '../RegistrationConfirmationCodeCard';

/** `useWindowDimensions` subscribes to `Dimensions`'s own 'window' change — `Dimensions.set`
 * (real RN API, no mock needed) is how production code itself would observe a rotation/resize,
 * so this drives the SAME path the component's `useWindowDimensions()` call reads from. */
function setWindowWidth(width: number) {
	Dimensions.set({window: {width, height: 760, scale: 2, fontScale: 1}});
}

function renderCard(state: {kind: 'code'; code: string} | {kind: 'unavailable'}) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<RegistrationConfirmationCodeCard state={state} />
			</ThemeProvider>,
		);
	});
	return tr;
}

function fireFrameLayout(tr: renderer.ReactTestRenderer, width: number) {
	const frame = tr.root.findByProps({testID: 'registration-code-frame'});
	renderer.act(() => {
		frame.props.onLayout({nativeEvent: {layout: {width, height: 48, x: 0, y: 0}}});
	});
}

describe('RegistrationConfirmationCodeCard — content (Surface 7)', () => {
	beforeEach(() => {
		setWindowWidth(360);
	});

	it('kind "code" renders heading, body, and the formatted value in colors.primary, fonts.regular, selectable, accessibilityRole="text"', () => {
		const tr = renderCard({kind: 'code', code: 'ABCDE12345'});
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Your Registration Code');
		expect(text).toContain("Save this code");

		const value = tr.root.findByProps({testID: 'registration-code-value'});
		expect(value.props.children).toBe('ABCDE-12345');
		expect(value.props.selectable).toBe(true);
		expect(value.props.accessibilityRole).toBe('text');
		const flatStyle = Object.assign({}, ...[].concat(value.props.style));
		expect(flatStyle.color).toBe(lightTheme.colors.primary);
		expect(flatStyle.fontFamily).toBe(lightTheme.fonts.regular.fontFamily);
	});

	it('kind "unavailable" renders code.unavailable and no code value', () => {
		const tr = renderCard({kind: 'unavailable'});
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("Your registration code isn't available right now. Try again in a moment.");
		expect(tr.root.findAllByProps({testID: 'registration-code-value'})).toHaveLength(0);
	});
});

describe('RegistrationConfirmationCodeCard — geometry gate (max-length fixture)', () => {
	const GLYPH_EM = 1.0;
	const FIXTURE = 'WWWWW-WWWWW';

	beforeEach(() => {
		setWindowWidth(360);
	});

	it('fixture length is pinned: 11 === REGISTRATION_CODE_FORMATTED_LENGTH', () => {
		expect(FIXTURE.length).toBe(11);
		expect(FIXTURE.length).toBe(REGISTRATION_CODE_FORMATTED_LENGTH);
	});

	it('at 288dp (Redmi 8 narrowest inner width): fits within budget and never below the legibility floor', () => {
		const tr = renderCard({kind: 'code', code: 'WWWWWWWWWW'});
		fireFrameLayout(tr, 288);
		const value = tr.root.findByProps({testID: 'registration-code-value'});
		const flatStyle = Object.assign({}, ...[].concat(value.props.style));
		const F = flatStyle.fontSize;
		expect(F * 11 * GLYPH_EM).toBeLessThanOrEqual(288);
		expect(F).toBeGreaterThanOrEqual(20);
	});

	it('at 340dp (Pixel 8): fits within budget', () => {
		const tr = renderCard({kind: 'code', code: 'WWWWWWWWWW'});
		fireFrameLayout(tr, 340);
		const value = tr.root.findByProps({testID: 'registration-code-value'});
		const flatStyle = Object.assign({}, ...[].concat(value.props.style));
		expect(flatStyle.fontSize * 11).toBeLessThanOrEqual(340);
	});

	it('at 600dp: the size equals the type.display cap (40), never exceeding it', () => {
		const tr = renderCard({kind: 'code', code: 'WWWWWWWWWW'});
		fireFrameLayout(tr, 600);
		const value = tr.root.findByProps({testID: 'registration-code-value'});
		const flatStyle = Object.assign({}, ...[].concat(value.props.style));
		expect(flatStyle.fontSize).toBe(lightTheme.type.display.fontSize);
		expect(flatStyle.fontSize).toBe(40);
	});

	it('the code Text has no numberOfLines and maxFontSizeMultiplier equal to the literal 1', () => {
		const tr = renderCard({kind: 'code', code: 'WWWWWWWWWW'});
		fireFrameLayout(tr, 288);
		const value = tr.root.findByProps({testID: 'registration-code-value'});
		expect(value.props.numberOfLines).toBeUndefined();
		expect(value.props.maxFontSizeMultiplier).toBe(1);
	});
});

describe('fitRegistrationCodeFontSize', () => {
	it('matches the measured fixture values at 288/340/600dp', () => {
		expect(fitRegistrationCodeFontSize(288, 11, 40)).toBe(26);
		expect(fitRegistrationCodeFontSize(340, 11, 40)).toBe(30);
		expect(fitRegistrationCodeFontSize(600, 11, 40)).toBe(40);
	});

	it('clamps to the legibility floor (20) at width 0', () => {
		expect(fitRegistrationCodeFontSize(0, 11, 40)).toBe(20);
	});

	it('is monotonic non-decreasing in width', () => {
		const widths = [0, 100, 200, 288, 340, 400, 600, 1000];
		const sizes = widths.map(w => fitRegistrationCodeFontSize(w, 11, 40));
		for (let i = 1; i < sizes.length; i++) {
			expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
		}
	});

	it('CODE_GLYPH_EM_BUDGET is the literal 1.0 the component actually uses', () => {
		expect(CODE_GLYPH_EM_BUDGET).toBe(1.0);
	});
});

describe('RegistrationConfirmationCodeCard — before layout', () => {
	it('with useWindowDimensions mocked to width 360, the first render already satisfies F*11<=288 (seed = window width - 72)', () => {
		setWindowWidth(360);
		const tr = renderCard({kind: 'code', code: 'WWWWWWWWWW'});
		const value = tr.root.findByProps({testID: 'registration-code-value'});
		const flatStyle = Object.assign({}, ...[].concat(value.props.style));
		expect(flatStyle.fontSize * 11).toBeLessThanOrEqual(288);
	});
});
