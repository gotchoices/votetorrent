/**
 * BallotScreen.test.tsx (VOTE-01, TDD RED->GREEN) — mounts a real `NavigationContainer` + real
 * `VoterAppProvider` + real `BallotSelectionProvider` around a minimal native-stack harness (the
 * real `BallotScreen` plus trivial stand-in routes for `IndividualQuestion`/`OfficeInfo`/
 * `ElectionInfo`/`ReviewSubmit`) so `getBallot()`'s fixture offices resolve and navigation calls
 * land on registered routes — mirrors `registration-flow.test.tsx`'s real-provider harness and
 * `RegistrationScreen.test.tsx`'s `tr.root.findByProps({testID})` interaction style (no
 * `@testing-library/react-native`).
 *
 * Covers 42-RESEARCH.md's Validation Architecture "BallotScreen renders office rows + Save & Exit;
 * N/M matches selectionMap" row for VOTE-01.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
// Phase 44-07 (D-02/D-04): VoterAppProvider is now a real composition root requiring a
// CadreNodeProvider ancestor — this ballot-flow test has no need to exercise that boot, so it
// uses the manual Jest mock at providers/__mocks__/VoterAppProvider.tsx.
jest.mock('../../../providers/VoterAppProvider');
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {BallotSelectionProvider} from '../../../providers/BallotSelectionProvider';
import {FIXTURE_BALLOT} from '../../../providers/__fixtures__/voter-fixtures';
import BallotScreen from '../BallotScreen';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** Flush VoterAppProvider's isInitialized boot effect + BallotScreen's getBallot().then(setBallot). */
async function flushBoot() {
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

// Trivial stand-ins for routes BallotScreen can navigate to but this test never visits — kept as
// no-op components purely so `navigation.navigate(...)` resolves to a registered route (mirrors
// registration-flow.test.tsx's DummyScreen approach).
function DummyScreen() {
	return null;
}

const Stack = createNativeStackNavigator();

function renderBallotScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<NavigationContainer theme={lightTheme}>
				<VoterAppProvider>
					<BallotSelectionProvider>
						<Stack.Navigator initialRouteName="Ballot" screenOptions={{headerShown: false}}>
							<Stack.Screen name="Ballot" component={BallotScreen} />
							<Stack.Screen name="IndividualQuestion" component={DummyScreen} />
							<Stack.Screen name="ReviewSubmit" component={DummyScreen} />
						</Stack.Navigator>
					</BallotSelectionProvider>
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	return tr;
}

const {__setMockGetBallot} = jest.requireMock('../../../providers/VoterAppProvider') as {
	__setMockGetBallot: (reader?: () => Promise<unknown>) => void;
};

describe('BallotScreen (VOTE-01)', () => {
	afterEach(() => __setMockGetBallot());

	it('renders one section header per published group, in first-appearance order', async () => {
		const tr = renderBallotScreen();
		await flushBoot();

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('"Federal"');
		expect(text).toContain('"State (UT)"');
		expect(text.indexOf('"Federal"')).toBeLessThan(text.indexOf('"State (UT)"'));
	});

	it('renders office titles as the published literal text', async () => {
		const tr = renderBallotScreen();
		await flushBoot();

		const text = JSON.stringify(tr.toJSON());
		for (const office of FIXTURE_BALLOT.offices) {
			expect(text).toContain(office.title);
		}
	});

	it('shows the unavailable message (and no ballot controls) when the ballot read rejects', async () => {
		__setMockGetBallot(() => Promise.reject(new Error('No election is available on the current network')));
		const tr = renderBallotScreen();
		await flushBoot();

		expect(tr.root.findAllByProps({testID: 'ballot-unavailable'}).length).toBeGreaterThan(0);
		expect(tr.root.findAllByProps({testID: 'ballot-continue-voting'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'ballot-review-submit'})).toHaveLength(0);
	});

	it('shows the unavailable message when the ballot has no questions this app can show', async () => {
		__setMockGetBallot(async () => ({electionId: 'e', offices: [], unsupportedQuestionCount: 0}));
		const tr = renderBallotScreen();
		await flushBoot();

		expect(tr.root.findAllByProps({testID: 'ballot-unavailable'}).length).toBeGreaterThan(0);
	});

	it('says how many questions it cannot show instead of silently dropping them', async () => {
		__setMockGetBallot(async () => ({...FIXTURE_BALLOT, unsupportedQuestionCount: 2}));
		const tr = renderBallotScreen();
		await flushBoot();

		expect(JSON.stringify(tr.toJSON())).toContain("2 questions on this ballot can't be answered in this app yet.");
	});

	it('shows the derived 0/{total} progress label before any selection', async () => {
		const tr = renderBallotScreen();
		await flushBoot();

		const total = FIXTURE_BALLOT.offices.length;
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain(`0/${total} questions completed`);
	});

	it('renders the Save & Exit and Review & Submit footer controls', async () => {
		const tr = renderBallotScreen();
		await flushBoot();

		expect(tr.root.findByProps({testID: 'ballot-save-exit'})).toBeTruthy();
		expect(tr.root.findByProps({testID: 'ballot-review-submit'})).toBeTruthy();
	});

	it('contains no Phase-39 dev-trigger Pressables', async () => {
		const tr = renderBallotScreen();
		await flushBoot();

		const text = JSON.stringify(tr.toJSON());
		expect(text).not.toContain('Open Individual Question (dev)');
		expect(text).not.toContain('Open Office Info (dev)');
		expect(text).not.toContain('Open Candidate Info (dev)');
	});
});
