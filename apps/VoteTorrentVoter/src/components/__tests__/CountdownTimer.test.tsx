/**
 * Unit tests for CountdownTimer (HOME-01, D-09) — first jest.useFakeTimers() consumer in this
 * app's test suite (RESEARCH.md §Wave 0 Gaps). Asserts the drift-free target-diff derivation:
 * recomputed from `targetIso` every tick, never a decrementing counter.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {StyleSheet, Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import {CountdownTimer} from '../CountdownTimer';
import {lightTheme} from '../../theme/themes';
import i18n from '../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** ~2h/5m/2s in the future from a fixed reference "now". */
const NOW = new Date('2026-07-09T12:00:00.000Z').getTime();
const FUTURE_ISO = new Date(NOW + (2 * 3600 + 5 * 60 + 2) * 1000).toISOString();

/**
 * D2 adaptive-unit / shrink-to-fit fixtures — each derived from NOW so they stay deterministic
 * under jest.setSystemTime(NOW). See this plan's <contract> section for the locked format()
 * discriminated union.
 */
/** Honest ~30-day remainder (30d 04h 12m); renders '30' / '04' / '12'. Not the 4304h dev-control
 * artifact (D-12) — this is a Jest fixture built directly from a targetIso. */
const LONG_ISO = new Date(NOW + (30 * 86400 + 4 * 3600 + 12 * 60) * 1000).toISOString();
/** Exactly totalSeconds === 86400 — the >=24h branch boundary, days unpadded '1'. */
const BOUNDARY_AT_ISO = new Date(NOW + 86_400_000).toISOString();
/** Exactly totalSeconds === 86399 — the <24h branch boundary, no days group. */
const BOUNDARY_BELOW_ISO = new Date(NOW + 86_399_000).toISOString();
/** 179-day remainder — the only way to reach a 3-digit displayed group (long bounds hours 0-23,
 * minutes 0-59), driving the h2 shrink step. */
const LONG_3DIGIT_ISO = new Date(NOW + 179 * 86_400_000).toISOString();

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

describe('CountdownTimer (HOME-01, D-09)', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);
	});

	// WR-03: the language reset belongs HERE, not as the last statement of the one test body that
	// changes it. `i18n` is a module singleton and `jest.config.js` declares no
	// `setupFilesAfterEnv`, so nothing resets it between tests. If an assertion in the `es`
	// iteration of the it.each below threw, the in-body restore never ran and every later test in
	// this file asserting 'hours'/'minutes'/'seconds' failed against 'horas'/'minutos'/'segundos'
	// -- burying the one real failure under a cascade of seven. Both sibling suites
	// (TimelineRow.test.tsx:49, TimelineRail.test.tsx:41) already reset it in an afterEach.
	//
	// The call is `renderer.act`-wrapped for the same reason the in-body ones are (IN-05): these
	// tests never unmount their trees, so an un-wrapped language switch re-renders every
	// still-mounted CountdownTimer. Measured: 171 "not wrapped in act(...)" warnings across the
	// 18 tests with a bare `await i18n.changeLanguage('en')` here, 0 with the wrapper.
	afterEach(async () => {
		jest.useRealTimers();
		await renderer.act(async () => {
			await i18n.changeLanguage('en');
		});
	});

	it('renders the correct HH:MM:SS three 2-digit groups on initial render', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});
		const text = tr.root.findAll(node => typeof node.props.children === 'string')
			.map(node => node.props.children)
			.join(' ');
		expect(text).toContain('02');
		expect(text).toContain('05');
		expect(text).toContain('02');
	});

	it.each([
		['a non-date string', 'not-a-date'],
		['an empty string', ''],
		['a truncated ISO fragment', '2026-13-45T99:99:99Z'],
	])('WR-09: an unparsable targetIso (%s) renders nothing instead of a NaN countdown', (_label, badIso) => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={badIso} />));
		});
		// Before the fix this rendered literal 'NaN : NaN : NaN' -- and because 'NaN'.length === 3,
		// maxDigits > 2 selected the SMALLER h2 shrink step, so it read as a legitimately shrunken
		// long countdown rather than as an error.
		const text = tr.root.findAll(node => typeof node.props.children === 'string')
			.map(node => node.props.children)
			.join(' ');
		expect(text).not.toContain('NaN');
		expect(tr.root.findAllByProps({testID: 'countdown-hours-value'}, {deep: false})).toHaveLength(0);
		expect(tr.toJSON()).toBeNull();
	});

	it('WR-09 (positive): a valid targetIso still renders its groups -- the guard does not blank a working countdown', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});
		expect(tr.toJSON()).not.toBeNull();
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('02');
	});

	/**
	 * CR-01. D2's shrink-to-fit scaled ONLY the digits, and derived its trigger from digit count
	 * alone -- but in the `short` (<24h) branch every group is pad()'d to 2 chars, so maxDigits is
	 * ALWAYS 2 and the shrink could never fire there. Meanwhile the LABELS are the widest element:
	 * on the Redmi 8 the >=24h labels already span ~362px of a ~371px card inner width, and the
	 * <24h branch swaps the narrowest label (DAYS) for the widest (SECONDS) -- ~427px EN, ~449px ES.
	 * These pin the MECHANISM (which type token each element resolves to). The WIDTH claim itself is
	 * Tier 2 -- scripts/run-timeline-geometry-proof.sh on real hardware.
	 */
	describe('CR-01: label shrink', () => {
		const labelSize = (tr: renderer.ReactTestRenderer, testID: string) => {
			const node = tr.root.findByProps({testID});
			return StyleSheet.flatten(node.props.style).fontSize;
		};
		const render = (iso: string) => {
			let tr!: renderer.ReactTestRenderer;
			renderer.act(() => {
				tr = renderer.create(withTheme(<CountdownTimer targetIso={iso} />));
			});
			return tr;
		};

		it.each([['en'], ['es']])('%s: the <24h branch shrinks its LABELS below caption -- the branch where shrink could never previously fire', async language => {
			// IN-05: act-wrapped -- changeLanguage triggers a useTranslation re-render.
			await renderer.act(async () => {
				await i18n.changeLanguage(language);
			});
			const tr = render(BOUNDARY_BELOW_ISO);
			expect(labelSize(tr, 'countdown-seconds-label')).toBe(lightTheme.type.captionSmall.fontSize);
			expect(labelSize(tr, 'countdown-seconds-label')).toBeLessThan(lightTheme.type.caption.fontSize);
			// IN-05: act-wrapped -- changeLanguage triggers a useTranslation re-render.
			await renderer.act(async () => {
				await i18n.changeLanguage('en');
			});
		});

		/**
		 * WR-02: parameterized over BOTH locales. `LABEL_CHAR_BUDGET` is 16 and the trigger is
		 * `> 16`, and BOTH shipped locales land EXACTLY on that boundary on this branch:
		 *   en -- days(4) + hours(5) + minutes(7) = 16
		 *   es -- días(4) + horas(5) + minutos(7) = 16   ('días' is FOUR characters: U+00ED is
		 *                                                 precomposed, so String.length is 4)
		 * so neither shrinks, and a ONE-CHARACTER copy change to any of those six labels flips
		 * the ordinary, most-common render into the shrunken step. Running this only under `en`
		 * left the es half of that unguarded and the symmetry itself unrecorded. The budget cannot
		 * be raised to buy margin -- 16 characters is the widest row device-verified to fit -- so
		 * the boundary is pinned by assertion instead. See CountdownTimer.tsx's WR-02 note.
		 *
		 * (The <24h rows are well clear of the budget -- en 5+7+7 = 19, es 5+7+8 = 20 -- and the
		 * it.each above pins that they DO shrink, so both directions of the trigger are covered.)
		 */
		it.each([['en'], ['es']])('%s: the ordinary >=24h branch does NOT shrink -- no visual regression for the common case', async language => {
			// IN-05: act-wrapped -- changeLanguage triggers a useTranslation re-render. The
			// restore to 'en' is the suite's afterEach (WR-03), so a failure here cannot leak.
			await renderer.act(async () => {
				await i18n.changeLanguage(language);
			});
			const tr = render(LONG_ISO);
			expect(labelSize(tr, 'countdown-days-label')).toBe(lightTheme.type.caption.fontSize);
			expect(StyleSheet.flatten(tr.root.findByProps({testID: 'countdown-days-value'}).props.style).fontSize).toBe(lightTheme.type.display.fontSize);
		});

		it('a >2-digit day count shrinks labels AND digits together -- the two can no longer disagree', () => {
			const tr = render(LONG_3DIGIT_ISO);
			expect(labelSize(tr, 'countdown-days-label')).toBe(lightTheme.type.captionSmall.fontSize);
			expect(StyleSheet.flatten(tr.root.findByProps({testID: 'countdown-days-value'}).props.style).fontSize).toBe(lightTheme.type.h2.fontSize);
		});
	});

	/**
	 * WR-01. The shrink-to-fit steps above are PIXEL measurements taken at DEFAULT OS text scale
	 * only (~329px EN / ~345px ES for the <24h label row, ~362px for the >=24h one, against a
	 * ~371px card inner width) -- so uncapped they hold at 1.0x and nowhere else, and Android's
	 * first step above default (*Large*, 1.15x) clips all three. The countdown therefore caps
	 * `maxFontSizeMultiplier` at 1. See CountdownTimer.tsx's WR-01 note for the ratified
	 * product/accessibility trade-off; this block pins that the cap is actually authored.
	 *
	 * It pins BOTH branches and, in each, BOTH the digits and the LABELS. Capping only the
	 * numerals would repeat CR-01 exactly -- that defect was a shrink step that reached the digits
	 * and left the labels, which are the wider element, untouched.
	 *
	 * Tier note: this asserts the authored prop, which is all Tier 1 can see. That scaled text
	 * actually stops growing on hardware is a Tier 2 claim.
	 */
	describe('WR-01: OS text-scaling cap', () => {
		/**
		 * Written as a literal rather than imported from the component on purpose: a test that
		 * reads the component's own constant agrees with whatever value the component picked,
		 * including a cap loosened past the 1.025 the >=24h row was measured to allow.
		 */
		const EXPECTED_CAP = 1;

		const render = (iso: string) => {
			let tr!: renderer.ReactTestRenderer;
			renderer.act(() => {
				tr = renderer.create(withTheme(<CountdownTimer targetIso={iso} />));
			});
			return tr;
		};
		const capOf = (tr: renderer.ReactTestRenderer, testID: string) =>
			tr.root.findByProps({testID}).props.maxFontSizeMultiplier;

		it.each<[string, string, string[]]>([
			['<24h', BOUNDARY_BELOW_ISO, ['hours', 'minutes', 'seconds']],
			['>=24h', LONG_ISO, ['days', 'hours', 'minutes']],
		])('%s branch: every digit AND every label caps font scaling at 1', (_branch, iso, groupIds) => {
			const tr = render(iso);
			// Non-vacuity first: prove the groups this branch is supposed to render are present,
			// so a rename of a testID cannot turn the assertions below into zero assertions.
			for (const id of groupIds) {
				expect(tr.root.findAllByProps({testID: `countdown-${id}-value`}).length).toBeGreaterThan(0);
				expect(tr.root.findAllByProps({testID: `countdown-${id}-label`}).length).toBeGreaterThan(0);
			}
			for (const id of groupIds) {
				expect(capOf(tr, `countdown-${id}-value`)).toBe(EXPECTED_CAP);
				expect(capOf(tr, `countdown-${id}-label`)).toBe(EXPECTED_CAP);
			}
		});

		it.each<[string, string]>([
			['<24h', BOUNDARY_BELOW_ISO],
			['>=24h', LONG_ISO],
		])('%s branch: NO Text node is left uncapped -- the separator colons included', (_branch, iso) => {
			const tr = render(iso);
			const texts = tr.root.findAllByType(Text);
			// 3 digit groups + 3 labels + 2 separator colons. Pinned, not just ">0": the colons
			// carry no testID, so a sweep that silently missed them would still look green.
			expect(texts).toHaveLength(8);
			const uncapped = texts.filter(node => node.props.maxFontSizeMultiplier !== EXPECTED_CAP);
			expect(uncapped.map(node => node.props.testID ?? `(untagged: ${String(node.props.children)})`)).toEqual([]);
		});
	});

	it('decrements the seconds group by exactly 1 after one 1000ms tick (recomputed from target, not a decrementing counter)', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});

		renderer.act(() => {
			jest.advanceTimersByTime(1000);
		});

		const seconds = tr.root.findByProps({testID: 'countdown-seconds-value'});
		expect(seconds.props.children).toBe('01');
	});

	it('renders 00:00:00 for a target in the past (Math.max(0, ...) floor, never negative)', () => {
		const pastIso = new Date(NOW - 60_000).toISOString();
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={pastIso} />));
		});
		const hours = tr.root.findByProps({testID: 'countdown-hours-value'});
		const minutes = tr.root.findByProps({testID: 'countdown-minutes-value'});
		const seconds = tr.root.findByProps({testID: 'countdown-seconds-value'});
		expect(hours.props.children).toBe('00');
		expect(minutes.props.children).toBe('00');
		expect(seconds.props.children).toBe('00');
	});

	it('resolves sub-labels from i18n keys countdown.hours/minutes/seconds', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});
		const hoursLabel = tr.root.findByProps({testID: 'countdown-hours-label'});
		const minutesLabel = tr.root.findByProps({testID: 'countdown-minutes-label'});
		const secondsLabel = tr.root.findByProps({testID: 'countdown-seconds-label'});
		expect(hoursLabel.props.children).toBe('hours');
		expect(minutesLabel.props.children).toBe('minutes');
		expect(secondsLabel.props.children).toBe('seconds');
	});

	it('renders DAYS:HOURS:MINUTES with an unpadded days group and no seconds group at a 30d04h12m remainder (>=24h branch)', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={LONG_ISO} />));
		});
		expect(tr.root.findByProps({testID: 'countdown-days-value'}).props.children).toBe('30');
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('04');
		expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('12');
		expect(tr.root.findByProps({testID: 'countdown-days-label'}).props.children).toBe('days');
		expect(tr.root.findAllByProps({testID: 'countdown-seconds-value'}).length).toBe(0);
	});

	it('picks the >=24h branch at exactly totalSeconds === 86400 (boundary, days is unpadded "1")', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={BOUNDARY_AT_ISO} />));
		});
		expect(tr.root.findByProps({testID: 'countdown-days-value'}).props.children).toBe('1');
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('00');
		expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('00');
		expect(tr.root.findAllByProps({testID: 'countdown-seconds-value'}).length).toBe(0);
	});

	it('picks the <24h branch at exactly totalSeconds === 86399 (boundary, no days group)', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={BOUNDARY_BELOW_ISO} />));
		});
		expect(tr.root.findAllByProps({testID: 'countdown-days-value'}).length).toBe(0);
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('23');
		expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('59');
		expect(tr.root.findByProps({testID: 'countdown-seconds-value'}).props.children).toBe('59');
	});

	it('shrink-to-fit keeps type.display (40/48) when the longest displayed group is <= 2 digits', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={LONG_ISO} />));
		});
		const days = tr.root.findByProps({testID: 'countdown-days-value'});
		const hours = tr.root.findByProps({testID: 'countdown-hours-value'});
		const minutes = tr.root.findByProps({testID: 'countdown-minutes-value'});
		for (const node of [days, hours, minutes]) {
			expect(node.props.style.fontSize).toBe(40);
			expect(node.props.style.lineHeight).toBe(48);
		}
	});

	it('shrink-to-fit steps down to type.h2 (28/34) when the longest displayed group is > 2 digits', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={LONG_3DIGIT_ISO} />));
		});
		const days = tr.root.findByProps({testID: 'countdown-days-value'});
		expect(days.props.children).toBe('179');
		const hours = tr.root.findByProps({testID: 'countdown-hours-value'});
		const minutes = tr.root.findByProps({testID: 'countdown-minutes-value'});
		for (const node of [days, hours, minutes]) {
			expect(node.props.style.fontSize).toBe(28);
			expect(node.props.style.lineHeight).toBe(34);
		}
	});

	it('nowOffsetMs (not Date.now()) sets the reference clock, and a changed nowOffsetMs resyncs immediately', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} nowOffsetMs={0} />));
		});
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('02');

		renderer.act(() => {
			tr.update(withTheme(<CountdownTimer targetIso={FUTURE_ISO} nowOffsetMs={3_600_000} />));
		});
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('01');
		expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('05');
	});
});
