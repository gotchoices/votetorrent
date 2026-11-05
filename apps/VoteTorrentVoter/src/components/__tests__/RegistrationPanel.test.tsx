/**
 * RegistrationPanel.test.tsx (Phase 59 plan 59-09) — the D-23 panel gate `59-VALIDATION.md` names
 * by this exact filename. Constructs `TimelineRegistrationPanel` fixtures directly (no
 * `VoterAppProvider`/navigator) since the panel never calls `useVoterApp()` or `useNavigation()`
 * (mirrors `ElectionCard.test.tsx`'s convention). Uses the production-length network fixture
 * (`59-UI-SPEC.md`'s 49-char "Salt Lake County Unified School District Network") throughout.
 *
 * Two cases carry the load and must not be softened into presence checks (per the plan's own
 * instruction): the no-unresolved-placeholder gate (`describe` block below) and the bold-run
 * position proof. Both are non-vacuity-proven — see this session's SUMMARY for the deliberate
 * `bold`-param-removal RED/GREEN observation this file's `describe` block below was checked
 * against before being trusted.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text as RNText} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import i18n, {resources} from '../../i18n';
import {TimelineRegistrationPanel} from '../TimelineRegistrationPanel';
import type {TimelineRegistrationPanelProps} from '../TimelineRegistrationPanel';
import {lightTheme} from '../../theme/themes';
import type {RegistrationStatusKind} from '../../engines/registration-status';

const NETWORK_NAME = 'Salt Lake County Unified School District Network'; // 49 chars, UI-SPEC fixture
const BOLD_SENTINEL_LITERAL = '\u0000BOLD\u0000';
const STATUS_KINDS: RegistrationStatusKind[] = ['registered', 'pending', 'notRegistered', 'indeterminate'];
const LANGUAGES = ['en', 'es'] as const;

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderPanel(overrides: Partial<TimelineRegistrationPanelProps> = {}) {
	const props: TimelineRegistrationPanelProps = {
		status: 'registered',
		networkName: NETWORK_NAME,
		isBeforeDeadline: true,
		onEditRegistration: jest.fn(),
		onViewRegistration: jest.fn(),
		...overrides,
	};
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<TimelineRegistrationPanel {...props} />));
	});
	activeRenderers.push(tr);
	return {tr, props};
}

/** Flattens a JSX children value (string | number | element | array | null | undefined) down to
 * its own DIRECT string content only — does not recurse into nested React elements (those are
 * captured separately since `findAllByType` visits every `<Text>` node in the tree). */
function flattenOwnStrings(children: unknown): string {
	if (children === null || children === undefined || typeof children === 'boolean') return '';
	if (typeof children === 'string' || typeof children === 'number') return String(children);
	if (Array.isArray(children)) return children.map(flattenOwnStrings).join('');
	return '';
}

/** Concatenates every rendered `<Text>` run's own string content under `root`, in tree order —
 * used both for the no-unresolved-placeholder gate and the full-fixture substring check. Every
 * `<Text>` node (outer sentence, nested bold run, CTA) is visited, so nothing is missed even
 * though the outer sentence's OWN flatten skips its nested-element child. */
function concatenatedText(root: renderer.ReactTestInstance): string {
	return root
		.findAllByType(RNText)
		.map(node => flattenOwnStrings(node.props.children))
		.join('');
}

async function setLanguage(lang: (typeof LANGUAGES)[number]) {
	await renderer.act(async () => {
		await i18n.changeLanguage(lang);
	});
}

afterEach(async () => {
	while (activeRenderers.length) {
		const tr = activeRenderers.pop()!;
		renderer.act(() => {
			tr.unmount();
		});
	}
	// The global i18next instance is a module-level singleton -- restore the default language so
	// a language change made by one test can't leak into a later test file.
	await setLanguage('en');
});

describe('TimelineRegistrationPanel (D-23 panel gate)', () => {
	test('all four states render a non-empty, distinct sentence -- none renders null or blank', () => {
		const seen = new Set<string>();
		for (const status of STATUS_KINDS) {
			const {tr} = renderPanel({status});
			expect(tr.toJSON()).not.toBeNull();
			const sentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
			const text = flattenOwnStrings(sentence.props.children) + concatenatedText(sentence);
			expect(text.trim().length).toBeGreaterThan(0);
			seen.add(text);
		}
		// Four distinct sentences -- pending never renders the registered/not-registered copy and
		// vice versa.
		expect(seen.size).toBe(STATUS_KINDS.length);
	});

	test('registered renders the isRegistered sentence with the real network name interpolated', () => {
		const {tr} = renderPanel({status: 'registered'});
		const text = concatenatedText(tr.root);
		expect(text).toContain(NETWORK_NAME);
		expect(text).toContain(resources.en.timeline['registration.isRegisteredBold']);
	});

	test('pending renders the pending sentence -- not the registered one and not the not-registered one', () => {
		const {tr} = renderPanel({status: 'pending'});
		const sentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
		const text = flattenOwnStrings(sentence.props.children);
		expect(text).toBe(resources.en.timeline['registration.pending'].replace('{{network}}', NETWORK_NAME));
	});

	test('notRegistered renders the not-registered sentence', () => {
		const {tr} = renderPanel({status: 'notRegistered'});
		const sentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
		const text = flattenOwnStrings(sentence.props.children);
		expect(text).toBe(resources.en.timeline['registration.notRegistered'].replace('{{network}}', NETWORK_NAME));
	});

	test('indeterminate renders the unknown copy and renders no registration sentence (no nested bold run)', () => {
		const {tr} = renderPanel({status: 'indeterminate'});
		const sentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
		const text = flattenOwnStrings(sentence.props.children);
		expect(text).toBe(resources.en.timeline['registration.unknown']);
		expect(tr.root.findAllByType(RNText, {deep: false}).length).toBeLessThanOrEqual(2); // sentence + CTA, no nested bold
	});

	describe('CTA branches on isBeforeDeadline alone (F7), for both registered and notRegistered', () => {
		it.each<RegistrationStatusKind>(['registered', 'notRegistered'])('%s: isBeforeDeadline=true renders editCta, false renders viewCta', status => {
			const before = renderPanel({status, isBeforeDeadline: true});
			const beforeCta = before.tr.root.findByProps({testID: 'timeline-registration-panel-cta'});
			expect(flattenOwnStrings(beforeCta.findByType(RNText).props.children)).toBe(resources.en.timeline['registration.editCta']);

			const after = renderPanel({status, isBeforeDeadline: false});
			const afterCta = after.tr.root.findByProps({testID: 'timeline-registration-panel-cta'});
			expect(flattenOwnStrings(afterCta.findByType(RNText).props.children)).toBe(resources.en.timeline['registration.viewCta']);
		});
	});

	test('pressing the CTA before the deadline invokes onEditRegistration exactly once', () => {
		const onEditRegistration = jest.fn();
		const {tr} = renderPanel({isBeforeDeadline: true, onEditRegistration});
		const cta = tr.root.findByProps({testID: 'timeline-registration-panel-cta'});
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(onEditRegistration).toHaveBeenCalledTimes(1);
	});

	test('pressing the CTA after the deadline invokes onViewRegistration exactly once', () => {
		const onViewRegistration = jest.fn();
		const {tr} = renderPanel({isBeforeDeadline: false, onViewRegistration});
		const cta = tr.root.findByProps({testID: 'timeline-registration-panel-cta'});
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(onViewRegistration).toHaveBeenCalledTimes(1);
	});

	test('the production-length network fixture renders in full, not a truncated prefix', () => {
		const {tr} = renderPanel({status: 'registered'});
		const text = concatenatedText(tr.root);
		// Substring equality against the WHOLE fixture -- not a `toContain` on a shortened prefix.
		expect(text.includes(NETWORK_NAME)).toBe(true);
		// 59-UI-SPEC.md documents this fixture as "49 chars"; the literal string is actually 48 --
		// a harmless off-by-one in the spec's own prose (recorded in this plan's SUMMARY). Asserted
		// as "long enough to prove wrapping, not a hand-copied magic number" rather than re-stating
		// the spec's own miscount.
		expect(NETWORK_NAME.length).toBeGreaterThan(40);
	});

	describe('the bold run is a nested <Text> split on the {{bold}} sentinel, position proven per-language', () => {
		// `sentence` IS itself a RNText instance -- `sentence.findByType(RNText)` would match
		// `sentence` itself (react-test-renderer's `find*` helpers include the root when it
		// satisfies the predicate), not its nested bold child. Read the nested bold ELEMENT
		// directly off `sentence.props.children` instead.
		test('EN: a non-empty prefix run precedes the bold run', async () => {
			await setLanguage('en');
			const {tr} = renderPanel({status: 'registered'});
			const sentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
			const children = sentence.props.children as unknown[];
			expect(Array.isArray(children)).toBe(true);
			expect((children[0] as string).length).toBeGreaterThan(0); // non-empty prefix precedes it (EN)

			const boldElement = children[1] as React.ReactElement<{children: unknown}>;
			expect(flattenOwnStrings(boldElement.props.children)).toBe(resources.en.timeline['registration.isRegisteredBold']);
		});

		test('ES: the bold run leads (empty prefix)', async () => {
			await setLanguage('es');
			const {tr} = renderPanel({status: 'registered'});
			const sentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
			const children = sentence.props.children as unknown[];
			expect(Array.isArray(children)).toBe(true);
			expect(children[0]).toBe(''); // the bold run LEADS -- no prefix run precedes it (ES)

			const boldElement = children[1] as React.ReactElement<{children: unknown}>;
			expect(flattenOwnStrings(boldElement.props.children)).toBe(resources.es.timeline['registration.isRegisteredBold']);
		});
	});

	// Generated from the four kinds x two languages, per the plan's explicit instruction -- not
	// hand-copied. This is the regression gate for the `{{bold}}` defect F6 describes.
	describe('no state ever leaks an unresolved placeholder, in either language', () => {
		for (const lang of LANGUAGES) {
			for (const status of STATUS_KINDS) {
				test(`[${lang}] ${status} renders no literal {{ and no bold sentinel`, async () => {
					await setLanguage(lang);
					const {tr} = renderPanel({status});
					const text = concatenatedText(tr.root);
					expect(text).not.toContain('{{');
					expect(text).not.toContain(BOLD_SENTINEL_LITERAL);
				});
			}
		}
	});
});
