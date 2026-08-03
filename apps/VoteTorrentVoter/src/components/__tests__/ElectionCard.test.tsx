/**
 * Unit tests for ElectionCard (HOME-01/02/03) — the 7-state presentational card driven by a
 * `STATE_DISPLAY` lookup map (40-RESEARCH.md Pattern 1). Constructs fixture `MockElection` objects
 * directly (no `VoterAppProvider`/navigator) since `ElectionCard` never calls `useVoterApp()` or
 * `useNavigation()` — RESEARCH Anti-Patterns / this plan's presentational-component constraint.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ElectionCard} from '../ElectionCard';
import {CountdownTimer} from '../CountdownTimer';
import {ProgressBar} from '../ProgressBar';
import {lightTheme} from '../../theme/themes';
import {LIFECYCLE_ORDER} from '../../providers/types';
import type {LifecycleState, MockElection} from '../../providers/types';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const FUTURE_ISO = new Date(Date.now() + 3600_000).toISOString();

/**
 * Fixture MockElection per state — plausible field values exercising each state's prescribed
 * STATE_DISPLAY branch, constructed directly (no provider/getElection() involved).
 */
function electionFor(state: LifecycleState): MockElection {
	const base: MockElection = {id: 'mock-election-1', title: 'General Election 2025', lifecycleState: state};
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

function renderCard(election: MockElection, callbacks: Callbacks = {}, hasVoted?: boolean) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<ElectionCard election={election} hasVoted={hasVoted} {...callbacks} />));
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

	describe('hasVoted (VOTE-04 / D-08 Home CTA reflection)', () => {
		it('hasVoted omitted on the Open state renders the vote-now Pressable unchanged (no voted pill)', () => {
			const tr = renderCard(electionFor('Open'));

			expect(tr.root.findAllByProps({testID: 'election-card-vote-now'}, {deep: false}).length).toBe(1);
			expect(tr.root.findAllByProps({testID: 'election-card-voted'}, {deep: false}).length).toBe(0);
		});

		it('hasVoted=false on the Open state renders the vote-now Pressable unchanged (no voted pill)', () => {
			const tr = renderCard(electionFor('Open'), {} as Callbacks, false);

			expect(tr.root.findAllByProps({testID: 'election-card-vote-now'}, {deep: false}).length).toBe(1);
			expect(tr.root.findAllByProps({testID: 'election-card-voted'}, {deep: false}).length).toBe(0);
		});

		it('hasVoted=true on the Open state renders the disabled voted pill instead of vote-now', () => {
			const tr = renderCard(electionFor('Open'), {}, true);

			const votedPill = tr.root.findAllByProps({testID: 'election-card-voted'}, {deep: false});
			expect(votedPill.length).toBe(1);
			expect(votedPill[0].props.onPress).toBeUndefined();
			expect(tr.root.findAllByProps({testID: 'election-card-vote-now'}, {deep: false}).length).toBe(0);
		});

		it('hasVoted=true on a non-Open state is unaffected (no voted pill, no vote-now)', () => {
			const tr = renderCard(electionFor('ValidationDetails'), {}, true);

			expect(tr.root.findAllByProps({testID: 'election-card-voted'}, {deep: false}).length).toBe(0);
			expect(tr.root.findAllByProps({testID: 'election-card-vote-now'}, {deep: false}).length).toBe(0);
			// The ValidationDetails action is untouched by hasVoted.
			expect(tr.root.findAllByProps({testID: 'election-card-view-validation-details'}, {deep: false}).length).toBe(1);
		});
	});
});
