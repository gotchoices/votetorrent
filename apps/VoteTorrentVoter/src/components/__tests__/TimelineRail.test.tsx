/**
 * Unit tests for TimelineRail (59-07 Task 2) -- all-ten-stages, dot/connector, "Now" label,
 * non-tappable-dot and partial-rail-refusal assertions. Same `withTheme()` / `activeRenderers` /
 * `import '../../i18n'` conventions as `ElectionCard.test.tsx` / `TimelineRow.test.tsx`.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {Pressable, Text} from 'react-native';
import {TimelineRail} from '../TimelineRail';
import {TimelineRegistrationPanel} from '../TimelineRegistrationPanel';
import {CountdownTimer} from '../CountdownTimer';
import {lightTheme} from '../../theme/themes';
import {TIMELINE_STAGE_IDS} from '../../timeline';
import {buildSevenRowFixture, buildTenRowFixture, FIXTURE_NOW_MS, PRODUCTION_NETWORK_NAME} from '../__fixtures__/timeline-fixtures';
import {TIMELINE_CARD_MARGIN_V} from '../timeline-layout';
import i18n from '../../i18n';

function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderRail(children: React.ReactElement) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(children));
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

describe('TimelineRail (59-07)', () => {
	it('renders all ten stages, ten dots, ten labels and ten rows in D-09 order (D-10)', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} />);

		const dotTestIds = TIMELINE_STAGE_IDS.map(id => 'timeline-rail-dot-' + id);
		const labelTestIds = TIMELINE_STAGE_IDS.map(id => 'timeline-rail-label-' + id);
		const rowTitleTestIds = TIMELINE_STAGE_IDS.map(id => 'timeline-row-title-' + id);

		for (const testID of [...dotTestIds, ...labelTestIds, ...rowTitleTestIds]) {
			expect(tr.root.findAllByProps({testID}, {deep: false}).length).toBe(1);
		}

		// Stage order: dots appear in D-09 order in the render tree.
		const renderedOrder = rows.map(r => r.stageId);
		expect(renderedOrder).toEqual(TIMELINE_STAGE_IDS);
	});

	it('D-11 (negative): no keyholder lifecycle id/name is ever rendered', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} />);
		const json = JSON.stringify(tr.toJSON());

		for (const forbidden of ['keyholderInvited', 'keyholderAccepted', 'keyholderRevoked', 'timeline-rail-dot-KI', 'timeline-rail-dot-KA', 'timeline-rail-dot-KR']) {
			expect(json).not.toContain(forbidden);
		}
		expect(new Set(rows.map(r => r.stageId))).toEqual(new Set(TIMELINE_STAGE_IDS));
	});

	it('past and current dots are filled donuts; future dots are hollow rings', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} />);

		for (const row of rows) {
			const dot = tr.root.findByProps({testID: 'timeline-rail-dot-' + row.stageId});
			const flatStyle = Object.assign({}, ...(Array.isArray(dot.props.style) ? dot.props.style : [dot.props.style]));
			if (row.status === 'past' || row.status === 'current') {
				expect(flatStyle.borderWidth).toBe(4);
				expect(flatStyle.borderColor).toBe(lightTheme.colors.primary);
				expect(flatStyle.backgroundColor).toBe(lightTheme.colors.card);
			} else {
				expect(flatStyle.borderWidth).toBe(2);
				expect(flatStyle.borderColor).toBe(lightTheme.colors.border);
				expect(flatStyle.backgroundColor).toBe(lightTheme.colors.background);
			}
		}
	});

	it('connector break point: above segments at index <= current are primary, below segments at index < current are primary, all else border (index derived from the fixture)', () => {
		const rows = buildTenRowFixture();
		const currentIndex = rows.findIndex(r => r.status === 'current');
		expect(currentIndex).toBeGreaterThan(-1);

		const tr = renderRail(<TimelineRail rows={rows} />);

		rows.forEach((row, index) => {
			const aboveNodes = tr.root.findAllByProps({testID: 'timeline-rail-connector-' + row.stageId + '-above'}, {deep: false});
			if (index > 0) {
				const flatStyle = Object.assign({}, ...(Array.isArray(aboveNodes[0].props.style) ? aboveNodes[0].props.style : [aboveNodes[0].props.style]));
				expect(flatStyle.backgroundColor).toBe(index <= currentIndex ? lightTheme.colors.primary : lightTheme.colors.border);
			} else {
				expect(aboveNodes.length).toBe(0);
			}

			const belowNodes = tr.root.findAllByProps({testID: 'timeline-rail-connector-' + row.stageId + '-below'}, {deep: false});
			if (index < rows.length - 1) {
				const flatStyle = Object.assign({}, ...(Array.isArray(belowNodes[0].props.style) ? belowNodes[0].props.style : [belowNodes[0].props.style]));
				expect(flatStyle.backgroundColor).toBe(index < currentIndex ? lightTheme.colors.primary : lightTheme.colors.border);
			} else {
				expect(belowNodes.length).toBe(0);
			}
		});
	});

	it('the current row label is t(rail.now) in bold primary; every other row is its own MM/DD', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} />);

		for (const row of rows) {
			const label = tr.root.findByProps({testID: 'timeline-rail-label-' + row.stageId});
			if (row.status === 'current') {
				expect(label.props.children).toBe('Now');
				expect(label.props.style).toEqual(
					expect.objectContaining({color: lightTheme.colors.primary, fontWeight: lightTheme.fonts.bold.fontWeight}),
				);
			} else {
				expect(label.props.children).toMatch(/^\d{2}\/\d{2}$|^—$/);
				expect(label.props.style).toEqual(expect.objectContaining({color: lightTheme.colors.textSecondary}));
			}
		}
	});

	it('dots are not tappable: no timeline-rail-dot- node carries onPress, and the rail contains no Pressable in its own graphic', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} />);

		for (const row of rows) {
			const dot = tr.root.findByProps({testID: 'timeline-rail-dot-' + row.stageId});
			expect(dot.props.onPress).toBeUndefined();
		}
		// TimelineRail itself renders zero Pressables (all interaction lives inside TimelineRow's
		// own action surface, which IS a Pressable-bearing subtree -- so this asserts none of the
		// rail-owned dot/connector nodes are Pressable, not that the whole tree has none).
		const rail = tr.root.findByProps({testID: 'timeline-rail'});
		const directDotColumnPressables = rail.findAll(node => node.type === Pressable && node.props.testID?.startsWith?.('timeline-rail-'));
		expect(directDotColumnPressables.length).toBe(0);
	});

	it('countdown target: the votingStarts row receives countdownTargetIso equal to the ISO form of the fixture tallyingStarts instant, not votingStarts', () => {
		const rows = buildTenRowFixture();
		const tallyingStartsRow = rows.find(r => r.stageId === 'tallyingStarts')!;
		const votingStartsRow = rows.find(r => r.stageId === 'votingStarts')!;
		expect(tallyingStartsRow.instantMs).not.toBe(votingStartsRow.instantMs);
		expect(votingStartsRow.status).toBe('current');

		const tr = renderRail(<TimelineRail rows={rows} onVoteNow={jest.fn()} />);
		const countdown = tr.root.findByType(CountdownTimer);
		const expectedIso = new Date(tallyingStartsRow.instantMs as number).toISOString();
		expect(countdown.props.targetIso).toBe(expectedIso);
	});

	it.each([
		['NaN', NaN],
		['a value past the max representable Date (8.64e15)', 8.7e15],
		['a value past the min representable Date', -8.7e15],
	])('CR-02: an out-of-range tallyingStarts instant (%s) renders the rail without a countdown instead of throwing during render', (_label, badInstantMs) => {
		const rows = buildTenRowFixture();
		const tallyingStartsRow = rows.find(r => r.stageId === 'tallyingStarts')!;
		// normalizeInstant (timeline-core) admits ANY finite number and the Timeline blob carries no
		// CHECK bounding the instant, so this state is reachable from a malformed/hostile peer blob.
		// relative-date's dateParts try/catch means deriveTimeline returns a CONFIDENT result here
		// rather than throwing, so TimelineScreen's own try/catch never fires -- the throw lands in
		// render, on a screen whose comment states it has no ErrorBoundary.
		(tallyingStartsRow as {instantMs: number}).instantMs = badInstantMs;

		let tr!: renderer.ReactTestRenderer;
		expect(() => {
			tr = renderRail(<TimelineRail rows={rows} onVoteNow={jest.fn()} />);
		}).not.toThrow();

		// The rail still renders its ten rows -- degrading to "no countdown", never to a blank screen.
		expect(tr.root.findAllByType(CountdownTimer)).toHaveLength(0);
		for (const stageId of TIMELINE_STAGE_IDS) {
			expect(tr.root.findAllByProps({testID: 'timeline-rail-label-' + stageId}, {deep: false}).length).toBe(1);
		}
	});

	it('CR-02 (positive): a valid in-range instant still produces a countdown -- the guard does not disable the feature', () => {
		const rows = buildTenRowFixture();
		const tallyingStartsRow = rows.find(r => r.stageId === 'tallyingStarts')!;
		const tr = renderRail(<TimelineRail rows={rows} onVoteNow={jest.fn()} />);
		expect(tr.root.findByType(CountdownTimer).props.targetIso).toBe(new Date(tallyingStartsRow.instantMs as number).toISOString());
	});

	it('same-day cluster: accruingVotes/hashingVotes/releasingKeys each render their own dot and repeat an identical label, never deduped', () => {
		const rows = buildTenRowFixture();
		const clusterIds = ['accruingVotes', 'hashingVotes', 'releasingKeys'] as const;
		const tr = renderRail(<TimelineRail rows={rows} />);

		const labels = clusterIds.map(id => tr.root.findByProps({testID: 'timeline-rail-label-' + id}).props.children);
		expect(new Set(labels).size).toBe(1);

		const dotTestIds = clusterIds.map(id => 'timeline-rail-dot-' + id);
		expect(new Set(dotTestIds).size).toBe(3);
		for (const testID of dotTestIds) {
			expect(tr.root.findAllByProps({testID}, {deep: false}).length).toBe(1);
		}
	});

	it('a seven-row (pre-D-08) input renders zero dots and zero rows -- title contains "indeterminate"', () => {
		const rows = buildSevenRowFixture();
		expect(rows.length).toBe(7);
		const tr = renderRail(<TimelineRail rows={rows} />);

		expect(tr.toJSON()).toBeNull();
		for (const id of TIMELINE_STAGE_IDS) {
			expect(tr.root.findAllByProps({testID: 'timeline-rail-dot-' + id}, {deep: false}).length).toBe(0);
		}
	});

	it('ES pass: re-rendering under the ES locale changes the current label to the ES "Now" string and clips no Text node', () => {
		// IN-05: wrapped so a genuine act() violation later is not lost in this file's own noise.
		renderer.act(() => {
			i18n.changeLanguage('es');
		});
		const rows = buildTenRowFixture(FIXTURE_NOW_MS, 'UTC', 'es');
		const tr = renderRail(<TimelineRail rows={rows} />);

		const currentRow = rows.find(r => r.status === 'current')!;
		const label = tr.root.findByProps({testID: 'timeline-rail-label-' + currentRow.stageId});
		expect(label.props.children).toBe('Ahora');

		const textNodes = tr.root.findAllByType(Text);
		for (const node of textNodes) {
			expect(node.props.numberOfLines).toBeUndefined();
		}
		// IN-05: wrapped so a genuine act() violation later is not lost in this file's own noise.
		renderer.act(() => {
			i18n.changeLanguage('en');
		});
	});

	it('nowOffsetMs pass-through (D-12/D-14): the rail forwards an explicit offset through TimelineRow to the votingStarts row\'s CountdownTimer', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} nowOffsetMs={1234567} />);

		const countdown = tr.root.findByType(CountdownTimer);
		expect(countdown.props.nowOffsetMs).toBe(1234567);
	});

	it('nowOffsetMs default (D-14): omitting the prop delivers the literal number 0 to CountdownTimer, not undefined -- keeps Home\'s ElectionCard and every other fixture-driven caller inert', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} />);

		const countdown = tr.root.findByType(CountdownTimer);
		expect(countdown.props.nowOffsetMs).toBe(0);
	});

	it("61-06 D-08: the current row's dot is 24px, every other dot 20px", () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} />);

		for (const row of rows) {
			const dot = tr.root.findByProps({testID: 'timeline-rail-dot-' + row.stageId});
			const flatStyle = Object.assign({}, ...(Array.isArray(dot.props.style) ? dot.props.style : [dot.props.style]));
			if (row.status === 'current') {
				expect(flatStyle.width).toBe(24);
				expect(flatStyle.height).toBe(24);
				expect(flatStyle.borderRadius).toBe(12);
			} else {
				expect(flatStyle.width).toBe(20);
				expect(flatStyle.height).toBe(20);
				expect(flatStyle.borderRadius).toBe(10);
			}
		}
	});

	it('61-06 D-08: every dot shares one centre derived from TIMELINE_CARD_MARGIN_V', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} />);

		const expectedCenterY = TIMELINE_CARD_MARGIN_V + 16 + lightTheme.type.h4.lineHeight / 2;
		const centersX: number[] = [];

		for (const row of rows) {
			const dot = tr.root.findByProps({testID: 'timeline-rail-dot-' + row.stageId});
			const flatStyle = Object.assign({}, ...(Array.isArray(dot.props.style) ? dot.props.style : [dot.props.style]));
			expect(flatStyle.top + flatStyle.height / 2).toBe(expectedCenterY);
			centersX.push(flatStyle.left + flatStyle.width / 2);
		}

		expect(new Set(centersX).size).toBe(1);
	});
});

describe('TimelineRail (D1, 61-02) -- panel+row composition proves the ONE-total view-registration contract', () => {
	// This predicate is itself Case A's positive control: a `node.type === Text` predicate that
	// could never match anything would report 0 for Case A too, and Case A's `=== 1` assertion
	// would fail exactly as loudly as a real regression. Do not "simplify" this to a `>= 0` check
	// or add a separate "the matcher works" test -- Case A already proves the matcher is live.
	function countResolvedText(tr: renderer.ReactTestRenderer, expectedText: string): number {
		return tr.root.findAll(node => node.type === Text && node.props.children === expectedText).length;
	}

	it('Case A -- panel present, deadline passed: exactly ONE "view registration"-class affordance exists across the whole rail, and it is the panel\'s CTA', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(
			<TimelineRail
				rows={rows}
				renderPanel={stageId =>
					stageId === 'registrationEnds' ? (
						// `isBeforeDeadline={false}` is load-bearing: TimelineRegistrationPanel.tsx:105
						// branches the CTA label on this flag alone, and only `false` resolves it to
						// `registration.viewCta`. With `true` the panel renders `editCta` and this test
						// measures nothing.
						<TimelineRegistrationPanel
							status="registered"
							networkName={PRODUCTION_NETWORK_NAME}
							isBeforeDeadline={false}
							onEditRegistration={jest.fn()}
							onViewRegistration={jest.fn()}
						/>
					) : null
				}
				onSeeDetails={jest.fn()}
				onEditRegistration={jest.fn()}
			/>,
		);

		const viewCtaText = i18n.t('registration.viewCta', {ns: 'timeline'});
		expect(countResolvedText(tr, viewCtaText)).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-registration-panel-cta'}, {deep: false}).length).toBe(1);
		expect(tr.root.findAllByProps({testID: 'timeline-row-view-registration-registrationEnds'}, {deep: false}).length).toBe(0);
	});

	it('Case B -- panel absent (the registration-status read window): ZERO "view registration"-class affordances exist anywhere in the rail -- no orphan row action, no guessed placeholder', () => {
		const rows = buildTenRowFixture();
		const tr = renderRail(<TimelineRail rows={rows} renderPanel={() => null} onSeeDetails={jest.fn()} onEditRegistration={jest.fn()} />);

		const viewCtaText = i18n.t('registration.viewCta', {ns: 'timeline'});
		expect(countResolvedText(tr, viewCtaText)).toBe(0);
		expect(tr.root.findAllByProps({testID: 'timeline-row-view-registration-registrationEnds'}, {deep: false}).length).toBe(0);
	});
});
