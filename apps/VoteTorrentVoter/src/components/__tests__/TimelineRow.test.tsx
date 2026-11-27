/**
 * Unit tests for TimelineRow (59-07 Task 1) -- per-stage action-surface, de-emphasis, a11y-label
 * and i18n-key-resolution assertions. Follows `ElectionCard.test.tsx`'s conventions: real
 * `react-test-renderer`, `withTheme()` wrapping `lightTheme`, `import '../../i18n'` to
 * initialize the global i18next instance, and tracked renderers unmounted in `afterEach` (the
 * Voting Period `current` case mounts a real `setInterval` via `CountdownTimer`).
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {Text, View} from 'react-native';
import {ROW_DISPLAY, TimelineRow} from '../TimelineRow';
import type {TimelineRowProps} from '../TimelineRow';
import {CountdownTimer} from '../CountdownTimer';
import {lightTheme} from '../../theme/themes';
import {TIMELINE_STAGE_IDS} from '../../timeline';
import {
	buildRowFixture,
	buildRowFixtureWithLongCountdown,
	FIXTURE_NOW_MS,
	PRODUCTION_ELECTION_TITLE,
	PRODUCTION_NETWORK_NAME,
} from '../__fixtures__/timeline-fixtures';
import {TIMELINE_CARD_MARGIN_V} from '../timeline-layout';
import i18n, {resources} from '../../i18n';

function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderRow(props: TimelineRowProps) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<TimelineRow {...props} />));
	});
	activeRenderers.push(tr);
	return tr;
}

afterEach(() => {
	while (activeRenderers.length) {
		const tr = activeRenderers.pop()!;
		renderer.act(() => {
			tr.unmount();
		});
	}
	i18n.changeLanguage('en');
});

const CLOSE_ISO = new Date(FIXTURE_NOW_MS + 3600_000).toISOString();

/** Flattens an RN style array/object the same way `TimelineRail.test.tsx`'s established idiom
 * does (line 78 there) -- reused here verbatim rather than inventing a second flatten helper. */
function flattenStyle(node: {props: {style?: unknown}}): Record<string, unknown> {
	const style = node.props.style;
	return Object.assign({}, ...(Array.isArray(style) ? style : [style]));
}

describe('TimelineRow (59-07)', () => {
	it('a current Voting Period row with onVoteNow renders a primary "Vote now" button and a CountdownTimer targeting the supplied close instant', () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'current', instantMs: FIXTURE_NOW_MS - 1000});
		const onVoteNow = jest.fn();
		const tr = renderRow({row, onVoteNow, countdownTargetIso: CLOSE_ISO});

		const button = tr.root.findByProps({testID: 'timeline-row-vote-now-votingStarts'});
		expect(button.props.style).toEqual(expect.arrayContaining([expect.objectContaining({backgroundColor: lightTheme.colors.primary})]));
		renderer.act(() => {
			button.props.onPress();
		});
		expect(onVoteNow).toHaveBeenCalledTimes(1);

		const countdown = tr.root.findByType(CountdownTimer);
		expect(countdown.props.targetIso).toBe(CLOSE_ISO);
	});

	it('a future Voting Period row renders the "Preview ballot" link and no "Vote now" button and no countdown', () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'future'});
		const tr = renderRow({row, onPreviewBallot: jest.fn(), onVoteNow: jest.fn(), countdownTargetIso: CLOSE_ISO});

		expect(tr.root.findAllByProps({testID: 'timeline-row-preview-ballot-votingStarts'}, {deep: false}).length).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-row-vote-now-votingStarts'}, {deep: false}).length).toBe(0);
		expect(tr.root.findAllByType(CountdownTimer, {deep: false}).length).toBe(0);
	});

	it('a past Voting Period row renders "View saved vote", not "Preview ballot" or "Vote now"', () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'past'});
		const tr = renderRow({row, onViewSubmission: jest.fn(), onPreviewBallot: jest.fn(), onVoteNow: jest.fn()});

		expect(tr.root.findAllByProps({testID: 'timeline-row-view-submission-votingStarts'}, {deep: false}).length).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-row-preview-ballot-votingStarts'}, {deep: false}).length).toBe(0);
		expect(tr.root.findAllByProps({testID: 'timeline-row-vote-now-votingStarts'}, {deep: false}).length).toBe(0);
	});

	it('TR1: a current Voting Period row with only onViewSubmission renders "View saved vote" once and no "Vote now"', () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'current', instantMs: FIXTURE_NOW_MS - 1000});
		const tr = renderRow({row, onViewSubmission: jest.fn(), countdownTargetIso: CLOSE_ISO});

		expect(tr.root.findAllByProps({testID: 'timeline-row-view-submission-votingStarts'}, {deep: false}).length).toBe(1);
		expect(countResolvedText(tr, 'View saved vote')).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-row-vote-now-votingStarts'}, {deep: false}).length).toBe(0);
	});

	it('TR2: a current row with both callbacks renders both, Vote now first', () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'current', instantMs: FIXTURE_NOW_MS - 1000});
		const tr = renderRow({row, onVoteNow: jest.fn(), onViewSubmission: jest.fn(), countdownTargetIso: CLOSE_ISO});

		const ids = tr.root
			.findAll(n => typeof n.type === 'string' && typeof n.props.testID === 'string' && /^timeline-row-(vote-now|view-submission)-votingStarts$/.test(n.props.testID))
			.map(n => n.props.testID as string);
		expect(ids).toEqual(['timeline-row-vote-now-votingStarts', 'timeline-row-view-submission-votingStarts']);
	});

	it('TR3: a future Voting Period row with both previewBallot and onViewSubmission renders preview-ballot only', () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'future'});
		const tr = renderRow({row, onViewSubmission: jest.fn(), onPreviewBallot: jest.fn()});

		expect(tr.root.findAllByProps({testID: 'timeline-row-preview-ballot-votingStarts'}, {deep: false}).length).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-row-view-submission-votingStarts'}, {deep: false}).length).toBe(0);
	});

	// IN-01: mirrors TimelineRail.test.tsx:298's predicate. Counting RESOLVED TEXT, not a testID,
	// is what makes the D1 assertions below able to fail: the row's own testID is derived from
	// `action.id`, so a duplicate re-added under any other id would be invisible to a testID check.
	// This is its own positive control -- the sibling tests that assert `=== 1` for other labels
	// would fail just as loudly if the predicate could never match.
	function countResolvedText(tr: renderer.ReactTestRenderer, expectedText: string): number {
		return tr.root.findAll(node => node.type === Text && node.props.children === expectedText).length;
	}

	it('D1: a past Registration Ends row renders no "View registration" action of its own -- that affordance belongs solely to TimelineRegistrationPanel\'s CTA -- while still rendering "See details" and no "Edit registration"', () => {
		const row = buildRowFixture({stageId: 'registrationEnds', status: 'past'});
		const tr = renderRow({row, onSeeDetails: jest.fn(), onEditRegistration: jest.fn()});

		// IN-01: assert on RESOLVED TEXT, not on the absence of a testID. The old form checked for
		// `timeline-row-view-registration-registrationEnds`, built as 'timeline-row-' + action.id +
		// '-' + stageId -- but buildActions no longer emits ANY descriptor with id 'view-registration',
		// so a regression re-adding the CTA under a different action.id (say 'view-reg') would have
		// left it green. Counting the rendered label catches the affordance whatever its id.
		expect(countResolvedText(tr, i18n.t('registration.viewCta', {ns: 'timeline'}))).toBe(0);
		// POSITIVE CONTROL for the predicate above. Every countResolvedText assertion in this file is
		// `=== 0`, so a predicate that could never match would satisfy all of them vacuously -- the
		// exact shape of defect this phase keeps finding. This line proves the matcher is live by
		// counting a label that IS rendered on this very row.
		expect(countResolvedText(tr, i18n.t('row.detailsCta', {ns: 'timeline'}))).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-row-see-details-registrationEnds'}, {deep: false}).length).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-row-edit-registration-registrationEnds'}, {deep: false}).length).toBe(0);
	});

	it.each(['current', 'future'] as const)('a %s Registration Ends row renders "Edit registration" and no "See details"', status => {
		const row = buildRowFixture({stageId: 'registrationEnds', status});
		const tr = renderRow({row, onEditRegistration: jest.fn(), onSeeDetails: jest.fn()});

		expect(tr.root.findAllByProps({testID: 'timeline-row-edit-registration-registrationEnds'}, {deep: false}).length).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-row-see-details-registrationEnds'}, {deep: false}).length).toBe(0);
		// IN-01: resolved text, not a testID that no code path emits -- see the D1 test above.
		expect(countResolvedText(tr, i18n.t('registration.viewCta', {ns: 'timeline'}))).toBe(0);
	});

	it('a future row renders its title in colors.textSecondary and does not render the panel slot even when a panel node is supplied', () => {
		const row = buildRowFixture({stageId: 'accruingVotes', status: 'future'});
		const tr = renderRow({row, panel: <Text testID="panel-content">panel</Text>});

		const title = tr.root.findByProps({testID: 'timeline-row-title-accruingVotes'});
		expect(title.props.style).toEqual(expect.objectContaining({color: lightTheme.colors.textSecondary}));
		expect(tr.root.findAllByProps({testID: 'timeline-row-panel-accruingVotes'}, {deep: false}).length).toBe(0);
	});

	it('a past or current row DOES render the panel slot when supplied', () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'current', instantMs: FIXTURE_NOW_MS - 1000});
		const tr = renderRow({row, panel: <Text testID="panel-content">panel</Text>, countdownTargetIso: CLOSE_ISO});

		expect(tr.root.findAllByProps({testID: 'timeline-row-panel-votingStarts'}, {deep: false}).length).toBe(1);
	});

	it.each(TIMELINE_STAGE_IDS)('the help Pressable for %s carries an accessibilityLabel containing its own translated title and a >=44x44 target', stageId => {
		const row = buildRowFixture({stageId, status: 'past'});
		const tr = renderRow({row});

		const help = tr.root.findByProps({testID: 'timeline-row-help-' + stageId});
		const expectedTitle = i18n.t(ROW_DISPLAY[stageId].titleKey, {ns: 'timeline'});
		expect(help.props.accessibilityLabel).toContain(expectedTitle);
		expect(help.props.style).toEqual(expect.objectContaining({minWidth: 44, minHeight: 44}));
	});

	it.each(['past', 'current', 'future'] as const)('a releasingKeys row in %s status with onViewKeyholders renders the outline "View Keyholders" button', status => {
		const row = buildRowFixture({stageId: 'releasingKeys', status});
		const tr = renderRow({row, onViewKeyholders: jest.fn()});

		const button = tr.root.findByProps({testID: 'timeline-row-view-keyholders-releasingKeys'});
		expect(button.props.style).toEqual(
			expect.arrayContaining([
				expect.objectContaining({borderColor: lightTheme.colors.primary, backgroundColor: lightTheme.colors.secondaryButtonSurface}),
			]),
		);
	});

	it.each(['past', 'current'] as const)('a tallyingStarts row in %s status with onViewResults renders "View results" and calls it', status => {
		const row = buildRowFixture({stageId: 'tallyingStarts', status});
		const onViewResults = jest.fn();
		const tr = renderRow({row, onViewResults});
		const button = tr.root.findByProps({testID: 'timeline-row-view-results-tallyingStarts'});
		renderer.act(() => button.props.onPress());
		expect(onViewResults).toHaveBeenCalledTimes(1);
	});

	it('a future tallyingStarts row, and every other stage, never offers "View results"', () => {
		const future = renderRow({row: buildRowFixture({stageId: 'tallyingStarts', status: 'future'}), onViewResults: jest.fn()});
		expect(future.root.findAll(n => n.props?.testID === 'timeline-row-view-results-tallyingStarts')).toHaveLength(0);
		const other = renderRow({row: buildRowFixture({stageId: 'releasingKeys', status: 'past'}), onViewResults: jest.fn()});
		expect(other.root.findAll(n => typeof n.props?.testID === 'string' && n.props.testID.startsWith('timeline-row-view-results'))).toHaveLength(0);
	});

	it('an action whose callback is NOT supplied is not rendered', () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'current', instantMs: FIXTURE_NOW_MS - 1000});
		const tr = renderRow({row}); // no onVoteNow

		expect(tr.root.findAllByProps({testID: 'timeline-row-vote-now-votingStarts'}, {deep: false}).length).toBe(0);
	});

	it('Object.keys(ROW_DISPLAY) has exactly 10 entries equal to the D-09 stage id set, with no keyholder stage', () => {
		const keys = Object.keys(ROW_DISPLAY);
		expect(keys).toHaveLength(10);
		expect(new Set(keys)).toEqual(new Set(TIMELINE_STAGE_IDS));
		for (const forbidden of ['keyholderInvited', 'keyholderAccepted', 'keyholderRevoked', 'KI', 'KA', 'KR']) {
			expect(keys).not.toContain(forbidden);
		}
	});

	it('i18n contract: every titleKey in ROW_DISPLAY and every literal CTA/help key resolves in both EN and ES timeline resources', () => {
		const en = resources.en.timeline as unknown as Record<string, string>;
		const es = resources.es.timeline as unknown as Record<string, string>;

		const usedKeys = [
			...Object.values(ROW_DISPLAY).map(d => d.titleKey),
			'help.accessibilityLabel',
			'registration.viewCta',
			'registration.editCta',
			'voting.previewBallotCta',
			'voting.voteNowCta',
			'voting.viewSubmissionCta',
			'row.detailsCta',
			'keyholders.viewCta',
		];

		for (const key of usedKeys) {
			expect(typeof en[key]).toBe('string');
			expect(en[key].length).toBeGreaterThan(0);
			expect(typeof es[key]).toBe('string');
			expect(es[key].length).toBeGreaterThan(0);
		}
	});

	// Measured length, not the plan/UI-SPEC's stated "53/49 chars" -- both cite that count for
	// this exact literal string, but `String.prototype.length` on the literal itself measures 51
	// and 48. Pinning the MEASURED value (not the documentation's claim) so a later accidental
	// shortening of the string still trips this guard -- see the SUMMARY's "Deviations" section.
	it('fixture-length guard: PRODUCTION_ELECTION_TITLE and PRODUCTION_NETWORK_NAME stay at their measured production length', () => {
		expect(PRODUCTION_ELECTION_TITLE.length).toBe(51);
		expect(PRODUCTION_NETWORK_NAME.length).toBe(48);
	});

	// WR-08: renamed from "no-clipping guard", which overclaimed. The ABSENCE of numberOfLines /
	// ellipsizeMode is the precondition for overflow, not evidence against it -- a Text with no
	// numberOfLines wraps or overruns its parent rather than truncating, so this assertion cannot
	// fail on a clipping defect and never could. What it genuinely pins is the NO-TRUNCATION
	// contract: production-length strings must stay fully readable, never elided to "Red Rock Vot...".
	// Clipping is geometry and RN's test renderer has no layout engine, so it is provable only at
	// Tier 2 -- scripts/run-timeline-geometry-proof.sh's `clipping` leg, which measures text bounds
	// against card bounds on a real device (all four edges since WR-07).
	// This rename is itself a CR-01 lesson: a test whose NAME claims more than its assertions
	// deliver is precisely how the sub-24h countdown overflow survived a fully green suite.
	it('no-truncation guard: under the ES locale with the 49-char network string in the panel slot, no Text node sets numberOfLines or ellipsizeMode (full text stays readable; CLIPPING is Tier 2, see run-timeline-geometry-proof.sh)', () => {
		// IN-05: wrapped so a genuine act() violation later is not lost in this file's own noise.
		renderer.act(() => {
			i18n.changeLanguage('es');
		});
		const row = buildRowFixture({stageId: 'votingStarts', status: 'current', instantMs: FIXTURE_NOW_MS - 1000});
		const tr = renderRow({
			row,
			countdownTargetIso: CLOSE_ISO,
			panel: <Text>{PRODUCTION_NETWORK_NAME}</Text>,
		});

		const textNodes = tr.root.findAllByType(Text);
		for (const node of textNodes) {
			expect(node.props.numberOfLines).toBeUndefined();
			expect(node.props.ellipsizeMode).toBeUndefined();
		}
		// IN-05: wrapped so a genuine act() violation later is not lost in this file's own noise.
		renderer.act(() => {
			i18n.changeLanguage('en');
		});
	});

	it('the notch element exists with testID timeline-row-notch-<stageId> and derives its top from typeScale.h4.lineHeight', () => {
		const row = buildRowFixture({stageId: 'closed', status: 'future'});
		const tr = renderRow({row});

		const notch = tr.root.findByProps({testID: 'timeline-row-notch-closed'});
		const expectedTop = 16 + lightTheme.type.h4.lineHeight / 2 - 8;
		expect(notch.props.style).toEqual(expect.arrayContaining([expect.objectContaining({top: expectedTop})]));
	});

	it("61-06 D-08: the card's marginVertical is the hoisted TIMELINE_CARD_MARGIN_V", () => {
		const row = buildRowFixture({stageId: 'closed', status: 'future'});
		const tr = renderRow({row});

		const card = tr.root.findAllByType(View)[0];
		const flat = flattenStyle(card);
		expect(TIMELINE_CARD_MARGIN_V).toBe(16);
		expect(flat.marginVertical).toBe(TIMELINE_CARD_MARGIN_V);
	});

	it("61-06 D-08: a current row's accent-bar segments split around the notch, consuming the notch's own values", () => {
		const row = buildRowFixture({stageId: 'votingStarts', status: 'current', instantMs: FIXTURE_NOW_MS - 1000});
		const tr = renderRow({row});

		const notch = tr.root.findByProps({testID: 'timeline-row-notch-votingStarts'});
		const notchFlat = flattenStyle(notch);
		const notchHeight = (notchFlat.borderTopWidth as number) + (notchFlat.borderBottomWidth as number);
		// Notch pinned unchanged first -- the accent split below must consume THESE values, not a
		// second guessed pixel pair.
		expect(notchFlat.borderTopWidth).toBe(8);
		expect(notchFlat.borderBottomWidth).toBe(8);
		expect(notchFlat.borderRightWidth).toBe(8);
		expect(notchFlat.left).toBe(-8);
		expect(notchFlat.top).toBe(16 + lightTheme.type.h4.lineHeight / 2 - 8);

		const aboveNodes = tr.root.findAllByProps({testID: 'timeline-row-accent-votingStarts-above'}, {deep: false});
		const belowNodes = tr.root.findAllByProps({testID: 'timeline-row-accent-votingStarts-below'}, {deep: false});
		expect(aboveNodes.length).toBe(1);
		expect(belowNodes.length).toBe(1);

		const aboveFlat = flattenStyle(aboveNodes[0]);
		const belowFlat = flattenStyle(belowNodes[0]);

		expect(aboveFlat.position).toBe('absolute');
		expect(aboveFlat.left).toBe(0);
		expect(aboveFlat.width).toBe(4);
		expect(aboveFlat.backgroundColor).toBe(lightTheme.colors.primary);
		expect(aboveFlat.top).toBe(0);
		// The single most important assertion in this plan: the split is derived from the notch's
		// OWN rendered top/height, not a second independently-guessed literal.
		expect(aboveFlat.height).toBe(notchFlat.top);
		expect(aboveFlat.borderTopLeftRadius).toBe(lightTheme.radii.lg);

		expect(belowFlat.position).toBe('absolute');
		expect(belowFlat.left).toBe(0);
		expect(belowFlat.width).toBe(4);
		expect(belowFlat.backgroundColor).toBe(lightTheme.colors.primary);
		expect(belowFlat.top).toBe((notchFlat.top as number) + notchHeight);
		expect(belowFlat.bottom).toBe(0);
		expect(belowFlat.borderBottomLeftRadius).toBe(lightTheme.radii.lg);
	});

	it.each(['past', 'future', 'unknown'] as const)('61-06 D-08: a non-current (%s) row renders neither accent-bar segment', status => {
		const row = buildRowFixture({stageId: 'votingStarts', status});
		const tr = renderRow({row});

		expect(tr.root.findAllByProps({testID: 'timeline-row-accent-votingStarts-above'}, {deep: false}).length).toBe(0);
		expect(tr.root.findAllByProps({testID: 'timeline-row-accent-votingStarts-below'}, {deep: false}).length).toBe(0);
	});

	it('61-06 D-08: action labels declare the body type step; only See details is demoted to regular', () => {
		const seeDetailsRow = buildRowFixture({stageId: 'registrationEnds', status: 'past'});
		const seeDetailsTr = renderRow({row: seeDetailsRow, onSeeDetails: jest.fn()});
		const seeDetailsButton = seeDetailsTr.root.findByProps({testID: 'timeline-row-see-details-registrationEnds'});
		const seeDetailsText = seeDetailsButton.findByType(Text);
		const seeDetailsFlat = flattenStyle(seeDetailsText);
		expect(seeDetailsFlat.fontSize).toBe(lightTheme.type.body.fontSize);
		expect(seeDetailsFlat.lineHeight).toBe(lightTheme.type.body.lineHeight);
		expect(seeDetailsFlat.fontWeight).toBe(lightTheme.fonts.regular.fontWeight);

		const keyholdersRow = buildRowFixture({stageId: 'releasingKeys', status: 'future'});
		const keyholdersTr = renderRow({row: keyholdersRow, onViewKeyholders: jest.fn()});
		const keyholdersButton = keyholdersTr.root.findByProps({testID: 'timeline-row-view-keyholders-releasingKeys'});
		const keyholdersText = keyholdersButton.findByType(Text);
		const keyholdersFlat = flattenStyle(keyholdersText);
		expect(keyholdersFlat.fontSize).toBe(lightTheme.type.body.fontSize);
		expect(keyholdersFlat.lineHeight).toBe(lightTheme.type.body.lineHeight);
		expect(keyholdersFlat.fontWeight).toBe(lightTheme.fonts.bold.fontWeight);
	});

	it('61-06 D-10/D-11: the countdown wrapper centres under a production-length countdown row', () => {
		const fixture = buildRowFixtureWithLongCountdown();

		// WR-02: pin the clock to the fixture's OWN nowMs before rendering. CountdownTimer derives
		// `remaining()` from the real `Date.now()` against the fixture's FIXED target
		// (2026-09-18T20:00Z), so without this the row rendered whatever the wall clock made it --
		// `1 : 13 : ..` on the day this was written, `00 : 00 : 00` from 2026-09-19 onward -- and
		// never the 4304-hour case this test is named for. The old assertions (marginTop,
		// alignItems) are clock-independent style props, so it passed either way.
		jest.useFakeTimers();
		jest.setSystemTime(fixture.nowMs);

		try {
			const row = fixture.rows.find(r => r.stageId === 'votingStarts')!;
			expect(row.status).toBe('current');

			const tr = renderRow({row, countdownTargetIso: fixture.countdownTargetIso});

			const countdown = tr.root.findByType(CountdownTimer);
			// WR-02: assert what the component RENDERED, not what the fixture was handed. The previous
			// `expect(Math.floor(fixture.remainingSeconds / 3600)).toBe(4304)` compared a constant with
			// itself and could never fail. 15_494_400s == 179d 08h 00m and is >2 digits, so this is also
			// the only row-level case that exercises D2's h2 shrink step.
			expect(countdown.props.targetIso).toBe(fixture.countdownTargetIso);
			expect(tr.root.findByProps({testID: 'countdown-days-value'}).props.children).toBe('179');
			expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('08');
			expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('00');

			// IN-04: located by IDENTITY, not by walking ancestors until `marginTop === 24`. That magic
			// number is itself a value 61-08's C1 changed (16 -> 24), so the old search would have
			// silently found nothing -- and `expect(wrapper).not.toBeNull()` was the only thing standing
			// between that and a false pass.
			const wrappers = tr.root.findAllByProps({testID: 'timeline-row-countdown-votingStarts'}, {deep: false});
			expect(wrappers).toHaveLength(1);
			const wrapperFlat = flattenStyle(wrappers[0]);
			// `alignItems`, not `justifyContent` -- the wrapper is a default `flexDirection: 'column'`
			// View, so `alignItems` is the horizontal (cross) axis. `justifyContent` on a column acts on
			// the vertical axis and would be an inert no-op.
			expect(wrapperFlat.alignItems).toBe('center');
			// D-09 addendum (61-08, C1, developer-approved): 16 (md) -> 24 (lg).
			expect(wrapperFlat.marginTop).toBe(24);

			const card = tr.root.findAllByType(View)[0];
			expect(flattenStyle(card).marginVertical).toBe(TIMELINE_CARD_MARGIN_V);
		} finally {
			jest.useRealTimers();
		}
	});
});
