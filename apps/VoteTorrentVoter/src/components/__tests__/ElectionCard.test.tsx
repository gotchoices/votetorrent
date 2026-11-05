/**
 * Unit tests for ElectionCard (HOME-01/02/03) — the 7-state presentational card driven by a
 * `STATE_DISPLAY` lookup map (40-RESEARCH.md Pattern 1). Constructs fixture `VoterElection` objects
 * directly (no `VoterAppProvider`/navigator) since `ElectionCard` never calls `useVoterApp()` or
 * `useNavigation()` — RESEARCH Anti-Patterns / this plan's presentational-component constraint.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import * as fs from 'fs';
import * as path from 'path';
import {ElectionCard} from '../ElectionCard';
import type {ElectionCardProps} from '../ElectionCard';
import {CountdownTimer} from '../CountdownTimer';
import {ProgressBar} from '../ProgressBar';
import {lightTheme} from '../../theme/themes';
import {LIFECYCLE_ORDER} from '../../providers/types';
import type {LifecycleState, VoterElection} from '../../providers/types';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const FUTURE_ISO = new Date(Date.now() + 3600_000).toISOString();

/**
 * Fixture VoterElection per state — plausible field values exercising each state's prescribed
 * STATE_DISPLAY branch, constructed directly (no provider/getElection() involved).
 */
function electionFor(state: LifecycleState): VoterElection {
	const base: VoterElection = {id: 'mock-election-1', title: 'General Election 2025', lifecycleState: state};
	switch (state) {
		case 'Upcoming':
			return {...base, countdownTarget: FUTURE_ISO};
		case 'Open':
			return {...base, countdownTarget: FUTURE_ISO, progress: 0.3};
		case 'ReviewSelections':
			return base;
		case 'ReleasingKeys':
			return {...base, countdownTarget: FUTURE_ISO, keysReleased: 3, keysTotal: 5};
		case 'Validation':
			return {...base, countdownTarget: FUTURE_ISO, keysReleased: 5, keysTotal: 5, checksComplete: 2, checksTotal: 3};
		case 'ValidationDetails':
			return {...base, checksComplete: 2, checksTotal: 3};
		case 'Complete':
			return {...base, certified: true};
		default:
			return base;
	}
}

type Callbacks = Partial<{
	onVoteNow: () => void;
	onViewValidationDetails: () => void;
	onLearnAboutElection: () => void;
}>;

// Renderers created per test are tracked and unmounted in afterEach — states with a countdown
// (Upcoming/ReleasingKeys/Validation) mount a real setInterval (CountdownTimer uses real timers
// here, not jest.useFakeTimers()); leaving it mounted past the test would keep firing after the
// test file's module registry is torn down.
const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderCard(election: VoterElection, callbacks: Callbacks = {}, extraProps: Partial<ElectionCardProps> = {}) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<ElectionCard election={election} {...callbacks} {...extraProps} />));
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
});

describe('ElectionCard (HOME-01/02/03)', () => {
	it.each(LIFECYCLE_ORDER)('renders the prescribed pieces for the %s state', state => {
		const election = electionFor(state);
		const tr = renderCard(election);

		// Every state renders its summary line.
		const summary = tr.root.findByProps({testID: 'election-card-summary'});
		expect(summary.props.children).toBeTruthy();

		// Every state except Open renders its prescribed state icon (Open carries no icon per
		// the icon table — its countdown/progress/CTA already carry the state).
		const icons = tr.root.findAllByType(FontAwesome6);
		if (state === 'Open') {
			expect(icons.length).toBe(0);
		} else {
			expect(icons.length).toBe(1);
		}

		// {deep: false} stops descending once a branch matches — Pressable is a memo(forwardRef(...))
		// composite, so an un-scoped deep search would also match its internal forwardRef/host-View
		// layers and over-count a single logical element several times over.
		const countdowns = tr.root.findAllByType(CountdownTimer, {deep: false});
		const progresses = tr.root.findAllByType(ProgressBar, {deep: false});
		const voteNow = tr.root.findAllByProps({testID: 'election-card-vote-now'}, {deep: false});
		const viewValidationDetails = tr.root.findAllByProps({testID: 'election-card-view-validation-details'}, {deep: false});
		const learnLink = tr.root.findAllByProps({testID: 'election-card-learn-link'}, {deep: false});

		if (state === 'Open') {
			expect(countdowns.length).toBe(1);
			expect(progresses.length).toBe(1);
			expect(learnLink.length).toBe(1);
			expect(voteNow.length).toBe(1);
			expect(viewValidationDetails.length).toBe(0);
		} else if (state === 'ValidationDetails') {
			expect(countdowns.length).toBe(0);
			expect(progresses.length).toBe(0);
			expect(learnLink.length).toBe(0);
			expect(voteNow.length).toBe(0);
			expect(viewValidationDetails.length).toBe(1);
		} else {
			// The 5 non-navigating states render no action element at all (D-07).
			expect(voteNow.length).toBe(0);
			expect(viewValidationDetails.length).toBe(0);
			expect(learnLink.length).toBe(0);
			expect(progresses.length).toBe(0);
			const expectsCountdown = (['Upcoming', 'ReleasingKeys', 'Validation'] as LifecycleState[]).includes(state);
			expect(countdowns.length).toBe(expectsCountdown ? 1 : 0);
		}
	});

	it('Home inherits the shared >=24h countdown contract — a 31h30m target renders 1 DAYS : 07 HOURS and no seconds group (D-16/D-17)', () => {
		// Inline fixture (not electionFor/FUTURE_ISO — both feed the existing 7-state test and
		// must stay on the <24h branch). Mirrors devLifecycleFixtures.ts's nowPlus(31 * HOUR_MS) plus 30
		// minutes of slack so the remainder lands cleanly inside the HOURS group.
		const election: VoterElection = {
			id: 'mock-election-1',
			title: 'General Election 2025',
			lifecycleState: 'Upcoming',
			countdownTarget: new Date(Date.now() + 31 * 3600_000 + 30 * 60_000).toISOString(),
		};
		const tr = renderCard(election);

		expect(tr.root.findByProps({testID: 'countdown-days-value'}).props.children).toBe('1');
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('07');
		expect(tr.root.findAllByProps({testID: 'countdown-seconds-value'}).length).toBe(0);

		// Content-level cross-check. Verified safe: states.upcoming.summary's copy ("Voting
		// hasn't opened yet — check back when the polls open.") contains neither word.
		const text = tr.root.findAll(node => typeof node.props.children === 'string')
			.map(node => node.props.children)
			.join(' ');
		expect(text).toContain('days');
		expect(text).not.toContain('seconds');

		// Deliberately no minutes-group assertion here: this file runs REAL timers by design
		// (see the activeRenderers/afterEach comment above), and minutes is the only group that
		// can drift within a single test tick — asserting it would introduce a flake.
	});

	it('pressing the Open "Vote now" element invokes onVoteNow exactly once', () => {
		const onVoteNow = jest.fn();
		const tr = renderCard(electionFor('Open'), {onVoteNow});
		const button = tr.root.findByProps({testID: 'election-card-vote-now'});
		renderer.act(() => {
			button.props.onPress();
		});
		expect(onVoteNow).toHaveBeenCalledTimes(1);
	});

	it('pressing the ValidationDetails "View Validation Details" element invokes onViewValidationDetails exactly once', () => {
		const onViewValidationDetails = jest.fn();
		const tr = renderCard(electionFor('ValidationDetails'), {onViewValidationDetails});
		const button = tr.root.findByProps({testID: 'election-card-view-validation-details'});
		renderer.act(() => {
			button.props.onPress();
		});
		expect(onViewValidationDetails).toHaveBeenCalledTimes(1);
	});

	it('pressing the Open "Learn about this election" link invokes onLearnAboutElection exactly once', () => {
		const onLearnAboutElection = jest.fn();
		const tr = renderCard(electionFor('Open'), {onLearnAboutElection});
		const link = tr.root.findByProps({testID: 'election-card-learn-link'});
		renderer.act(() => {
			link.props.onPress();
		});
		expect(onLearnAboutElection).toHaveBeenCalledTimes(1);
	});

	it('Validation and ValidationDetails render DIFFERENTLY (Pitfall 3 guard: no action on Validation, outline CTA on ValidationDetails)', () => {
		const validationTr = renderCard(electionFor('Validation'));
		const validationDetailsTr = renderCard(electionFor('ValidationDetails'));

		expect(validationTr.root.findAllByProps({testID: 'election-card-view-validation-details'}, {deep: false}).length).toBe(0);
		expect(validationDetailsTr.root.findAllByProps({testID: 'election-card-view-validation-details'}, {deep: false}).length).toBe(1);
	});

	it('ReleasingKeys and Validation render distinct icon glyph AND color (SC2)', () => {
		const releasingKeysTr = renderCard(electionFor('ReleasingKeys'));
		const validationTr = renderCard(electionFor('Validation'));

		const releasingKeysIcon = releasingKeysTr.root.findByType(FontAwesome6);
		const validationIcon = validationTr.root.findByType(FontAwesome6);

		expect(releasingKeysIcon.props.name).toBe('lock');
		expect(validationIcon.props.name).toBe('lock-open');
		expect(releasingKeysIcon.props.name).not.toBe(validationIcon.props.name);
		expect(releasingKeysIcon.props.color).not.toBe(validationIcon.props.color);
	});

	// A REAL election read carries no keysReleased / validation checks / certification / progress
	// (no engine source yet) — the card must say only what is known, never interpolate `undefined`
	// or imply a measured zero.
	describe('real-read fallbacks (fields with no engine source are absent)', () => {
		const summaryOf = (tr: renderer.ReactTestRenderer) =>
			tr.root.findByProps({testID: 'election-card-summary'}).props.children as string;
		const real = (state: LifecycleState): VoterElection => ({id: 'e-1', title: 'Real Election', lifecycleState: state});

		it.each([
			['ReleasingKeys', 'Voting has closed. Results stay locked until the election keys are released.'],
			['Validation', 'Election keys released — results are being tallied and validated.'],
			['Complete', 'This election is closed.'],
		] as const)('%s renders its fallback summary, with no "undefined" and no invented count', (state, expected) => {
			const summary = summaryOf(renderCard(real(state)));
			expect(summary).toBe(expected);
			expect(summary).not.toMatch(/undefined|\d+\/\d+|Certified/);
		});

		it('ReleasingKeys with only keysTotal (a real read) still falls back — never "0/5"', () => {
			const summary = summaryOf(renderCard({...real('ReleasingKeys'), keysTotal: 5}));
			expect(summary).not.toMatch(/\//);
		});

		it('Open with no progress value renders no progress bar and no "0% complete"', () => {
			const text = JSON.stringify(renderCard(real('Open')).toJSON());
			expect(text).not.toContain('% complete');
			// The vote CTA is still there — only the unsourced progress is omitted.
			expect(text).toContain('Vote now');
		});

		it('the counted copy still renders when the review fixture supplies the fields', () => {
			expect(summaryOf(renderCard(electionFor('ReleasingKeys')))).toBe('3/5 election keys released.');
			expect(summaryOf(renderCard(electionFor('Complete')))).toBe('Certified ✓');
		});
	});

	describe('saved vote on the card (D-12, D-21)', () => {
		const STALE = 'The election changed after you voted. Please vote again.';
		const find = (tr: renderer.ReactTestRenderer, testID: string) => tr.root.findAllByProps({testID}, {deep: false});
		const textOf = (node: renderer.ReactTestInstance): string => {
			const out: string[] = [];
			const walk = (n: renderer.ReactTestInstance | string) => {
				if (typeof n === 'string') out.push(n);
				else n.children.forEach(walk);
			};
			walk(node);
			return out.join('');
		};

		it('EC1: Open with no savedVote or none renders vote-now and no saved-vote node', () => {
			for (const extra of [{}, {savedVote: {state: 'none' as const}}]) {
				const tr = renderCard(electionFor('Open'), {}, extra);
				expect(find(tr, 'election-card-vote-now').length).toBe(1);
				expect(find(tr, 'election-card-saved-vote').length).toBe(0);
				expect(JSON.stringify(tr.toJSON())).not.toContain('election-card-saved-vote');
			}
		});

		it('EC2b: Open + sent shows the sent line and the view link, hides vote-now and the saved line', () => {
			const tr = renderCard(electionFor('Open'), {}, {savedVote: {state: 'sent'}, onViewSavedVote: jest.fn()});
			expect(textOf(find(tr, 'election-card-saved-vote-sent')[0])).toBe('Your vote has been sent to the election.');
			expect(find(tr, 'election-card-saved-vote-status').length).toBe(0);
			expect(find(tr, 'election-card-vote-now').length).toBe(0);
			expect(find(tr, 'election-card-saved-vote-view').length).toBe(1);
		});

		it('EC2: Open + saved shows the status and the view link, hides vote-now', () => {
			const onViewSavedVote = jest.fn();
			const tr = renderCard(electionFor('Open'), {}, {savedVote: {state: 'saved', revisionKnown: true}, onViewSavedVote});
			expect(textOf(find(tr, 'election-card-saved-vote-status')[0])).toBe('Vote saved — not sent');
			const view = find(tr, 'election-card-saved-vote-view');
			expect(view.length).toBe(1);
			expect(textOf(view[0])).toBe('View saved vote');
			expect(find(tr, 'election-card-vote-now').length).toBe(0);
			renderer.act(() => view[0].props.onPress());
			expect(onViewSavedVote).toHaveBeenCalledTimes(1);
		});

		it('EC3: revision unknown adds the honest note', () => {
			const tr = renderCard(electionFor('Open'), {}, {savedVote: {state: 'saved', revisionKnown: false}});
			expect(textOf(find(tr, 'election-card-saved-vote-revision-unknown')[0])).toBe(
				"We couldn't check whether the election has changed since you voted.",
			);
		});

		it('EC4: stale shows the exact D-21 line, vote-now and the link, with no status line', () => {
			const tr = renderCard(electionFor('Open'), {}, {savedVote: {state: 'stale', revisionKnown: true}, onViewSavedVote: jest.fn()});
			expect(textOf(find(tr, 'election-card-saved-vote-stale')[0])).toBe(STALE);
			expect(find(tr, 'election-card-vote-now').length).toBe(1);
			expect(find(tr, 'election-card-saved-vote-view').length).toBe(1);
			expect(find(tr, 'election-card-saved-vote-status').length).toBe(0);
		});

		it('EC5: unreadable shows the unreadable line and the link, hides vote-now', () => {
			const tr = renderCard(electionFor('Open'), {}, {savedVote: {state: 'unreadable'}, onViewSavedVote: jest.fn()});
			expect(textOf(find(tr, 'election-card-saved-vote-unreadable')[0])).toBe("Your saved vote can't be read on this phone.");
			expect(find(tr, 'election-card-saved-vote-view').length).toBe(1);
			expect(find(tr, 'election-card-vote-now').length).toBe(0);
		});

		it('EC6: non-Open states still show the saved status; ValidationDetails keeps its action', () => {
			const rk = renderCard(electionFor('ReleasingKeys'), {}, {savedVote: {state: 'saved', revisionKnown: true}, onViewSavedVote: jest.fn()});
			expect(find(rk, 'election-card-saved-vote-status').length).toBe(1);
			expect(find(rk, 'election-card-saved-vote-view').length).toBe(1);
			const vd = renderCard(electionFor('ValidationDetails'), {}, {savedVote: {state: 'saved', revisionKnown: true}});
			expect(find(vd, 'election-card-saved-vote-status').length).toBe(1);
			expect(find(vd, 'election-card-view-validation-details').length).toBe(1);
		});

		it('EC7: no view link without onViewSavedVote', () => {
			const tr = renderCard(electionFor('Open'), {}, {savedVote: {state: 'saved', revisionKnown: true}});
			expect(find(tr, 'election-card-saved-vote-view').length).toBe(0);
		});

		it('EC8: the old voted pill is gone and the card stays presentational', () => {
			for (const savedVote of [undefined, {state: 'saved' as const, revisionKnown: true}]) {
				const tr = renderCard(electionFor('Open'), {}, {savedVote});
				expect(JSON.stringify(tr.toJSON())).not.toContain('election-card-voted');
			}
			const src = fs
				.readFileSync(path.join(__dirname, '..', 'ElectionCard.tsx'), 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/^\s*\/\/.*$/gm, '');
			for (const needle of ['has' + 'Voted', 'voted' + 'Cta', 'useVoterApp', 'useNavigation']) expect(src).not.toContain(needle);
		});
	});

	/**
	 * D-11 is a DELIBERATE DIVERGENCE requirement: `TimelineRow`'s countdown wrapper centres, and
	 * Home's stays left-aligned, and "the two must not be reconciled" (`ElectionCard.tsx`'s own
	 * marker comment). Only the centring half was ever asserted
	 * (`TimelineRow.test.tsx`'s `61-06 D-10/D-11` test). Nothing guarded this half: a later edit
	 * adding `alignItems: 'center'` here to "make the two match" would erase the divergence the
	 * requirement exists to encode, and the whole voter suite would stay green.
	 *
	 * The wrapper carries no testID, so it is located by IDENTITY — the parent of the
	 * `CountdownTimer` this card renders — never by scanning ancestors for a magic style value.
	 * (That search shape is what IN-04 caught in the sibling suite: when the magic number moved,
	 * the search silently found nothing and the assertion passed on an empty result.) The
	 * marginTop check below is a FOUND-THE-RIGHT-NODE confirmation, not the search key.
	 */
	describe('D-11 deliberate divergence — Home\'s countdown stays LEFT-aligned', () => {
		it.each(['Upcoming', 'ReleasingKeys', 'Validation'] as const)(
			'%s: the View hosting the countdown declares no centring alignItems, unlike TimelineRow\'s wrapper',
			state => {
				const tr = renderCard(electionFor(state));

				const wrapper = tr.root.findByType(CountdownTimer).parent;
				expect(wrapper).not.toBeNull();

				const flat: Record<string, unknown> = Object.assign(
					{},
					...(Array.isArray(wrapper!.props.style) ? wrapper!.props.style : [wrapper!.props.style]),
				);

				// Confirms this really is the styled countdown wrapper and not some incidental
				// ancestor -- without it, a refactor that dropped the wrapper would leave the
				// alignment assertion asserting nothing.
				expect(flat.marginTop).toBe(16);
				expect(flat.alignItems).toBeUndefined();
			},
		);
	});
});

describe('ElectionCard — shared dev clock offset (D-02)', () => {
	function renderOpen(nowOffsetMs?: number) {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<ElectionCard election={electionFor('Open')} nowOffsetMs={nowOffsetMs} />));
		});
		activeRenderers.push(tr);
		return tr;
	}

	it('forwards nowOffsetMs to the CountdownTimer', () => {
		const tr = renderOpen(86_400_000);
		expect(tr.root.findByType(CountdownTimer).props.nowOffsetMs).toBe(86_400_000);
	});

	it('defaults the CountdownTimer offset to 0 without the prop', () => {
		const tr = renderOpen();
		expect(tr.root.findByType(CountdownTimer).props.nowOffsetMs).toBe(0);
	});
});
