/**
 * provider-scope.test.tsx — the D-22 gate (Phase 59-05).
 *
 * Invariant: exactly ONE `BallotSelectionProvider` instance and exactly ONE
 * `RegistrationDraftProvider` instance exist in the mounted voter app, both above the bottom
 * `Tab.Navigator` — so a ballot selection or registration draft made from one tab's entry point
 * is the SAME state seen from any other tab's entry point (the property 59-10's duplicate
 * Timeline routes depend on).
 *
 * Preflight correction, carried forward here: an earlier decision draft (D-22) claimed both
 * providers were `AsyncStorage`-backed and would "resync" across instances — false. Both are
 * pure in-memory `useState`/`useCallback` with ZERO persistence (see each provider's own header
 * comment). This is why the lift matters MORE, not less: with no persistence layer, two mounted
 * instances have no mechanism whatsoever to reconverge — a divergence would be permanent.
 *
 * 59-10's duplicate `Ballot` / `ReviewSubmit` / `RegistrationHome` routes on a new Timeline stack
 * are what this protects: reusing those screen components under the OLD per-stack provider
 * mounting would mint a second, unsynced provider instance for the duplicate routes.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {NavigationContainer} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';

// Mirrors __tests__/App.test.tsx's mock set — this file also mounts the FULL RootNavigator tree.
jest.mock('../src/providers/VoterAppProvider');
jest.mock('../src/providers/CadreNodeProvider', () => ({
	useCadreNode: () => ({node: null, syncState: 'offline', connectedPeers: () => 0}),
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
}));

import {VoterAppProvider} from '../src/providers/VoterAppProvider';
import {AppStateProviders, RootNavigator} from '../src/navigation';
import {BallotSelectionProvider, useBallotSelection} from '../src/providers/BallotSelectionProvider';
import {RegistrationDraftProvider, useRegistrationDraft} from '../src/providers/RegistrationDraftProvider';
import HomeScreen from '../src/screens/home/HomeScreen';
import RegistrationScreen from '../src/screens/registration/RegistrationScreen';
import {lightTheme} from '../src/theme/themes';
import '../src/i18n'; // initializes the global i18next instance useTranslation() reads from

/**
 * Verdict helper shared by Group A (the real production tree) and Group C (the planted
 * negative control): reports, for a given provider type, how many instances exist in the
 * rendered tree and whether the single instance (when there is exactly one) has `needle` in its
 * own subtree. Returns a verdict rather than asserting inline so Group C can drive it to a
 * FAILING verdict without duplicating the counting logic.
 */
function providerScopeVerdict(
	root: ReactTestRenderer.ReactTestInstance,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	Provider: React.ComponentType<any>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	needle: React.ComponentType<any>,
): {count: number; containsNeedle: boolean; passing: boolean} {
	const instances = root.findAllByType(Provider);
	const count = instances.length;
	const containsNeedle =
		count === 1 ? instances[0]!.findAllByType(needle).length > 0 : false;
	return {count, containsNeedle, passing: count === 1 && containsNeedle};
}

// Group A mounts the FULL RootNavigator tree, which (via HomeScreen -> ElectionCard) renders a
// live `CountdownTimer` for the default 'Upcoming' lifecycle state — a real setInterval +
// AppState listener. Track and unmount every such renderer so its effects are torn down before
// the test file's own environment is (mirrors the fact that `__tests__/App.test.tsx` mounts the
// same tree; unmounting here keeps this file's own teardown clean rather than relying on that
// pre-existing, unrelated characteristic).
let activeRenderer: ReactTestRenderer.ReactTestRenderer | null = null;

afterEach(async () => {
	if (activeRenderer) {
		await ReactTestRenderer.act(async () => {
			activeRenderer!.unmount();
		});
		activeRenderer = null;
	}
});

async function mountRootNavigator(initialState?: {index: number; routes: {name: string}[]}) {
	let tr!: ReactTestRenderer.ReactTestRenderer;
	await ReactTestRenderer.act(async () => {
		tr = ReactTestRenderer.create(
			<SafeAreaProvider>
				<VoterAppProvider>
					<NavigationContainer theme={lightTheme} initialState={initialState}>
						<RootNavigator />
					</NavigationContainer>
				</VoterAppProvider>
			</SafeAreaProvider>,
		);
	});
	// Flush HomeScreen's on-mount getElection() promise (mirrors App.test.tsx's own act wrap).
	await ReactTestRenderer.act(async () => {
		await Promise.resolve();
	});
	activeRenderer = tr;
	return tr;
}

describe('D-22 provider scope — one shared instance spanning every tab entry point', () => {
	describe('Group A — default (Vote-focused) mount', () => {
		it('has exactly one BallotSelectionProvider and one RegistrationDraftProvider, and the RegistrationDraftProvider subtree contains HomeScreen', async () => {
			const tr = await mountRootNavigator();

			const ballotVerdict = providerScopeVerdict(tr.root, BallotSelectionProvider, HomeScreen);
			const draftVerdict = providerScopeVerdict(tr.root, RegistrationDraftProvider, HomeScreen);

			expect(ballotVerdict.count).toBe(1);
			expect(draftVerdict.count).toBe(1);
			// The discriminating assertion: pre-lift, RegistrationDraftProvider lived inside the
			// lazily-mounted Registration stack, so it would not be in the tree AT ALL on a
			// Vote-focused mount, and this would read false.
			expect(draftVerdict.containsNeedle).toBe(true);
		});
	});

	describe('Group A — Registration-focused mount', () => {
		it('has exactly one BallotSelectionProvider and one RegistrationDraftProvider, and the BallotSelectionProvider subtree contains RegistrationScreen', async () => {
			const tr = await mountRootNavigator({index: 0, routes: [{name: 'Registration'}]});

			const ballotVerdict = providerScopeVerdict(tr.root, BallotSelectionProvider, RegistrationScreen);
			const draftVerdict = providerScopeVerdict(tr.root, RegistrationDraftProvider, RegistrationScreen);

			expect(ballotVerdict.count).toBe(1);
			expect(draftVerdict.count).toBe(1);
			// The discriminating assertion: pre-lift, BallotSelectionProvider was a sibling of the
			// Registration stack (mounted inside VoteStackNavigator only), never an ancestor of
			// RegistrationScreen — this would read false.
			expect(ballotVerdict.containsNeedle).toBe(true);
		});
	});

	describe('Group B — cross-entry-point state sharing (the literal D-22 sentence)', () => {
		// Two sibling probes standing in for two different tab entry points (Vote tab / Timeline
		// tab) — modelled this way because the Timeline stack itself does not exist until 59-10.
		// A selection or draft edit made via one probe must be visible from the other, because
		// both sit under the SAME AppStateProviders instance (the real production composition
		// from navigation/index.tsx).
		function VoteTabBallotProbe({onReady}: {onReady: (ctx: ReturnType<typeof useBallotSelection>) => void}) {
			const ctx = useBallotSelection();
			onReady(ctx);
			return null;
		}
		function TimelineTabBallotProbe({captured}: {captured: {value: ReturnType<typeof useBallotSelection> | null}}) {
			captured.value = useBallotSelection();
			return null;
		}
		function VoteTabDraftProbe({onReady}: {onReady: (ctx: ReturnType<typeof useRegistrationDraft>) => void}) {
			const ctx = useRegistrationDraft();
			onReady(ctx);
			return null;
		}
		function TimelineTabDraftProbe({captured}: {captured: {value: ReturnType<typeof useRegistrationDraft> | null}}) {
			captured.value = useRegistrationDraft();
			return null;
		}

		it('a ballot selection made via one entry point is visible from another (production-length fixture ids)', async () => {
			let voteTabCtx: ReturnType<typeof useBallotSelection> | undefined;
			const timelineTabCaptured: {value: ReturnType<typeof useBallotSelection> | null} = {value: null};

			await ReactTestRenderer.act(async () => {
				activeRenderer = ReactTestRenderer.create(
					<AppStateProviders>
						<VoteTabBallotProbe onReady={ctx => (voteTabCtx = ctx)} />
						<TimelineTabBallotProbe captured={timelineTabCaptured} />
					</AppStateProviders>,
				);
			});

			// Production-length fixture ids, not 3-char stubs (standing project rule).
			const officeId = 'office-salt-lake-county-school-board-district-3';
			const candidateId = 'candidate-jordan-michael-alvarez-hutchinson';

			await ReactTestRenderer.act(async () => {
				voteTabCtx!.toggleCandidate(officeId, candidateId, 1);
			});

			expect(timelineTabCaptured.value!.selectionMap[officeId]).toEqual([candidateId]);
		});

		it('a registration draft edit made via one entry point is visible from another (production-length fixture value)', async () => {
			let voteTabCtx: ReturnType<typeof useRegistrationDraft> | undefined;
			const timelineTabCaptured: {value: ReturnType<typeof useRegistrationDraft> | null} = {value: null};

			await ReactTestRenderer.act(async () => {
				activeRenderer = ReactTestRenderer.create(
					<AppStateProviders>
						<VoteTabDraftProbe onReady={ctx => (voteTabCtx = ctx)} />
						<TimelineTabDraftProbe captured={timelineTabCaptured} />
					</AppStateProviders>,
				);
			});

			// Production-length fixture value, not a 3-char stub (standing project rule).
			const lastName = 'Worthington-Hendricks-Oyelaran';

			await ReactTestRenderer.act(async () => {
				voteTabCtx!.updateField('lastName', lastName);
			});

			expect(timelineTabCaptured.value!.draft.lastName).toBe(lastName);
		});
	});

	describe('Group C — planted negative control: the verdict helper is proven capable of failing', () => {
		it('negative control: reports a violation against a pre-lift-shaped harness (providers mounted per-stack)', async () => {
			// Deliberately re-creates TODAY's already-fixed defect shape: each "tab" mounts its
			// OWN private provider instance, exactly as VoteStackNavigator/RegistrationStackNavigator
			// did before the Task 1 lift. Local-only components — mutates no production file.
			function StubHome() {
				return null;
			}
			function StubRegistration() {
				return null;
			}
			function PreLiftVoteTab() {
				return (
					<BallotSelectionProvider>
						<StubHome />
					</BallotSelectionProvider>
				);
			}
			function PreLiftRegistrationTab() {
				return (
					<RegistrationDraftProvider>
						<StubRegistration />
					</RegistrationDraftProvider>
				);
			}
			function PreLiftHarness() {
				return (
					<>
						<PreLiftVoteTab />
						<PreLiftRegistrationTab />
					</>
				);
			}

			let tr!: ReactTestRenderer.ReactTestRenderer;
			await ReactTestRenderer.act(async () => {
				tr = ReactTestRenderer.create(<PreLiftHarness />);
			});
			activeRenderer = tr;

			// RegistrationDraftProvider exists (count 1) but its subtree does NOT contain
			// StubHome — it is a sibling, not an ancestor, exactly like the real pre-lift defect.
			// Assert only that the verdict is NOT the passing one (not an exact violation shape),
			// so this control survives incidental React tree-structure changes.
			const draftVerdict = providerScopeVerdict(tr.root, RegistrationDraftProvider, StubHome);
			expect(draftVerdict.passing).toBe(false);

			const ballotVerdict = providerScopeVerdict(tr.root, BallotSelectionProvider, StubRegistration);
			expect(ballotVerdict.passing).toBe(false);
		});
	});
});
