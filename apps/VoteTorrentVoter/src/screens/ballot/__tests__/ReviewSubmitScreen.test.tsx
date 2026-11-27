/**
 * ReviewSubmitScreen.test.tsx (VOTE-04, D-10) - proves the REAL local Submit over a mocked
 * `vote-casting` module. castVote itself is proven by the engine suites; this suite proves what
 * the screen does with eligibility and with castVote's closed results: per-reason copy, the blank
 * list, the prompt copy, the pending guard, clear-then-navigate on success and one typed message
 * per failure stage and reason.
 *
 * The inline mock confirmation is gone (D-10): a saved vote lands on the VoteReceipt route.
 * Harness: real NavigationContainer, real BallotSelectionProvider, the manual VoterAppProvider
 * mock (its getEngine rejects and its seededElectionId is undefined), the real BallotScreen.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import {Platform} from 'react-native';
import renderer from 'react-test-renderer';
import type {ReactTestInstance} from 'react-test-renderer';
import {NavigationContainer, createNavigationContainerRef, useRoute} from '@react-navigation/native';
import type {ParamListBase} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
jest.mock('../../../providers/VoterAppProvider');
jest.mock('../../../engines/vote-casting', () => ({
	...jest.requireActual('../../../engines/vote-casting'),
	evaluateVoteEligibility: jest.fn(),
	castVote: jest.fn(),
}));
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {BallotSelectionProvider, useBallotSelection} from '../../../providers/BallotSelectionProvider';
import type {BallotSelectionContextType} from '../../../providers/BallotSelectionProvider';
import {FIXTURE_BALLOT} from '../../../providers/__fixtures__/voter-fixtures';
import {
	VOTE_INELIGIBLE_REASONS,
	evaluateVoteEligibility,
	castVote,
} from '../../../engines/vote-casting';
import type {
	VoteEligibility,
	VoteIneligibleReason,
	VoteQuestionRef,
	CastVoteResult,
} from '../../../engines/vote-casting';
import BallotScreen from '../BallotScreen';
import ReviewSubmitScreen from '../ReviewSubmitScreen';
import {lightTheme} from '../../../theme/themes';
import i18n, {resources} from '../../../i18n';

const evaluateMock = jest.mocked(evaluateVoteEligibility);
const castMock = jest.mocked(castVote);
const en = resources.en.ballot as unknown as Record<string, string>;
const es = resources.es.ballot as unknown as Record<string, string>;

const R1 =
	'This phone is not registered to vote in this election, or its voting key has changed. Register this phone again.';

const receipt: {params: unknown; selectionMap: unknown; renders: number} = {
	params: undefined,
	selectionMap: undefined,
	renders: 0,
};

function eligible(overrides: Record<string, unknown> = {}): VoteEligibility {
	return {
		eligible: true,
		context: {},
		selections: {},
		blankQuestions: [],
		voter: {},
		producer: {},
		replacesStale: false,
		...overrides,
	} as unknown as VoteEligibility;
}

function ineligible(reason: VoteIneligibleReason, questions: VoteQuestionRef[] = []): VoteEligibility {
	return {eligible: false, reason, questions, ballotIds: [], lifecycleState: null};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {promise, resolve, reject};
}

const saved: CastVoteResult = {
	ok: true,
	electionId: 'e-1',
	electionRevision: 3,
	ballotIds: ['b-1'],
	savedAt: '2026-10-05T00:00:00.000Z',
	replacedStale: false,
};

async function settle() {
	await renderer.act(async () => {
		for (let i = 0; i < 6; i++) {
			await Promise.resolve();
		}
	});
}

function DummyScreen() {
	return null;
}

function VoteReceiptProbe() {
	const route = useRoute();
	const {selectionMap} = useBallotSelection();
	if (receipt.renders === 0) {
		receipt.params = route.params;
		receipt.selectionMap = selectionMap;
	}
	receipt.renders += 1;
	return null;
}

const Stack = createNativeStackNavigator();

function renderScreen() {
	const captured: {value: BallotSelectionContextType | null} = {value: null};
	const navRef = createNavigationContainerRef<ParamListBase>();

	function SelectionProbe() {
		captured.value = useBallotSelection();
		return null;
	}

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<NavigationContainer ref={navRef} theme={lightTheme}>
				<VoterAppProvider>
					<BallotSelectionProvider>
						<SelectionProbe />
						<Stack.Navigator initialRouteName="Ballot" screenOptions={{headerShown: false}}>
							<Stack.Screen name="Ballot" component={BallotScreen} />
							<Stack.Screen name="IndividualQuestion" component={DummyScreen} />
							<Stack.Screen name="ReviewSubmit" component={ReviewSubmitScreen} />
							<Stack.Screen name="VoteReceipt" component={VoteReceiptProbe} />
						</Stack.Navigator>
					</BallotSelectionProvider>
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	mountedTrees.push(tr);
	return {tr, captured, navRef};
}

async function openReview(tr: renderer.ReactTestRenderer) {
	const button = tr.root.findByProps({testID: 'ballot-review-submit'});
	renderer.act(() => {
		button.props.onPress();
	});
	await settle();
}

async function boot(): Promise<ReturnType<typeof renderScreen>> {
	const view = renderScreen();
	await settle();
	return view;
}

function find(tr: renderer.ReactTestRenderer, testID: string): ReactTestInstance {
	return tr.root.findByProps({testID});
}

function has(tr: renderer.ReactTestRenderer, testID: string): boolean {
	return tr.root.findAllByProps({testID}).length > 0;
}

function textOf(node: ReactTestInstance | string): string {
	if (typeof node === 'string') {
		return node;
	}
	return node.children.map(child => textOf(child as ReactTestInstance | string)).join('');
}

function press(tr: renderer.ReactTestRenderer, testID: string) {
	const node = find(tr, testID);
	renderer.act(() => {
		node.props.onPress();
	});
}

const OFFICES = FIXTURE_BALLOT.offices;
const consoleSpies: jest.SpyInstance[] = [];
const mountedTrees: renderer.ReactTestRenderer[] = [];

beforeEach(() => {
	evaluateMock.mockReset();
	castMock.mockReset();
	evaluateMock.mockResolvedValue(eligible());
	receipt.params = undefined;
	receipt.selectionMap = undefined;
	receipt.renders = 0;
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		consoleSpies.push(jest.spyOn(console, method).mockImplementation(() => undefined));
	}
});

afterEach(async () => {
	const calls = consoleSpies.map(spy => spy.mock.calls.length);
	for (const tree of mountedTrees.splice(0)) {
		try {
			renderer.act(() => tree.unmount());
		} catch {
			// already unmounted by the test
		}
	}

	consoleSpies.splice(0).forEach(spy => spy.mockRestore());
	await i18n.changeLanguage('en');
	expect(calls).toEqual([0, 0, 0, 0, 0]);
});

describe('ReviewSubmitScreen (VOTE-04)', () => {
	it('RS1: summarizes each office (placeholder, then the selected candidate name)', async () => {
		const {tr, captured} = await boot();
		await openReview(tr);
		expect(JSON.stringify(tr.toJSON())).toContain('Not yet answered');

		const office = OFFICES[0];
		renderer.act(() => {
			captured.value!.toggleCandidate(office.id, office.candidates[0].id, office.voteFor);
		});
		await settle();
		expect(JSON.stringify(tr.toJSON())).toContain('Diana Foster');
	});

	it('RS2: Continue Voting goes back to the Ballot page', async () => {
		const {tr, navRef} = await boot();
		await openReview(tr);
		expect(navRef.getCurrentRoute()?.name).toBe('ReviewSubmit');
		press(tr, 'review-continue');
		expect(navRef.getCurrentRoute()?.name).toBe('Ballot');
	});

	it('RS3: while eligibility is being checked Submit is disabled and does nothing', async () => {
		evaluateMock.mockReturnValue(new Promise(() => undefined));
		const {tr} = await boot();
		await openReview(tr);
		expect(textOf(find(tr, 'review-eligibility-checking'))).toBe(en['submit.checking']);
		expect(find(tr, 'review-submit').props.disabled).toBe(true);
		press(tr, 'review-submit');
		await settle();
		expect(castMock).not.toHaveBeenCalled();
	});

	it('RS4: evaluates with the live deps and no producer', async () => {
		const {tr, captured} = await boot();
		await openReview(tr);
		expect(evaluateMock).toHaveBeenCalled();
		const arg = evaluateMock.mock.calls[evaluateMock.mock.calls.length - 1];
		expect(arg).toHaveLength(1);
		const deps = arg[0];
		expect(typeof deps.getEngine).toBe('function');
		expect(deps.fallbackElectionId).toBeUndefined();
		expect(typeof deps.nowMs).toBe('number');
		expect(deps.selectionMap).toEqual(captured.value!.selectionMap);
		expect(Object.keys(deps)).not.toContain('producer');
	});

	describe('RS5: every eligibility reason', () => {
		const EXPECTED_EN: Record<VoteIneligibleReason, string> = {
			'election-unavailable': en['submit.reason.electionUnavailable'],
			'window-closed': en['submit.reason.windowClosed'],
			'ballot-unconfirmed': en['submit.reason.ballotUnconfirmed'],
			'no-ballots': en['submit.reason.noBallots'],
			'unsupported-question': en['submit.reason.unsupportedQuestion'],
			'dependent-question': en['submit.reason.dependentQuestion'],
			'selection-invalid': en['submit.reason.selectionInvalid'],
			'required-unanswered': en['submit.reason.requiredUnanswered'],
			'below-minimum': en['submit.reason.belowMinimum'],
			'device-check-failed': en['submit.reason.deviceCheckFailed'],
			'not-registered': en['submit.reason.notRegistered'],
			'registration-ambiguous': en['submit.reason.registrationAmbiguous'],
			'device-key-rotated': en['submit.reason.notRegistered'],
			'unreadable-key': en['submit.reason.unreadableKey'],
			'already-saved': en['submit.reason.alreadySaved'],
		};

		it('the expectation table covers exactly the 15 reasons', () => {
			expect(Object.keys(EXPECTED_EN).sort()).toEqual([...VOTE_INELIGIBLE_REASONS].sort());
		});

		it.each([...VOTE_INELIGIBLE_REASONS])('%s renders its copy with Submit disabled', async reason => {
			evaluateMock.mockResolvedValue(ineligible(reason));
			const {tr} = await boot();
			await openReview(tr);
			expect(textOf(find(tr, 'review-ineligible'))).toBe(EXPECTED_EN[reason]);
			expect(find(tr, 'review-submit').props.disabled).toBe(true);
			press(tr, 'review-submit');
			await settle();
			expect(castMock).not.toHaveBeenCalled();
		});
	});

	it('RS6 (R-1): not-registered and device-key-rotated render the identical R-1 line', async () => {
		const texts: string[] = [];
		for (const reason of ['not-registered', 'device-key-rotated'] as const) {
			evaluateMock.mockResolvedValue(ineligible(reason));
			const {tr} = await boot();
			await openReview(tr);
			texts.push(textOf(find(tr, 'review-ineligible')));
			renderer.act(() => tr.unmount());
		}
		expect(texts).toEqual([R1, R1]);
	});

	it('RS7: question refs render by office title, falling back to the question code', async () => {
		evaluateMock.mockResolvedValue(
			ineligible('required-unanswered', [
				{officeId: OFFICES[0].id, ballotId: OFFICES[0].ballotId, questionCode: OFFICES[0].questionCode},
				{officeId: OFFICES[2].id, ballotId: OFFICES[2].ballotId, questionCode: OFFICES[2].questionCode},
				{officeId: 'not-displayed', ballotId: 'b-x', questionCode: 'hidden-question'},
			]),
		);
		const {tr} = await boot();
		await openReview(tr);
		expect(textOf(find(tr, `review-reason-question-${OFFICES[0].id}`))).toBe(OFFICES[0].title);
		expect(textOf(find(tr, `review-reason-question-${OFFICES[2].id}`))).toBe(OFFICES[2].title);
		expect(textOf(find(tr, 'review-reason-question-not-displayed'))).toBe('hidden-question');
	});

	it('RS8 (D-04): lists blank questions in order and tags the required ones', async () => {
		const {tr, captured} = await boot();
		renderer.act(() => {
			captured.value!.toggleCandidate(OFFICES[0].id, OFFICES[0].candidates[0].id, OFFICES[0].voteFor);
		});
		await openReview(tr);
		const list = find(tr, 'review-blank-list');
		expect(textOf(list)).toContain(en['submit.blankHeading']);
		const blanks = OFFICES.slice(1);
		for (const office of blanks) {
			expect(textOf(find(tr, `review-blank-${office.id}`))).toBe(office.title);
			expect(has(tr, `review-blank-required-${office.id}`)).toBe(office.required);
			if (office.required) {
				expect(textOf(find(tr, `review-blank-required-${office.id}`))).toBe(en['submit.blankRequiredTag']);
			}
		}
		expect(has(tr, `review-blank-${OFFICES[0].id}`)).toBe(false);
		const order = list
			.findAll(
				n =>
					typeof n.type === 'string' &&
					typeof n.props.testID === 'string' &&
					n.props.testID.startsWith('review-blank-') &&
					n.props.testID !== 'review-blank-list' &&
					!n.props.testID.startsWith('review-blank-required-'),
			)
			.map(n => n.props.testID);
		expect(order).toEqual(blanks.map(o => `review-blank-${o.id}`));

		renderer.act(() => {
			for (const office of blanks) {
				captured.value!.toggleCandidate(office.id, office.candidates[0].id, office.voteFor);
			}
		});
		await settle();
		expect(has(tr, 'review-blank-list')).toBe(false);
	});

	it('RS9 (R-3): an eligible all-blank vote is stated and Submit stays enabled', async () => {
		const {tr} = await boot();
		await openReview(tr);
		expect(textOf(find(tr, 'review-all-blank'))).toBe(en['submit.allBlank']);
		for (const office of OFFICES) {
			expect(has(tr, `review-blank-${office.id}`)).toBe(true);
		}
		expect(find(tr, 'review-submit').props.disabled).toBe(false);
	});

	it('RS9b: an ineligible all-blank vote does not claim it will be saved, but still lists blanks', async () => {
		evaluateMock.mockResolvedValue(ineligible('required-unanswered'));
		const {tr} = await boot();
		await openReview(tr);
		expect(has(tr, 'review-all-blank')).toBe(false);
		expect(has(tr, 'review-blank-list')).toBe(true);
	});

	it('RS10 (D-09): Submit calls castVote once with the prompts, no producer, a pending guard, then clears and navigates', async () => {
		const pending = deferred<CastVoteResult>();
		castMock.mockReturnValue(pending.promise);
		const {tr, captured, navRef} = await boot();
		renderer.act(() => {
			captured.value!.toggleCandidate(OFFICES[0].id, OFFICES[0].candidates[0].id, OFFICES[0].voteFor);
			captured.value!.setCurrentQuestionIndex(2);
		});
		await openReview(tr);

		press(tr, 'review-submit');
		const submitNode = find(tr, 'review-submit');
		await settle();
		expect(castMock).toHaveBeenCalledTimes(1);
		const arg = castMock.mock.calls[0][0];
		expect(arg.signPrompt).toEqual({
			title: 'Confirm your vote',
			subtitle: 'Sign your vote with your device key',
			negativeButton: 'Cancel',
		});
		expect(arg.recordPrompt).toEqual({
			title: en['submit.recordPrompt.title'],
			subtitle: en['submit.recordPrompt.subtitle'],
			negativeButton: en['submit.recordPrompt.negativeButton'],
		});
		expect(typeof arg.nowMs).toBe('number');
		expect(Object.keys(arg)).not.toContain('producer');

		expect(find(tr, 'review-submit').props.disabled).toBe(true);
		expect(find(tr, 'review-continue').props.disabled).toBe(true);
		expect(textOf(find(tr, 'review-submit'))).toBe(en['submit.saving']);
		submitNode.props.onPress();
		renderer.act(() => {
			find(tr, 'review-submit').props.onPress();
		});
		await settle();
		expect(castMock).toHaveBeenCalledTimes(1);

		await renderer.act(async () => {
			pending.resolve(saved);
			await pending.promise;
		});
		await settle();
		expect(navRef.getCurrentRoute()?.name).toBe('VoteReceipt');
		expect(navRef.getCurrentRoute()?.params).toEqual({electionId: 'e-1', revealOnOpen: true});
		expect(receipt.params).toEqual({electionId: 'e-1', revealOnOpen: true});
		expect(receipt.selectionMap).toEqual({});
		expect(captured.value!.selectionMap).toEqual({});
		expect(captured.value!.currentQuestionIndex).toBe(0);
	});

	it('RS11 (es): the prompts and the R-1 reason render in Spanish', async () => {
		await renderer.act(async () => {
			await i18n.changeLanguage('es');
		});
		const pending = deferred<CastVoteResult>();
		castMock.mockReturnValue(pending.promise);
		const {tr} = await boot();
		await openReview(tr);
		press(tr, 'review-submit');
		await settle();
		const arg = castMock.mock.calls[0][0];
		expect(arg.signPrompt).toEqual({
			title: es['submit.signPrompt.title'],
			subtitle: es['submit.signPrompt.subtitle'],
			negativeButton: es['submit.signPrompt.negativeButton'],
		});
		expect(arg.recordPrompt).toEqual({
			title: es['submit.recordPrompt.title'],
			subtitle: es['submit.recordPrompt.subtitle'],
			negativeButton: es['submit.recordPrompt.negativeButton'],
		});
		renderer.act(() => tr.unmount());

		castMock.mockReset();
		evaluateMock.mockResolvedValue(ineligible('not-registered'));
		const second = await boot();
		await openReview(second.tr);
		expect(textOf(find(second.tr, 'review-ineligible'))).toBe(es['submit.reason.notRegistered']);
	});

	describe('RS12: typed failures keep the selections', () => {
		const rows: Array<[string, CastVoteResult, string]> = [
			['build/build-failed', {ok: false, stage: 'build', reason: 'build-failed'}, 'submit.failure.buildFailed'],
			['sign/canceled', {ok: false, stage: 'sign', reason: 'canceled'}, 'submit.failure.canceled'],
			['sign/biometric-unavailable', {ok: false, stage: 'sign', reason: 'biometric-unavailable'}, 'submit.failure.biometricUnavailable'],
			['sign/sign-failed', {ok: false, stage: 'sign', reason: 'sign-failed'}, 'submit.failure.signFailed'],
			['sign/signature-invalid', {ok: false, stage: 'sign', reason: 'signature-invalid'}, 'submit.failure.signatureInvalid'],
			['seal/canceled', {ok: false, stage: 'seal', reason: 'canceled'}, 'submit.failure.canceled'],
			['seal/biometric-unavailable', {ok: false, stage: 'seal', reason: 'biometric-unavailable'}, 'submit.failure.biometricUnavailable'],
			['seal/key-invalidated', {ok: false, stage: 'seal', reason: 'key-invalidated'}, 'submit.failure.keyInvalidated'],
			['seal/no-wrap-key', {ok: false, stage: 'seal', reason: 'no-wrap-key'}, 'submit.failure.sealFailed'],
			['seal/policy-mismatch', {ok: false, stage: 'seal', reason: 'policy-mismatch'}, 'submit.failure.sealFailed'],
			['seal/tag-mismatch', {ok: false, stage: 'seal', reason: 'tag-mismatch'}, 'submit.failure.sealFailed'],
			['seal/malformed', {ok: false, stage: 'seal', reason: 'malformed'}, 'submit.failure.sealFailed'],
			['seal/native-error', {ok: false, stage: 'seal', reason: 'native-error'}, 'submit.failure.sealFailed'],
			['store/already-saved', {ok: false, stage: 'store', reason: 'already-saved'}, 'submit.reason.alreadySaved'],
			['store/unreadable', {ok: false, stage: 'store', reason: 'unreadable'}, 'submit.failure.storeUnreadable'],
			['store/invalid-input', {ok: false, stage: 'store', reason: 'invalid-input'}, 'submit.failure.storeFailed'],
			['store/storage-failed', {ok: false, stage: 'store', reason: 'storage-failed'}, 'submit.failure.storeFailed'],
		];

		it('has 17 rows', () => {
			expect(rows.length).toBe(17);
		});

		it.each(rows)('%s', async (_name, result, key) => {
			castMock.mockResolvedValue(result);
			const {tr, captured, navRef} = await boot();
			renderer.act(() => {
				captured.value!.toggleCandidate(OFFICES[0].id, OFFICES[0].candidates[0].id, OFFICES[0].voteFor);
			});
			await openReview(tr);
			const before = captured.value!.selectionMap;
			press(tr, 'review-submit');
			await settle();
			expect(textOf(find(tr, 'review-submit-failure'))).toBe(en[key]);
			expect(navRef.getCurrentRoute()?.name).toBe('ReviewSubmit');
			expect(captured.value!.selectionMap).toEqual(before);
			expect(Object.keys(captured.value!.selectionMap)).toContain(OFFICES[0].id);
			expect(find(tr, 'review-submit').props.disabled).toBe(false);
			expect(receipt.renders).toBe(0);
		});
	});

	describe('RS12b: Face ID copy on ios, fingerprint copy on android (D-101)', () => {
		const originalOS = Platform.OS;
		afterEach(() => {
			Object.defineProperty(Platform, 'OS', {value: originalOS, configurable: true});
		});
		const platforms: Array<['ios' | 'android', string]> = [
			['ios', ''],
			['android', '.android'],
		];

		it.each(platforms)('%s: record prompt subtitle', async (os, suffix) => {
			Object.defineProperty(Platform, 'OS', {value: os, configurable: true});
			castMock.mockReturnValue(new Promise(() => {}));
			const {tr} = await boot();
			await openReview(tr);
			press(tr, 'review-submit');
			await settle();
			const arg = castMock.mock.calls[0][0];
			expect(arg.recordPrompt.subtitle).toBe(en[`submit.recordPrompt.subtitle${suffix}`]);
			expect(arg.recordPrompt.subtitle).toMatch(os === 'ios' ? /Face ID/ : /fingerprint/);
		});

		const failures: Array<[string, CastVoteResult, string]> = [
			['sign/canceled', {ok: false, stage: 'sign', reason: 'canceled'}, 'submit.failure.canceled'],
			['sign/biometric-unavailable', {ok: false, stage: 'sign', reason: 'biometric-unavailable'}, 'submit.failure.biometricUnavailable'],
			['seal/canceled', {ok: false, stage: 'seal', reason: 'canceled'}, 'submit.failure.canceled'],
			['seal/biometric-unavailable', {ok: false, stage: 'seal', reason: 'biometric-unavailable'}, 'submit.failure.biometricUnavailable'],
			['seal/key-invalidated', {ok: false, stage: 'seal', reason: 'key-invalidated'}, 'submit.failure.keyInvalidated'],
		];
		for (const [os, suffix] of platforms) {
			it.each(failures)(`${os}: %s`, async (_name, result, key) => {
				Object.defineProperty(Platform, 'OS', {value: os, configurable: true});
				castMock.mockResolvedValue(result);
				const {tr} = await boot();
				await openReview(tr);
				press(tr, 'review-submit');
				await settle();
				const shown = textOf(find(tr, 'review-submit-failure'));
				expect(shown).toBe(en[`${key}${suffix}`]);
				expect(shown).toMatch(os === 'ios' ? /Face ID/ : /fingerprint/);
				expect(shown).not.toMatch(os === 'ios' ? /fingerprint/ : /Face ID/);
			});
		}
	});

	it('RS13: a castVote ineligible stage replaces the eligibility instead of showing a failure', async () => {
		castMock.mockResolvedValue({
			ok: false,
			stage: 'ineligible',
			eligibility: ineligible('already-saved') as Extract<VoteEligibility, {eligible: false}>,
		});
		const {tr, navRef} = await boot();
		await openReview(tr);
		press(tr, 'review-submit');
		await settle();
		expect(textOf(find(tr, 'review-ineligible'))).toBe(en['submit.reason.alreadySaved']);
		expect(has(tr, 'review-submit-failure')).toBe(false);
		expect(find(tr, 'review-submit').props.disabled).toBe(true);
		expect(navRef.getCurrentRoute()?.name).toBe('ReviewSubmit');
	});

	it('RS14: a castVote rejection shows the generic message and never its text', async () => {
		castMock.mockRejectedValue(new TypeError('x NEEDLE'));
		const {tr, navRef} = await boot();
		await openReview(tr);
		press(tr, 'review-submit');
		await settle();
		expect(textOf(find(tr, 'review-submit-failure'))).toBe(en['submit.failure.unexpected']);
		expect(JSON.stringify(tr.toJSON())).not.toContain('NEEDLE');
		expect(navRef.getCurrentRoute()?.name).toBe('ReviewSubmit');
		expect(find(tr, 'review-submit').props.disabled).toBe(false);
	});

	it('RS15 (D-21): a stale record shows the stale line and Submit stays enabled', async () => {
		evaluateMock.mockResolvedValue(eligible({replacesStale: true}));
		castMock.mockReturnValue(new Promise(() => undefined));
		const {tr} = await boot();
		await openReview(tr);
		expect(textOf(find(tr, 'review-stale'))).toBe(en['submit.staleReplace']);
		expect(find(tr, 'review-submit').props.disabled).toBe(false);
		press(tr, 'review-submit');
		await settle();
		expect(castMock).toHaveBeenCalledTimes(1);
	});

	it('RS16: eligibility is re-evaluated each time Review gains focus', async () => {
		const {tr} = await boot();
		await openReview(tr);
		const first = evaluateMock.mock.calls.length;
		expect(first).toBeGreaterThanOrEqual(1);
		press(tr, 'review-continue');
		await settle();
		await openReview(tr);
		expect(evaluateMock.mock.calls.length).toBe(first + 1);
	});

	it('RS17: the local-only note shows in the eligible and ineligible states', async () => {
		const {tr} = await boot();
		await openReview(tr);
		expect(textOf(find(tr, 'review-local-note'))).toBe(en['submit.localNote']);
		renderer.act(() => tr.unmount());

		evaluateMock.mockResolvedValue(ineligible('window-closed'));
		const second = await boot();
		await openReview(second.tr);
		expect(textOf(find(second.tr, 'review-local-note'))).toBe(en['submit.localNote']);
	});

	it('RS19 (WR-01): selections the loaded ballot no longer shows are pruned and never reach eligibility', async () => {
		const sboe = OFFICES.find(o => o.voteFor === 2)!;
		const {tr, captured} = await boot();
		renderer.act(() => {
			captured.value!.toggleCandidate(OFFICES[0].id, OFFICES[0].candidates[0].id, OFFICES[0].voteFor);
			// An office a later revision dropped, and a candidate it re-coded away.
			captured.value!.toggleCandidate('office-dropped-by-revision', 'cand-gone', 1);
			captured.value!.toggleCandidate(sboe.id, 'cand-sboe-recoded-away', sboe.voteFor);
			captured.value!.toggleCandidate(sboe.id, sboe.candidates[0].id, sboe.voteFor);
		});
		await openReview(tr);
		expect(captured.value!.selectionMap).toEqual({
			[OFFICES[0].id]: [OFFICES[0].candidates[0].id],
			[sboe.id]: [sboe.candidates[0].id],
		});
		const calls = evaluateMock.mock.calls;
		expect(calls[calls.length - 1][0].selectionMap).toEqual(captured.value!.selectionMap);
		expect(find(tr, 'review-submit').props.disabled).toBe(false);

		castMock.mockResolvedValue(saved);
		press(tr, 'review-submit');
		await settle();
		expect(castMock).toHaveBeenCalledTimes(1);
		expect(Object.keys(castMock.mock.calls[0][0].selectionMap).sort()).toEqual([OFFICES[0].id, sboe.id].sort());
	});

	it('RS20 (WR-01): an unusable selection for a question still on the ballot keeps Submit disabled and names it', async () => {
		const office = OFFICES[0];
		const ref = {officeId: office.id, ballotId: office.ballotId, questionCode: office.questionCode};
		evaluateMock.mockResolvedValue(ineligible('selection-invalid', [ref]));
		const {tr, captured} = await boot();
		renderer.act(() => {
			// Two live candidates on a voteFor 1 office (a revision lowered the cap): not stale, so kept.
			captured.value!.toggleCandidate(office.id, office.candidates[0].id, 2);
			captured.value!.toggleCandidate(office.id, office.candidates[1].id, 2);
		});
		await openReview(tr);
		expect(captured.value!.selectionMap[office.id]).toEqual([office.candidates[0].id, office.candidates[1].id]);
		expect(textOf(find(tr, 'review-ineligible'))).toBe(en['submit.reason.selectionInvalid']);
		expect(textOf(find(tr, `review-reason-question-${office.id}`))).toBe(office.title);
		expect(find(tr, 'review-submit').props.disabled).toBe(true);
		press(tr, 'review-submit');
		await settle();
		expect(castMock).not.toHaveBeenCalled();
	});

	it('RS21 (WR-01): a failed ballot read never prunes', async () => {
		const mockModule = jest.requireMock('../../../providers/VoterAppProvider') as {
			__setMockGetBallot: (reader?: () => Promise<unknown>) => void;
		};
		mockModule.__setMockGetBallot(() => Promise.reject(new Error('no election')));
		try {
			const {tr, captured, navRef} = await boot();
			renderer.act(() => {
				captured.value!.toggleCandidate('office-dropped-by-revision', 'cand-gone', 1);
			});
			// The Ballot screen offers no Review button without a ballot; go to Review directly.
			renderer.act(() => {
				navRef.navigate('ReviewSubmit');
			});
			await settle();
			expect(has(tr, 'review-ballot-unavailable')).toBe(true);
			expect(captured.value!.selectionMap).toEqual({'office-dropped-by-revision': ['cand-gone']});
		} finally {
			mockModule.__setMockGetBallot();
		}
	});

	it('RS18: source assertions on the comment-stripped screen', () => {
		const raw = fs.readFileSync(path.join(__dirname, '../ReviewSubmitScreen.tsx'), 'utf8');
		const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		for (const needle of [
			'useVoterApp(',
			'useBallotSelection(',
			'evaluateVoteEligibility(',
			'castVote(',
			'clearSelections()',
			'pruneSelections(ballot.offices)',
			'useFocusEffect(',
			'revealOnOpen: true',
			"t('submit.signPrompt.title')",
			"t('submit.reason.notRegistered')",
		]) {
			expect(src).toContain(needle);
		}
		expect(src.indexOf('clearSelections()')).toBeLessThan(src.indexOf("navigation.navigate('VoteReceipt'"));
		const forbidden = [
			'submitted' + 'Confirmation',
			'set' + 'Submitted',
			'review-' + 'confirmation',
			'prod' + 'ucer',
			'Async' + 'Storage',
			'console' + '.',
			'signDevice' + 'KeyDigest',
			'seal' + 'VoteRecord',
			'write' + 'VoteRecord',
			'Stub' + 'AttestationProducer',
			'resolveAttestation' + 'Producer',
			'.mess' + 'age',
		];
		for (const token of forbidden) {
			expect(src).not.toContain(token);
		}
	});
});
