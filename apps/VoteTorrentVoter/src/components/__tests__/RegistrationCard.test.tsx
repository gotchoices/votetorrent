/**
 * Unit tests for RegistrationCard (REG-01/REG-05) — the 2-state presentational card (not-registered
 * / registered) driven by the `isRegistered` prop. Constructs fixture `RegistrationDraft` objects
 * directly (no `VoterAppProvider`/`RegistrationDraftProvider`/navigator) since `RegistrationCard`
 * never calls `useVoterApp()` or `useNavigation()` — mirrors `ElectionCard.test.tsx`'s
 * presentational-component test pattern.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {RegistrationCard, computeValidThrough} from '../RegistrationCard';
import {EMPTY_DRAFT} from '../../providers/RegistrationDraftProvider';
import type {RegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {lightTheme} from '../../theme/themes';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

// party is the stable KEY ('democratic'), not a localized label — RegistrationCard resolves
// it to the current-locale label at render time (Manual-QA gap-closure, Phase 41).
const REGISTERED_DRAFT: RegistrationDraft = {
	...EMPTY_DRAFT,
	firstName: 'John',
	lastName: 'Smith',
	party: 'democratic',
	dob: '1/23/01',
};

// Fixed ISO so computeValidThrough / the rendered badge is deterministic across test runs.
const FIXED_REGISTERED_AT = '2025-02-27T12:00:00.000Z';

type Callbacks = Partial<{
	onRegisterNow: () => void;
	onUpdateRegistration: () => void;
	onHelp: () => void;
}>;

function renderCard(
	props: {isRegistered: boolean; draft: RegistrationDraft; registeredAt: string | null},
	callbacks: Callbacks = {},
) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<RegistrationCard {...props} {...callbacks} />));
	});
	return tr;
}

describe('RegistrationCard (REG-01/REG-05)', () => {
	describe('not-registered', () => {
		it('renders the heading, body, and Register-now CTA firing onRegisterNow', () => {
			const onRegisterNow = jest.fn();
			const tr = renderCard({isRegistered: false, draft: EMPTY_DRAFT, registeredAt: null}, {onRegisterNow});

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('You are not registered');

			const cta = tr.root.findByProps({testID: 'registration-card-register-now'});
			renderer.act(() => {
				cta.props.onPress();
			});
			expect(onRegisterNow).toHaveBeenCalledTimes(1);
		});

		it('does not render the registered-only identity line or update CTA', () => {
			const tr = renderCard({isRegistered: false, draft: EMPTY_DRAFT, registeredAt: null});
			expect(tr.root.findAllByProps({testID: 'registration-card-identity-line'}).length).toBe(0);
			expect(tr.root.findAllByProps({testID: 'registration-card-update'}).length).toBe(0);
		});
	});

	describe('registered', () => {
		it('renders the heading, draft-derived identity line, valid-through badge, and Update CTA firing onUpdateRegistration', () => {
			const onUpdateRegistration = jest.fn();
			const tr = renderCard(
				{isRegistered: true, draft: REGISTERED_DRAFT, registeredAt: FIXED_REGISTERED_AT},
				{onUpdateRegistration},
			);

			const fullText = JSON.stringify(tr.toJSON());
			expect(fullText).toContain("You're registered to vote");

			const identityLine = tr.root.findByProps({testID: 'registration-card-identity-line'});
			const identityText = JSON.stringify(identityLine.props.children);
			expect(identityText).toContain('John Smith');
			expect(identityText).toContain('Democratic Party');
			expect(identityText).toContain('1/23/01');

			const validThroughBadge = tr.root.findByProps({testID: 'registration-card-valid-through'});
			const validThroughText = JSON.stringify(validThroughBadge.props.children);
			expect(validThroughText).toContain(computeValidThrough(FIXED_REGISTERED_AT));

			const cta = tr.root.findByProps({testID: 'registration-card-update'});
			renderer.act(() => {
				cta.props.onPress();
			});
			expect(onUpdateRegistration).toHaveBeenCalledTimes(1);
		});

		// Manual-QA gap-closure (Phase 41 re-verification): party is a stable KEY resolved via
		// t('form.party.' + key) at this display site — with no party selected (''), the guard
		// must render an empty value rather than the broken t('form.party.') string.
		it('renders an empty party segment in the identity line when draft.party is unselected (empty-key guard)', () => {
			const tr = renderCard({
				isRegistered: true,
				draft: {...REGISTERED_DRAFT, party: ''},
				registeredAt: FIXED_REGISTERED_AT,
			});

			const identityLine = tr.root.findByProps({testID: 'registration-card-identity-line'});
			const identityText = JSON.stringify(identityLine.props.children);
			expect(identityText).not.toContain('form.party.');
		});

		it('fires onHelp from the (?) help affordance', () => {
			const onHelp = jest.fn();
			const tr = renderCard(
				{isRegistered: true, draft: REGISTERED_DRAFT, registeredAt: FIXED_REGISTERED_AT},
				{onHelp},
			);

			const helpButton = tr.root.findByProps({testID: 'registration-card-help'});
			renderer.act(() => {
				helpButton.props.onPress();
			});
			expect(onHelp).toHaveBeenCalledTimes(1);
		});
	});

	describe('computeValidThrough', () => {
		it('parses registeredAt, adds 1 year, and formats MM/DD/YY deterministically', () => {
			expect(computeValidThrough(FIXED_REGISTERED_AT)).toBe('02/27/26');
		});

		it('returns an empty string when registeredAt is null', () => {
			expect(computeValidThrough(null)).toBe('');
		});
	});
});
