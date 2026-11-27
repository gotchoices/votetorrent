/**
 * Unit tests for TimelineScreen (Phase 59, plan 59-08, Task 1 — D-01/D-02/D-03/D-04/D-12).
 *
 * Mocks `@react-navigation/native` (spy-able `navigate`, a hand-typed `useTheme` token shape —
 * this path is outside the no-hardcoded-hex gate's scanned roots, so hex literals here are fine,
 * exactly as `ConfirmationScreen.test.tsx:29-46`) and `../../../providers/VoterAppProvider` with
 * an inline factory whose `getEngine` dispatches on engine name and whose `getElection` must stay
 * uncalled (D-04 read-scope fence). Imports the real `'../../../i18n'` instance so `useTranslation`
 * resolves production copy, and uses a 10-key timeline built from `dev-seed.ts`'s own relative
 * shape (`electionDate` anchor, offsets in days/hours) rather than hand-picked instants.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import i18n from '../../../i18n';
import {TimelineRail} from '../../../components/TimelineRail';
import {TIMELINE_STAGE_IDS} from '../../../timeline';

const mockNavigate = jest.fn();

// ---------------------------------------------------------------------------
// useFocusEffect mock registry — mirrors
// RegistrationInboxScreen.test.tsx's 48-25 pattern exactly (the precedent
// `TimelineScreen.tsx`'s own registration-status effect fix follows). Fires
// each registered callback once per callback-identity change (deps `[cb]`,
// matching the real hook while focused) AND exposes `mockTriggerFocus` to
// simulate an explicit re-focus with NO identity change at all — the
// tab-away-and-back case this regression suite is about. Prefixed `mock` —
// babel-plugin-jest-hoist forbids a jest.mock() factory from closing over a
// non-`mock`-prefixed out-of-scope binding.
// ---------------------------------------------------------------------------
interface MockFocusEntry {
	cb: () => void | (() => void);
	cleanup: (() => void) | undefined;
}
let mockFocusEntries: MockFocusEntry[] = [];

/**
 * Simulates a real re-focus: runs every registered callback's cleanup (if
 * any), then re-invokes the callback and records its new cleanup. Call from
 * inside `renderer.act(...)`.
 */
function mockTriggerFocus(): void {
	for (const entry of mockFocusEntries) {
		if (typeof entry.cleanup === 'function') entry.cleanup();
		entry.cleanup = entry.cb() ?? undefined;
	}
}

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({navigate: mockNavigate}),
	// Deferred via a real useEffect keyed on [cb] (NOT called synchronously during render) —
	// mirrors RegistrationInboxScreen.test.tsx's own mock exactly.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require('react');
		ReactLib.useEffect(() => {
			const entry: MockFocusEntry = {cb, cleanup: undefined};
			entry.cleanup = cb() ?? undefined;
			mockFocusEntries.push(entry);
			return () => {
				mockFocusEntries = mockFocusEntries.filter(e => e !== entry);
				if (typeof entry.cleanup === 'function') entry.cleanup();
			};
		}, [cb]);
	},
	// WR-07: the WHOLE theme is sourced from the real module now, not just `type` and `radii`.
	//
	// CR-01 fixed half of this: `type` used to be a hand-copied SUBSET (display/h2/h4/body/caption
	// only), so when CountdownTimer started reading `type.captionSmall` every test through this
	// mock crashed on `undefined.fontSize` -- the component was correct and the stub was stale.
	// But `colors` (11 of the 25 roles themes.ts declares) and `fonts` (3 of 4 -- `heavy` was
	// absent) were left as literals, and that residual half was STRICTLY WORSE than the case that
	// got fixed: a missing `type` token crashes loudly, whereas RN silently accepts `undefined` as
	// a style colour. Any component on this screen reaching for `success`, `muted`,
	// `notification`, `surface`, `accent`, `validBadge`, `progressFill`, `progressTrack`,
	// `registerNegative`, `registerPositive`, `contrast`, `dark`, `important` or `secondary`
	// rendered with no colour at all and the suite stayed green -- asserting against a render no
	// user will ever see.
	//
	// `jest.requireActual` is used because a jest.mock factory is hoisted and may not close over
	// imported bindings. `lightTheme` already carries colors/fonts/type/radii, so returning it
	// whole means there is no subset left that can go stale.
	useTheme: () => jest.requireActual('../../../theme/themes').lightTheme,
}));

// ---- Production-length fixtures (59-UI-SPEC.md, no hand-picked short strings) ----

const PRODUCTION_ELECTION_TITLE = 'Salt Lake County School Board Special Election 2025'; // 53 chars

const SEEDED_ELECTION_ID = 'election-1';

// dev-seed.ts:216-248's own relative shape, extended to ten (59-01) — 180 days out, offsets in
// days/hours from that anchor. Deliberately NOT a hand-picked absolute date set.
const ELECTION_DATE = Date.now() + 180 * 86_400_000;

// `anchor` mirrors dev-seed.ts's own `electionDate`. This fixture is a deliberately frozen
// monotonic ten-event shape, parameterized so header-range tests (Task 2) can anchor it at an
// explicit UTC calendar point instead of "now" (determinism) — it is NOT pinned to dev-seed.ts's
// exact per-event deltas (61-05 widened dev-seed.ts's registrationEnds/ballotsFinal/votingStarts
// gaps to a 31-day votingStarts window; this fixture's own offsets stay as they were so the
// header-range assertions below stay stable).
function buildValidTimeline(anchor: number = ELECTION_DATE, overrides: Partial<Record<string, number>> = {}): Record<string, number> {
	return {
		registrationEnds: anchor - 25 * 86_400_000,
		ballotsFinal: anchor - 14 * 86_400_000,
		votingStarts: anchor - 2 * 86_400_000,
		accruingVotes: anchor - 20 * 3_600_000,
		hashingVotes: anchor - 16 * 3_600_000,
		releasingKeys: anchor - 12 * 3_600_000,
		tallyingStarts: anchor,
		validation: anchor + 86_400_000,
		certificationStarts: anchor + 2 * 86_400_000,
		closed: anchor + 3 * 86_400_000,
		...overrides,
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildElectionDetails(timeline: Record<string, number> = buildValidTimeline(), anchor: number = ELECTION_DATE): any {
	return {
		election: {
			id: SEEDED_ELECTION_ID,
			authorityId: 'authority-1',
			title: PRODUCTION_ELECTION_TITLE,
			date: anchor,
			revisionDeadline: anchor - 30 * 86_400_000,
			ballotDeadline: anchor - 7 * 86_400_000,
			type: 'adhoc',
		},
		current: {
			electionId: SEEDED_ELECTION_ID,
			revision: 0,
			revisionTimestamp: [],
			tags: [],
			instructions: '',
			keyholders: [],
			timeline,
			keyholderThreshold: 1,
		},
	};
}

const SUMMARY_A = {id: SEEDED_ELECTION_ID, title: PRODUCTION_ELECTION_TITLE, authorityName: 'Salt Lake County', date: ELECTION_DATE, type: 'adhoc'};

// ---- Mocked engine boundary: getEngine('elections') -> getElections/openElection/getElectionDetails ----

const mockGetElectionDetails = jest.fn(async () => buildElectionDetails());
const mockElectionEngine = {getElectionDetails: mockGetElectionDetails};

const mockOpenElection = jest.fn(async (_id: string) => mockElectionEngine);
const mockGetElections = jest.fn(async () => [SUMMARY_A]);
const mockElectionsEngine = {getElections: mockGetElections, openElection: mockOpenElection};

// ---- 59-09's registration-status read: `getEngine('network' | 'association' | 'registration')`.
// Stubbed here to resolve cleanly to a "not registered" answer (zero Association rows, zero
// outstanding requests) so this Task 1/2 suite's PRE-EXISTING assertions -- none of which are
// about the registration panel -- aren't disturbed by 59-09's additional, legitimate engine
// calls. `TimelineScreen.test.tsx` still has no test of its own asserting on the panel's
// content; that coverage lives in `RegistrationPanel.test.tsx` and `registration-status.test.ts`.
const mockGetNetworkDetails = jest.fn(async () => ({
	network: {id: 'network-1', hash: 'network-hash-1', name: 'Stub Network', primaryAuthorityId: 'authority-1', relays: [] as string[]},
}));
const mockNetworkEngine = {getDetails: mockGetNetworkDetails};
const mockGetAssociationsByDeviceKey = jest.fn(async () => [] as unknown[]);
const mockListAssociationRequests = jest.fn(async () => [] as unknown[]);
const mockAssociationEngine = {getAssociationsByDeviceKey: mockGetAssociationsByDeviceKey, listAssociationRequestsByDeviceKey: mockListAssociationRequests};

const mockGetEngine = jest.fn(async (engineName: string) => {
	if (engineName === 'elections') {
		return mockElectionsEngine;
	}
	if (engineName === 'network') {
		return mockNetworkEngine;
	}
	if (engineName === 'association') {
		return mockAssociationEngine;
	}
	throw new Error(`unexpected getEngine call: ${engineName}`);
});

const mockGetElection = jest.fn(async () => {
	throw new Error('getElection() must never be called by TimelineScreen (D-04 read-scope fence)');
});

// ---- 59-09: `resolveAttestationProducer().getCurrentDeviceKey()` -- mocked exactly as
// `ConfirmationScreen.test.tsx` mocks the same module, so this suite never reaches the REAL
// hardware-backed producer (`@votetorrent/attestation-native`'s `TurboModuleRegistry` call,
// which is unregistered under Jest and throws `Invariant Violation`).
const mockProvisionDeviceKey = jest.fn(async () => ({publicKey: 'p256-stub-device-key'}));
// 63-18: the status read is a LOOKUP; it must use getCurrentDeviceKey and never the creating call.
const mockGetCurrentDeviceKey = jest.fn(async () => ({publicKey: 'p256-stub-device-key'}));
const mockResolveAttestationProducer = jest.fn((..._args: unknown[]) => ({
	provisionDeviceKey: mockProvisionDeviceKey,
	getCurrentDeviceKey: mockGetCurrentDeviceKey,
}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: (...args: unknown[]) => mockResolveAttestationProducer(...args),
}));

// 63-14: the saved-vote marker read. `mock`-prefixed so babel-plugin-jest-hoist accepts the closure.
const mockReadSavedVoteStatus = jest.fn((..._args: unknown[]) => Promise.resolve<unknown>({state: 'none'}));
jest.mock('../../../engines/saved-vote-status', () => ({
	readSavedVoteStatus: (...args: unknown[]) => mockReadSavedVoteStatus(...args),
}));

let mockSeededElectionId: string | undefined = SEEDED_ELECTION_ID;

const mockSetClockOffsetMs = jest.fn();

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const {useState, useCallback} = jest.requireActual('react');
		const [clockOffsetMs, setOffset] = useState(0);
		const dev = () => (globalThis as {__DEV__?: boolean}).__DEV__ === true;
		// stable identities per offset, like the real provider's useCallbacks (an unstable nowMs
		// would re-fire the screen's read effect every render).
		const setClockOffsetMs = useCallback((ms: number) => {
			mockSetClockOffsetMs(ms);
			if (dev() && Number.isFinite(ms)) {
				setOffset(ms);
			}
		}, []);
		const nowMs = useCallback(() => Date.now() + (dev() ? clockOffsetMs : 0), [clockOffsetMs]);
		return {
			getEngine: mockGetEngine,
			getElection: mockGetElection,
			get seededElectionId() {
				return mockSeededElectionId;
			},
			clockOffsetMs,
			setClockOffsetMs,
			nowMs,
		};
	},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TimelineScreenModule = require('../TimelineScreen');
const TimelineScreen = TimelineScreenModule.default;
const {pickElectionId} = TimelineScreenModule;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<TimelineScreen />);
	});
	return tr;
}

async function flushMicrotasks(times = 30) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

async function renderAndFlush(flushes = 30) {
	const tr = renderScreen();
	await renderer.act(async () => {
		await flushMicrotasks(flushes);
	});
	return tr;
}

function hasTestId(tr: renderer.ReactTestRenderer, testID: string): boolean {
	return tr.root.findAllByProps({testID}).length > 0;
}

// ---- CR-01: device-time-zone mocking. `TimelineScreen.tsx`'s `resolveDeviceTimeZone()` is the
// ONLY zero-argument `Intl.DateTimeFormat()` call anywhere under `src/timeline/` or
// `src/screens/timeline/` (every other call site passes `(language, options)` to FORMAT an
// already-resolved zone, never to resolve one) -- so intercepting exactly the zero-arg shape and
// delegating every other call to the real constructor lets these tests pin the "device" zone
// deterministically (this repo's CI/dev hosts do not all run in UTC) without touching how any
// actual date gets formatted.
const RealDateTimeFormat = Intl.DateTimeFormat;

function mockDeviceTimeZone(zone: string): void {
	jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
		if (args.length === 0) {
			return {resolvedOptions: () => ({timeZone: zone}) as Intl.ResolvedDateTimeFormatOptions} as Intl.DateTimeFormat;
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return new (RealDateTimeFormat as any)(...args);
	}) as unknown as typeof Intl.DateTimeFormat);
}

/** WR-01 (59-REVIEW-2): forces the zero-arg `Intl.DateTimeFormat()` call — the one
 * `resolveDeviceTimeZone()` makes — to THROW, simulating a device/Hermes/ICU build where the
 * resolved-options lookup is unavailable. Every other `Intl` call site in this phase
 * (`relative-date.ts`'s `dateParts`/`weekdayName`) already guards this with try/catch; this
 * proves the screen degrades to its documented UTC fallback instead of crashing render, which
 * would otherwise defeat D-03's "never blank, never silent" guarantee (the voter app has no
 * ErrorBoundary to catch a render throw). */
function mockDeviceTimeZoneThrows(): void {
	jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
		if (args.length === 0) {
			throw new RangeError('resolvedOptions unavailable on this build');
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return new (RealDateTimeFormat as any)(...args);
	}) as unknown as typeof Intl.DateTimeFormat);
}

beforeEach(() => {
	// Pins the "device" zone to UTC by default so every PRE-EXISTING test below (written and
	// reasoned about against UTC-anchored fixtures) stays deterministic regardless of the actual
	// host's local zone. The CR-01 describe block below overrides this per-test to prove the
	// screen actually forwards a non-UTC device zone end to end.
	mockDeviceTimeZone('UTC');
	mockNavigate.mockClear();
	mockGetEngine.mockClear();
	mockGetElection.mockClear();
	mockGetElections.mockClear();
	mockOpenElection.mockClear();
	mockGetElectionDetails.mockClear();
	mockGetNetworkDetails.mockClear();
	mockProvisionDeviceKey.mockClear();
	mockGetCurrentDeviceKey.mockClear();
	mockGetAssociationsByDeviceKey.mockClear();
	mockListAssociationRequests.mockClear();
	mockReadSavedVoteStatus.mockReset();
	mockReadSavedVoteStatus.mockImplementation(async () => ({state: 'none'}));

	mockGetEngine.mockImplementation(async (engineName: string) => {
		if (engineName === 'elections') {
			return mockElectionsEngine;
		}
		if (engineName === 'network') {
			return mockNetworkEngine;
		}
		if (engineName === 'association') {
			return mockAssociationEngine;
		}
		throw new Error(`unexpected getEngine call: ${engineName}`);
	});
	mockGetElections.mockImplementation(async () => [SUMMARY_A]);
	mockOpenElection.mockImplementation(async (_id: string) => mockElectionEngine);
	mockGetElectionDetails.mockImplementation(async () => buildElectionDetails());
	mockGetNetworkDetails.mockImplementation(async () => ({
		network: {id: 'network-1', hash: 'network-hash-1', name: 'Stub Network', primaryAuthorityId: 'authority-1', relays: [] as string[]},
	}));
	mockGetAssociationsByDeviceKey.mockImplementation(async () => []);
	mockListAssociationRequests.mockImplementation(async () => []);

	mockSeededElectionId = SEEDED_ELECTION_ID;

	// A focus-callback entry leaked from a previous test is its own defect class — reset the
	// registry alongside every other mock (mirrors RegistrationInboxScreen.test.tsx:506).
	mockFocusEntries = [];

	// IN-04: pins this file's act() noise at ZERO. A bare `jest.spyOn` still calls through, so
	// any warning is still printed — this only makes it COUNTABLE in afterEach below. Without
	// the guard, the count silently drifts back up: the two warnings this closed were emitted by
	// an unflushed render in one test and landed in a different test's window, which is exactly
	// the shape that is impossible to attribute by eye.
	jest.spyOn(console, 'error');
});

afterEach(() => {
	// Read the spy BEFORE restoring it — restoreAllMocks discards the recorded calls.
	const errorSpy = console.error as unknown as jest.Mock;
	const actViolations: unknown[][] = (errorSpy.mock?.calls ?? []).filter(
		(call: unknown[]) => typeof call[0] === 'string' && call[0].includes('not wrapped in act'),
	);

	jest.restoreAllMocks(); // undoes mockDeviceTimeZone's Intl.DateTimeFormat spy, every test.

	if (actViolations.length > 0) {
		// Deliberately a hard failure, not a warning: the phase's own rationale in the two
		// sibling suites is that unwrapped-update noise must stay at zero so a REAL act()
		// violation added later cannot hide in it. Note the offending update may have been
		// started by an EARLIER test that rendered without draining its async chain.
		throw new Error(
			`IN-04: ${actViolations.length} unwrapped React update(s) reached this test. ` +
				'Wrap the update in renderer.act(...), or drain the pending chain inside act() ' +
				// React passes the component name as a separate format argument, so the raw first
				// arg reads "An update to %s ..." on its own -- splice it back in.
				`before the test that started it returns. First: ${String(actViolations[0][0])
					.split('\n')[0]
					.replace('%s', String(actViolations[0][1] ?? 'a component'))}`,
		);
	}
});

describe('pickElectionId (D-02)', () => {
	it('a single summary -> that summary id', () => {
		expect(pickElectionId([SUMMARY_A], undefined)).toBe(SUMMARY_A.id);
	});

	it('several summaries -> the one nearest to now, ties broken by ascending id', () => {
		const now = Date.now();
		const near = {...SUMMARY_A, id: 'z-far-but-picked-by-tie', date: now + 1000};
		const far = {...SUMMARY_A, id: 'a-election', date: now + 50_000};
		// Exact tie on |date - now| against a THIRD summary decides by ascending id.
		const tieA = {...SUMMARY_A, id: 'b-tie', date: now + 5000};
		const tieB = {...SUMMARY_A, id: 'a-tie', date: now + 5000};

		expect(pickElectionId([far, near], undefined)).toBe(near.id);
		expect(pickElectionId([tieA, tieB], undefined)).toBe('a-tie');
	});

	it('empty list + a fallback id supplied -> the fallback wins (the __DEV__ gate lives at the call site, not here)', () => {
		expect(pickElectionId([], 'seeded-1')).toBe('seeded-1');
	});

	it('empty list + no fallback supplied -> undefined (covers both __DEV__ false, and __DEV__ true with no seed)', () => {
		expect(pickElectionId([], undefined)).toBeUndefined();
	});
});

describe('TimelineScreen — real elections read (D-01)', () => {
	it('drives getEngine -> getElections -> openElection -> getElectionDetails exactly once each, then renders the rail', async () => {
		const tr = await renderAndFlush();

		// 59-09: `getEngine('elections')` fires from THIS effect, exactly once; the screen's
		// SEPARATE registration-status effect (Task 3) also resolves `'network'`/`'association'`
		// through the SAME shared `getEngine` mock, so the TOTAL call count grows from 1 to 3 --
		// asserted by call-args below rather than re-counting a shared mock across two unrelated
		// effects into one brittle total.
		expect(mockGetEngine).toHaveBeenCalledWith('elections');
		expect(mockGetEngine.mock.calls.filter(call => call[0] === 'elections')).toHaveLength(1);
		expect(mockGetElections).toHaveBeenCalledTimes(1);
		expect(mockOpenElection).toHaveBeenCalledTimes(1);
		expect(mockOpenElection).toHaveBeenCalledWith(SEEDED_ELECTION_ID);
		expect(mockGetElectionDetails).toHaveBeenCalledTimes(1);

		expect(hasTestId(tr, 'timeline-rail')).toBe(true);
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
	});

	it('never calls useVoterApp().getElection() (D-04 read-scope fence)', async () => {
		await renderAndFlush();
		expect(mockGetElection).not.toHaveBeenCalled();
	});

	it('before the first read resolves, neither the rail nor the indeterminate frame is mounted', async () => {
		const tr = renderScreen();
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);

		// IN-04: this is the ONE test in the file that deliberately does NOT flush before
		// asserting -- the unflushed window IS its subject. But the read it kicked off is still
		// in flight when the assertions finish, and it used to resolve during some LATER test,
		// outside any act() scope: that is where both of this file's residual "An update to
		// TimelineScreen inside a test was not wrapped in act(...)" warnings came from (they
		// point at `setResolvedElectionId` and the `setState({kind: 'ready', ...})` inside the
		// timeline-read effect, not at anything the later test did). Drain the chain here, now
		// that the assertions are done, so the noise cannot bury a genuine act() violation added
		// later -- the same rationale the two sibling suites already act on.
		await renderer.act(async () => {
			await flushMicrotasks();
		});
		renderer.act(() => {
			tr.unmount();
		});
	});
});

describe('TimelineScreen — D-03 indeterminate frame, four rejection points', () => {
	it('getEngine rejects -> indeterminate frame, rail absent', async () => {
		mockGetEngine.mockRejectedValueOnce(new Error('engine boot failed'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});

	it('getElections rejects -> indeterminate frame, rail absent', async () => {
		mockGetElections.mockRejectedValueOnce(new Error('network read failed'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});

	it('openElection rejects -> indeterminate frame, rail absent', async () => {
		mockOpenElection.mockRejectedValueOnce(new Error('Election election-1 not found'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});

	it('getElectionDetails rejects -> indeterminate frame, rail absent', async () => {
		mockGetElectionDetails.mockRejectedValueOnce(new Error('details read failed'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});

	it('no election id resolvable (empty list, no usable fallback) -> indeterminate frame, rail absent', async () => {
		mockGetElections.mockImplementation(async () => []);
		mockSeededElectionId = undefined;
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
		expect(mockOpenElection).not.toHaveBeenCalled();
	});

	it("the derivation's own indeterminate verdict (all-absent timeline) -> indeterminate frame, rail absent — never a partial/guessed rail", async () => {
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails({}));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});
});

describe('TimelineScreen — retry (D-03)', () => {
	it('a getElections that rejects once then resolves renders the rail after the retry press', async () => {
		mockGetElections.mockRejectedValueOnce(new Error('transient'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);

		const retry = tr.root.findByProps({testID: 'timeline-indeterminate-retry'});
		await renderer.act(async () => {
			retry.props.onPress();
			await flushMicrotasks(30);
		});

		expect(hasTestId(tr, 'timeline-rail')).toBe(true);
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
		expect(mockGetElections).toHaveBeenCalledTimes(2);
	});
});

describe('TimelineScreen — D-04/D-12 read-scope source fence', () => {
	it('the screen source references none of ElectionCard, mockData, devLifecycleFixtures, LIFECYCLE_CONTENT, keysReleased, checksComplete', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path');
		const source: string = fs.readFileSync(path.resolve(__dirname, '../TimelineScreen.tsx'), 'utf8');

		for (const forbidden of ['ElectionCard', 'mockData', 'devLifecycleFixtures', 'LIFECYCLE_CONTENT', 'keysReleased', 'checksComplete']) {
			expect(source).not.toContain(forbidden);
		}
	});
});

function stripCommentsPreservingLines(src: string): string {
	const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '));
	return noBlock.replace(/\/\/.*$/gm, '');
}

/** D-02: returns the list of violations of the shared-clock contract in a TimelineScreen source. */
function sharedClockViolations(rawSource: string): string[] {
	const source = stripCommentsPreservingLines(rawSource);
	const violations: string[] = [];
	if (/\[\s*clockOffsetMs\s*,\s*setClockOffsetMs\s*\]\s*=\s*useState/.test(source)) {
		violations.push('local clockOffsetMs useState');
	}
	if (source.includes('Date.now() + clockOffsetMs')) {
		violations.push('Date.now() + clockOffsetMs');
	}
	const destructure = /const\s*\{([^}]*)\}\s*=\s*useVoterApp\(\)/.exec(source);
	for (const name of ['clockOffsetMs', 'setClockOffsetMs', 'nowMs']) {
		if (!destructure || !new RegExp(`\\b${name}\\b`).test(destructure[1])) {
			violations.push(`useVoterApp() does not name ${name}`);
		}
	}
	return violations;
}

describe('TimelineScreen — shared __DEV__ clock source fence (D-02)', () => {
	it('the screen holds no local clock offset state and reads the shared clock', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path');
		const source: string = fs.readFileSync(path.resolve(__dirname, '../TimelineScreen.tsx'), 'utf8');
		expect(sharedClockViolations(source)).toEqual([]);
	});

	it('self-check: a planted local-clock source is reported', () => {
		const planted = [
			'const {getEngine} = useVoterApp();',
			'const [clockOffsetMs, setClockOffsetMs] = useState(0);',
			'const nowMs = useMemo(() => Date.now() + clockOffsetMs, [clockOffsetMs]);',
		].join('\n');
		const found = sharedClockViolations(planted);
		expect(found).toContain('local clockOffsetMs useState');
		expect(found).toContain('Date.now() + clockOffsetMs');
		expect(found.length).toBeGreaterThanOrEqual(3);
	});
});

// ==== Task 2: header, rail composition, row-action callbacks ====

function textOf(node: renderer.ReactTestInstance): string {
	return JSON.stringify(node.props.children ?? '');
}

describe('TimelineScreen — header (Task 2)', () => {
	it('the 53-char production title renders in full, with no numberOfLines prop', async () => {
		const tr = await renderAndFlush();
		const title = tr.root.findByProps({testID: 'timeline-header-title'});
		expect(title.props.numberOfLines).toBeUndefined();
		expect(textOf(title)).toContain(PRODUCTION_ELECTION_TITLE);
	});

	it('same-month/year range -> endDate is the bare day number ("January 3" - "31")', async () => {
		// Jan 28 2030 UTC anchor: registrationEnds = Jan 3, closed = Jan 31 -- both January 2030.
		const anchor = Date.UTC(2030, 0, 28);
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));

		const tr = await renderAndFlush();
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('January 3');
		expect(textOf(range)).toContain('31');
		expect(textOf(range)).not.toContain('January 31');
	});

	it('cross-month range -> endDate carries its own month name', async () => {
		// Jan 10 2030 UTC anchor: registrationEnds = Dec 16 2029, closed = Jan 13 2030.
		const anchor = Date.UTC(2030, 0, 10);
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));

		const tr = await renderAndFlush();
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('December 16');
		expect(textOf(range)).toContain('January 13');
	});

	it('fewer than two distinct calendar days among present instants -> the date-range line is omitted, title still renders', async () => {
		const dayAnchor = Date.UTC(2030, 2, 15, 0, 0, 0);
		const singleDayTimeline: Record<string, number> = {
			registrationEnds: dayAnchor + 1 * 3_600_000,
			ballotsFinal: dayAnchor + 2 * 3_600_000,
			votingStarts: dayAnchor + 3 * 3_600_000,
			accruingVotes: dayAnchor + 4 * 3_600_000,
			hashingVotes: dayAnchor + 5 * 3_600_000,
			releasingKeys: dayAnchor + 6 * 3_600_000,
			tallyingStarts: dayAnchor + 7 * 3_600_000,
			validation: dayAnchor + 8 * 3_600_000,
			certificationStarts: dayAnchor + 9 * 3_600_000,
			closed: dayAnchor + 10 * 3_600_000,
		};
		// buildElectionDetails' generic ballotDeadline formula (anchor - 7 DAYS) assumes a
		// day-scale anchor; this fixture is hour-scale, so ballotDeadline is set directly here
		// (just after ballotsFinal) instead of reusing that helper's offset.
		mockGetElectionDetails.mockImplementation(async () => ({
			election: {
				id: SEEDED_ELECTION_ID,
				authorityId: 'authority-1',
				title: PRODUCTION_ELECTION_TITLE,
				date: dayAnchor + 7 * 3_600_000,
				revisionDeadline: dayAnchor - 30 * 86_400_000,
				ballotDeadline: dayAnchor + 2.5 * 3_600_000,
				type: 'adhoc',
			},
			current: {
				electionId: SEEDED_ELECTION_ID,
				revision: 0,
				revisionTimestamp: [],
				tags: [],
				instructions: '',
				keyholders: [],
				timeline: singleDayTimeline,
				keyholderThreshold: 1,
			},
		}));

		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
		expect(tr.root.findAllByProps({testID: 'timeline-header-date-range'})).toHaveLength(0);
		expect(textOf(tr.root.findByProps({testID: 'timeline-header-title'}))).toContain(PRODUCTION_ELECTION_TITLE);
	});

	it('a 7-of-10-key timeline (pre-D-08 signed row) still produces a range from the seven present instants -- not indeterminate', async () => {
		const anchor = Date.UTC(2030, 0, 10);
		const sevenKeyTimeline = buildValidTimeline(anchor);
		// The three D-08 additions absent -- a pre-D-08 signed row (parseTimeline tolerates a
		// missing key; MISSING_EVENT degrades per-row, never the whole view-model).
		delete sevenKeyTimeline.accruingVotes;
		delete sevenKeyTimeline.hashingVotes;
		delete sevenKeyTimeline.releasingKeys;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(sevenKeyTimeline, anchor));

		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('December 16');
		expect(textOf(range)).toContain('January 13');
	});
});

// ==== CR-01: TimelineScreen must resolve and forward the DEVICE-local zone, not a hardcoded
// UTC default (types.ts:122's "device-local, never UTC" contract), to both computeHeaderDateRange
// and deriveTimeline. Before the fix, TimelineScreen.tsx never passed `timeZone` to either call
// at all -- so `mockDeviceTimeZone` below (which only intercepts the zero-arg
// `Intl.DateTimeFormat()` resolution call `resolveDeviceTimeZone()` makes) had NO observable
// effect pre-fix, and every assertion in this block that expects a Denver-shifted date failed. ====

// 2030-01-01T03:00:00Z -- January 1 in UTC, but still December 31, 2029 in America/Denver (MST,
// UTC-7, no DST in January): a deliberately zone-sensitive boundary instant, not a hand-picked
// coincidence.
const ZONE_BOUNDARY_INSTANT = Date.UTC(2030, 0, 1, 3, 0, 0);
const ZONE_BOUNDARY_ANCHOR = Date.UTC(2030, 3, 1);

describe('TimelineScreen — device-local time zone default (CR-01)', () => {
	it('header date range: a device zone of America/Denver renders the boundary instant as "December 31", not "January 1"', async () => {
		mockDeviceTimeZone('America/Denver');
		const timeline = buildValidTimeline(ZONE_BOUNDARY_ANCHOR, {registrationEnds: ZONE_BOUNDARY_INSTANT});
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(timeline, ZONE_BOUNDARY_ANCHOR));

		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('December 31');
		expect(textOf(range)).not.toContain('January 1');
	});

	it('header date range: the SAME boundary instant renders as "January 1" under a UTC device zone -- proving the Denver assertion above is genuinely zone-sensitive, not a fixture artifact', async () => {
		mockDeviceTimeZone('UTC');
		const timeline = buildValidTimeline(ZONE_BOUNDARY_ANCHOR, {registrationEnds: ZONE_BOUNDARY_INSTANT});
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(timeline, ZONE_BOUNDARY_ANCHOR));

		const tr = await renderAndFlush();
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('January 1');
		expect(textOf(range)).not.toContain('December 31');
	});

	it('rail MM/DD label: deriveTimeline itself receives the forwarded device zone -- registrationEnds\' rail label shifts a day between America/Denver and UTC', async () => {
		const timeline = buildValidTimeline(ZONE_BOUNDARY_ANCHOR, {registrationEnds: ZONE_BOUNDARY_INSTANT});
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(timeline, ZONE_BOUNDARY_ANCHOR));

		type Row = {stageId: string; railLabel: {kind: string; text?: string}};

		mockDeviceTimeZone('America/Denver');
		const denverTr = await renderAndFlush();
		const denverRow = (denverTr.root.findByType(TimelineRail).props.rows as Row[]).find(r => r.stageId === 'registrationEnds');

		mockDeviceTimeZone('UTC');
		const utcTr = await renderAndFlush();
		const utcRow = (utcTr.root.findByType(TimelineRail).props.rows as Row[]).find(r => r.stageId === 'registrationEnds');

		expect(denverRow?.railLabel).toEqual({kind: 'date', text: '12/31'});
		expect(utcRow?.railLabel).toEqual({kind: 'date', text: '01/01'});
	});
});

describe('TimelineScreen — row subtitle weekday follows the active language', () => {
	let previousLanguage: string;

	beforeEach(() => {
		previousLanguage = i18n.language;
	});

	afterEach(async () => {
		await renderer.act(async () => {
			await i18n.changeLanguage(previousLanguage);
		});
	});

	it('under Español, a near-future row\'s {{weekday}} param is the Spanish weekday name, not the English one', async () => {
		// Anchored 3 days out so several rows (votingStarts .. tallyingStarts) fall 1-6 calendar
		// days ahead and carry `subtitle.futureWeekday` with a `weekday` param.
		const anchor = Date.now() + 3 * 86_400_000;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));
		await renderer.act(async () => {
			await i18n.changeLanguage('es');
		});

		const tr = await renderAndFlush();
		type Row = {stageId: string; instantMs: number | null; subtitle: {key: string; params?: {weekday?: string}} | null};
		const rows = tr.root.findByType(TimelineRail).props.rows as Row[];
		const weekdayRows = rows.filter(r => typeof r.subtitle?.params?.weekday === 'string');
		expect(weekdayRows.length).toBeGreaterThan(0);

		for (const row of weekdayRows) {
			const at = new Date(row.instantMs as number);
			const es = new RealDateTimeFormat('es', {timeZone: 'UTC', weekday: 'long'}).format(at);
			const en = new RealDateTimeFormat('en', {timeZone: 'UTC', weekday: 'long'}).format(at);
			expect(row.subtitle?.params?.weekday).toBe(es);
			expect(row.subtitle?.params?.weekday).not.toBe(en);
		}
	});
});

describe('TimelineScreen — rail composition and callback wiring (Task 2)', () => {
	it('TimelineRail is mounted exactly once in the ready state, zero times in the indeterminate state', async () => {
		const ready = await renderAndFlush();
		expect(ready.root.findAllByType(TimelineRail)).toHaveLength(1);

		mockGetElections.mockImplementation(async () => {
			throw new Error('boom');
		});
		const indeterminate = await renderAndFlush();
		expect(indeterminate.root.findAllByType(TimelineRail)).toHaveLength(0);
	});

	it('every callback prop TimelineRail declares is bound to a function -- none is undefined', async () => {
		const tr = await renderAndFlush();
		const rail = tr.root.findByType(TimelineRail);

		for (const propName of [
			'onHelp',
			'onSeeDetails',
			'onEditRegistration',
			'onPreviewBallot',
			'onVoteNow',
			'onViewKeyholders',
		]) {
			expect(typeof rail.props[propName]).toBe('function');
		}
		// 63-14: the saved-vote link is offered only when a vote is saved, so it is unbound by default.
		expect(rail.props.onViewSubmission).toBeUndefined();
	});

	it.each([
		['onVoteNow', 'Ballot'],
		['onPreviewBallot', 'Ballot'],
		['onEditRegistration', 'RegistrationHome'],
		['onViewKeyholders', 'Keyholders'],
	])('%s navigates to %s', async (propName, routeName) => {
		const tr = await renderAndFlush();
		const rail = tr.root.findByType(TimelineRail);

		renderer.act(() => {
			(rail.props[propName] as () => void)();
		});

		expect(mockNavigate).toHaveBeenCalledWith(routeName);
	});

	it('see-details and the row help affordance both open a dialog titled with the stage\'s translated title, and it closes on its close control', async () => {
		const tr = await renderAndFlush();
		const rail = tr.root.findByType(TimelineRail);

		renderer.act(() => {
			(rail.props.onSeeDetails as (stageId: string) => void)('votingStarts');
		});

		const dialog = tr.root.findByProps({testID: 'info-dialog'});
		expect(dialog).toBeDefined();
		expect(JSON.stringify(tr.toJSON())).toContain('Voting Period');

		const close = tr.root.findByProps({testID: 'info-dialog-close'});
		renderer.act(() => {
			close.props.onPress();
		});
		expect(tr.root.findAllByProps({testID: 'info-dialog'})).toHaveLength(0);

		// The same dialog seam serves the row `?` help affordance.
		renderer.act(() => {
			(rail.props.onHelp as (stageId: string) => void)('registrationEnds');
		});
		expect(JSON.stringify(tr.toJSON())).toContain('Registration Ends');
	});
});

// ==== Task 3: __DEV__ clock-offset control (D-05) ====

type RailRow = {stageId: string; status: string};

function currentStageId(tr: renderer.ReactTestRenderer): string | undefined {
	const rail = tr.root.findByType(TimelineRail);
	const rows = rail.props.rows as RailRow[];
	return rows.find(row => row.status === 'current')?.stageId;
}

async function pressClockOffset(tr: renderer.ReactTestRenderer) {
	const control = tr.root.findByProps({testID: 'timeline-dev-clock-offset'});
	await renderer.act(async () => {
		control.props.onPress();
		await flushMicrotasks(30);
	});
}

describe('TimelineScreen — __DEV__ clock-offset control (Task 3, D-05)', () => {
	const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;

	afterEach(() => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = originalDev;
	});

	it('with __DEV__ false, no control renders and no dev-offset label appears anywhere in the tree', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = false;
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-dev-clock-offset')).toBe(false);
		expect(JSON.stringify(tr.toJSON())).not.toContain('DEV:');
	});

	it('with __DEV__ true, the control renders above the header, outside the rail, with a dashed colors.warning border', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		const control = tr.root.findByProps({testID: 'timeline-dev-clock-offset'});
		const flatStyle = Object.assign({}, ...(Array.isArray(control.props.style) ? control.props.style : [control.props.style]));
		expect(flatStyle.borderStyle).toBe('dashed');
		expect(flatStyle.borderColor).toBe('#bcb600'); // colors.warning, per this file's mocked theme

		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('DEV:');
	});

	it('starts at the live position: offset 0 (label shows a zero delta) and no row is current against the far-future production fixture', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('0');
		expect(currentStageId(tr)).toBeUndefined();
	});

	it('a press moves the SHARED clock through setClockOffsetMs with a finite non-zero offset (D-02)', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();
		await pressClockOffset(tr);
		expect(mockSetClockOffsetMs).toHaveBeenCalled();
		const arg = mockSetClockOffsetMs.mock.calls[mockSetClockOffsetMs.mock.calls.length - 1][0];
		expect(Number.isFinite(arg)).toBe(true);
		expect(arg).not.toBe(0);
	});

	it('wrapping back to live sets the shared offset to exactly 0 (D-02)', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();
		// stages + final-day probe + the wrap back to live (same cycle the WR-01 probe test walks)
		for (let i = 0; i < TIMELINE_STAGE_IDS.length + 2; i++) {
			await pressClockOffset(tr);
		}
		expect(mockSetClockOffsetMs.mock.calls[mockSetClockOffsetMs.mock.calls.length - 1][0]).toBe(0);
	});

	it('walking the full press cycle makes each of the ten stages current exactly once, collected as a SET (D-09) -- not a spot check', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		const seen = new Set<string>();
		for (let i = 0; i < TIMELINE_STAGE_IDS.length; i++) {
			await pressClockOffset(tr);
			const id = currentStageId(tr);
			if (id) seen.add(id);
		}

		expect(seen).toEqual(new Set(TIMELINE_STAGE_IDS));
	});

	it('offers the WR-01 final-day probe after the last stage stop, then wraps back to live', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		for (let i = 0; i < TIMELINE_STAGE_IDS.length; i++) {
			await pressClockOffset(tr);
		}

		// WR-01: one press past the stage stops is the synthetic final-day probe -- the only stop
		// that puts `nowMs` inside the last 24h before tallyingStarts while votingStarts is still
		// current, and therefore the only way CountdownTimer's `<24h` branch renders on a device.
		// Before this stop existed that branch was unreachable on hardware, which is how CR-01's
		// label-width defect shipped past a green suite AND a passing geometry gate.
		await pressClockOffset(tr);
		const probeLabel = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(probeLabel)).toContain(i18n.t('dev.finalDayStop', {ns: 'timeline'}));
		expect(textOf(probeLabel)).toContain('Voting Period');

		// One more press returns to the live stop.
		await pressClockOffset(tr);
		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('0');
		expect(textOf(label)).not.toContain('Registration Ends');
		expect(textOf(label)).not.toContain(i18n.t('dev.finalDayStop', {ns: 'timeline'}));
	});

	it('a 7-of-10-key timeline offers exactly 9 stops (7 stages + final-day probe + live) -- absent instants are skipped, never a dead stop', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const anchor = Date.UTC(2030, 0, 10);
		const sevenKeyTimeline = buildValidTimeline(anchor);
		delete sevenKeyTimeline.accruingVotes;
		delete sevenKeyTimeline.hashingVotes;
		delete sevenKeyTimeline.releasingKeys;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(sevenKeyTimeline, anchor));

		const tr = await renderAndFlush();

		const seen = new Set<string>();
		for (let i = 0; i < 7; i++) {
			await pressClockOffset(tr);
			const id = currentStageId(tr);
			if (id) seen.add(id);
		}
		expect(seen.size).toBe(7);

		// WR-01: the 8th press is the final-day probe. It stays valid on this 7-key timeline --
		// accruingVotes/hashingVotes/releasingKeys are absent, so the next instant after
		// votingStarts is tallyingStarts itself and the probe at -23h still clears it.
		await pressClockOffset(tr);
		expect(textOf(tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'}))).toContain(i18n.t('dev.finalDayStop', {ns: 'timeline'}));

		// The 9th press is the live stop again.
		await pressClockOffset(tr);
		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('0');
	});

	// IN-05: `clockStopIndex` is React state; `clockStops` is recomputed from `state.view.rows` on
	// every render. The timeline-read effect re-runs on every `nowMs` change -- i.e. on every press
	// of this control -- so the engine can answer with a SHORTER timeline while the index stays put.
	// `clockStops[clockStopIndex - 1]` is then `undefined`, and the label used to fall all the way
	// through to its live form ("<label> 0") while the non-zero offset was still driving the rail
	// and the countdown. That is the "label and countdown disagree" shape D-13 closed; it must not
	// come back through the dev control.
	//
	// The assertion is deliberately an INVARIANT rather than a fixed string: the label reads as live
	// if and only if the offset actually applied to the rail is zero. That stays true whichever way
	// a future fix chooses to reconcile the two (clamp the index, or report the raw offset).
	it('IN-05: a stop list that shrinks under a live offset never leaves the label reading as live', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		// `textOf` JSON-stringifies the node's children, so the expected value must be stringified
		// too -- comparing a raw string against it silently never matches, which makes an
		// invariant assertion like the one below pass vacuously.
		const liveLabel = JSON.stringify(`${i18n.t('dev.clockOffsetLabel', {ns: 'timeline'})} 0`);
		const readLabel = () => textOf(tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'}));
		const readAppliedOffset = () => tr.root.findByType(TimelineRail).props.nowOffsetMs as number;

		// Walk well past the end of the shorter list installed below.
		for (let i = 0; i < 8; i++) {
			await pressClockOffset(tr);
		}
		expect(readAppliedOffset()).not.toBe(0);
		expect(readLabel()).not.toBe(liveLabel);

		// The engine's answer changes underneath: a five-key timeline offers five stage stops plus
		// the final-day probe, fewer than the index we are sitting on.
		const anchor = Date.UTC(2030, 0, 10);
		const fiveKeyTimeline = buildValidTimeline(anchor);
		delete fiveKeyTimeline.accruingVotes;
		delete fiveKeyTimeline.hashingVotes;
		delete fiveKeyTimeline.releasingKeys;
		delete fiveKeyTimeline.validation;
		delete fiveKeyTimeline.certificationStarts;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(fiveKeyTimeline, anchor));

		// One more press: the effect refetches against the new `nowMs` and the stop list shrinks.
		await pressClockOffset(tr);

		expect(readLabel() === liveLabel).toBe(readAppliedOffset() === 0);

		// ...and the index itself must have been clamped, not left pointing past the end of the
		// shortened list: the very next press has to land on the FIRST stop of the new list. With a
		// stale index of 9 against 6 stops, `(9 + 1) % 7` would land on the third stop instead --
		// an arbitrary position that reads like a press was skipped.
		await pressClockOffset(tr);
		expect(readLabel()).toContain('Registration Ends');
	});

	it("the label at a stage stop names that stage's translated title", async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		await pressClockOffset(tr); // first D-09 stop: registrationEnds
		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('Registration Ends');
	});

	it('never calls setLifecycleOverride and never imports LIFECYCLE_ORDER; HomeScreen keeps its own cycler untouched', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path');

		const screenSource: string = fs.readFileSync(path.resolve(__dirname, '../TimelineScreen.tsx'), 'utf8');
		expect(screenSource).not.toContain('setLifecycleOverride');
		expect(screenSource).not.toContain('LIFECYCLE_ORDER');

		const homeSource: string = fs.readFileSync(path.resolve(__dirname, '../../home/HomeScreen.tsx'), 'utf8');
		expect(homeSource).toContain('nextLifecycleOverride');
		expect(homeSource).toContain('LIFECYCLE_ORDER');
		expect(homeSource).toContain('setLifecycleOverride');
	});
});

// ==== Regression: the registration-status panel must re-read on focus, not just at mount ====
//
// React Navigation keeps tab screens MOUNTED when a voter tabs away and back — leaving the
// Timeline tab and returning must NOT require a full app restart to see a fresh registration
// answer. This suite's own DECLARED BLIND SPOT (mirrors RegistrationInboxScreen.test.tsx 48-25):
// `mockTriggerFocus()` simulates a re-focus by re-invoking every `useFocusEffect` callback
// currently registered; it does not prove React Navigation actually delivers a focus event on a
// real tab switch — that is a navigation-container behavior this mock stands in for. What IS
// proven here: mounting once, changing the underlying engine's answer, and refocusing (no
// remount) makes the SAME rendered tree reflect the new answer — the exact distinction a
// fresh-mount-only test can never make.
describe('TimelineScreen — registration panel re-reads on focus (regression, stale-vs-fresh)', () => {
	beforeEach(() => {
		// `TimelineRow.tsx`'s `showPanel = !isDeemphasized && panel != null` never renders the
		// panel for a `future`-status row -- so this block needs `registrationEnds` already in the
		// PAST relative to "now" (an election 5 days out, registration having closed 20 days ago),
		// unlike every other describe block in this file which uses the 180-day-out default.
		const anchor = Date.now() + 5 * 86_400_000;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));
	});

	it('renders notRegistered at mount, then pending after a simulated refocus with no remount', async () => {
		const tr = await renderAndFlush();

		const initialSentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
		expect(textOf(initialSentence)).toContain('You are not registered');

		// The device just completed a real Register ceremony elsewhere -- the engine's own answer
		// has changed, but nothing has remounted this screen.
		mockListAssociationRequests.mockImplementation(async () => [
			{authorityId: 'authority-1', deviceKey: 'p256-stub-device-key', status: 'p', electionId: SEEDED_ELECTION_ID},
		]);

		await renderer.act(async () => {
			mockTriggerFocus();
			await flushMicrotasks(30);
		});

		const refocusedSentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
		expect(textOf(refocusedSentence)).toContain('awaiting a decision');
		expect(textOf(refocusedSentence)).not.toContain('You are not registered');

		// 63-18: the status read is a lookup; refocusing must NEVER mint a device key.
		expect(mockGetCurrentDeviceKey).toHaveBeenCalled();
		expect(mockProvisionDeviceKey).not.toHaveBeenCalled();
	});

	it('a refocus with an unchanged answer does not spam the association engine (no refresh storm)', async () => {
		const tr = await renderAndFlush();
		const callsAfterMount = mockListAssociationRequests.mock.calls.length;
		expect(callsAfterMount).toBeGreaterThan(0);

		await renderer.act(async () => {
			mockTriggerFocus();
			await flushMicrotasks(30);
		});

		// Exactly one MORE read fired for the one refocus -- not zero (proves it re-ran) and not a
		// loop (proves it ran only once per refocus).
		expect(mockListAssociationRequests.mock.calls.length).toBe(callsAfterMount + 1);
		void tr;
	});
});

describe('TimelineScreen — device time-zone resolution degrades safely (WR-01)', () => {
	it('still renders the timeline when the zero-arg Intl.DateTimeFormat() throws, instead of crashing render', async () => {
		mockDeviceTimeZoneThrows();
		const tr = await renderAndFlush();
		// The rail must still be on screen. Before the fix this line is never reached: the throw
		// escapes `resolveDeviceTimeZone()` during render and takes the whole screen down.
		expect(hasTestId(tr, 'timeline-rail')).toBe(true);
	});
});

describe('TimelineScreen — saved vote on the Voting Period row (D-12, D-21)', () => {
	const STALE = 'The election changed after you voted. Please vote again.';

	// anchor = now + 1 day puts votingStarts one day back and accruingVotes ahead: CURRENT.
	function openVoting(): void {
		const anchor = Date.now() + 86_400_000;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));
	}
	function hostsById(tr: renderer.ReactTestRenderer, id: string) {
		return tr.root.findAll(n => typeof n.type === 'string' && n.props.testID === id);
	}
	function nodeText(n: renderer.ReactTestInstance | string): string {
		return typeof n === 'string' ? n : n.children.map(c => nodeText(c as renderer.ReactTestInstance | string)).join('');
	}
	async function mountWith(status: unknown) {
		openVoting();
		mockReadSavedVoteStatus.mockImplementation(async () => status);
		return renderAndFlush();
	}
	const railOf = (tr: renderer.ReactTestRenderer) => tr.root.findByType(TimelineRail);

	it('TS1: reads the status with the engine deps, a numeric clock and the resolved election id (D-19)', async () => {
		await mountWith({state: 'none'});
		expect(mockReadSavedVoteStatus).toHaveBeenCalled();
		const [deps, nowMs, electionId] = mockReadSavedVoteStatus.mock.calls[0];
		expect(deps).toEqual({getEngine: mockGetEngine, fallbackElectionId: 'election-1'});
		expect(typeof nowMs).toBe('number');
		expect(electionId).toBe('election-1');
	});

	it('TS2: none offers Vote now and no saved-vote link or panel', async () => {
		const tr = await mountWith({state: 'none'});
		expect(typeof railOf(tr).props.onVoteNow).toBe('function');
		expect(railOf(tr).props.onViewSubmission).toBeUndefined();
		expect(JSON.stringify(tr.toJSON())).not.toContain('timeline-saved-vote');
	});

	it('TS3: saved hides Vote now, shows the status, and the link opens the receipt with electionId only', async () => {
		const tr = await mountWith({state: 'saved', revisionKnown: true});
		const rail = railOf(tr);
		expect(rail.props.onVoteNow).toBeUndefined();
		expect(typeof rail.props.onViewSubmission).toBe('function');
		renderer.act(() => {
			(rail.props.onViewSubmission as () => void)();
		});
		expect(mockNavigate).toHaveBeenCalledWith('VoteReceipt', {electionId: 'election-1'});
		expect(nodeText(hostsById(tr, 'timeline-saved-vote-status')[0])).toBe('Vote saved — not sent');
		expect(hostsById(tr, 'timeline-row-view-submission-votingStarts').length).toBeGreaterThan(0);
		expect(hostsById(tr, 'timeline-row-vote-now-votingStarts').length).toBe(0);
	});

	it('TS3b: sent shows the sent line, no not-sent line, and hides Vote now', async () => {
		const tr = await mountWith({state: 'sent'});
		expect(nodeText(hostsById(tr, 'timeline-saved-vote-sent')[0])).toBe('Your vote has been sent to the election.');
		expect(hostsById(tr, 'timeline-saved-vote-status').length).toBe(0);
		expect(JSON.stringify(tr.toJSON())).not.toContain('Vote saved — not sent');
		expect(railOf(tr).props.onVoteNow).toBeUndefined();
	});

	it('TS4: stale shows the exact D-21 line and keeps Vote now', async () => {
		const tr = await mountWith({state: 'stale', revisionKnown: true});
		expect(typeof railOf(tr).props.onVoteNow).toBe('function');
		expect(typeof railOf(tr).props.onViewSubmission).toBe('function');
		expect(nodeText(hostsById(tr, 'timeline-saved-vote-stale')[0])).toBe(STALE);
	});

	it('TS5: unreadable hides Vote now and shows the unreadable line', async () => {
		const tr = await mountWith({state: 'unreadable'});
		expect(railOf(tr).props.onVoteNow).toBeUndefined();
		expect(typeof railOf(tr).props.onViewSubmission).toBe('function');
		expect(hostsById(tr, 'timeline-saved-vote-unreadable').length).toBe(1);
	});

	it('TS6: an unknown revision adds the honest note', async () => {
		const tr = await mountWith({state: 'saved', revisionKnown: false});
		expect(hostsById(tr, 'timeline-saved-vote-revision-unknown').length).toBe(1);
	});

	it('TS7: re-reads on every focus and never caches', async () => {
		const tr = await mountWith({state: 'none'});
		expect(hostsById(tr, 'timeline-saved-vote-status').length).toBe(0);
		const before = mockReadSavedVoteStatus.mock.calls.length;
		mockReadSavedVoteStatus.mockImplementation(async () => ({state: 'saved', revisionKnown: true}));
		await renderer.act(async () => {
			mockTriggerFocus();
			await flushMicrotasks(30);
		});
		expect(mockReadSavedVoteStatus.mock.calls.length).toBe(before + 1);
		expect(hostsById(tr, 'timeline-saved-vote-status').length).toBe(1);
	});

	it('TS8: a rejected read fails closed to unreadable', async () => {
		openVoting();
		mockReadSavedVoteStatus.mockImplementation(async () => {
			throw new Error('secret failure detail');
		});
		const tr = await renderAndFlush();
		expect(hostsById(tr, 'timeline-saved-vote-unreadable').length).toBe(1);
		expect(railOf(tr).props.onVoteNow).toBeUndefined();
		expect(JSON.stringify(tr.toJSON())).not.toContain('secret failure detail');
	});

	it('TS9: on a past Voting Period row the link appears only when a vote is saved', async () => {
		const anchor = Date.now() - 2 * 3_600_000 + 20 * 3_600_000;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));
		const none = await renderAndFlush();
		const row = (railOf(none).props.rows as Array<{stageId: string; status: string}>).find(r => r.stageId === 'votingStarts');
		expect(row?.status).toBe('past');
		expect(hostsById(none, 'timeline-row-view-submission-votingStarts').length).toBe(0);

		mockReadSavedVoteStatus.mockImplementation(async () => ({state: 'saved', revisionKnown: true}));
		const saved = await renderAndFlush();
		expect(hostsById(saved, 'timeline-row-view-submission-votingStarts').length).toBeGreaterThan(0);
	});

	it('TS10: with no readable election no saved-vote read happens', async () => {
		mockGetElections.mockImplementation(async () => {
			throw new Error('boom');
		});
		await renderAndFlush();
		expect(mockReadSavedVoteStatus).not.toHaveBeenCalled();
	});

	describe('TS11: source discipline', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path');
		const raw: string = fs.readFileSync(path.resolve(__dirname, '../TimelineScreen.tsx'), 'utf8');
		const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		it.each(['readSavedVoteStatus(', "navigation.navigate('VoteReceipt', {electionId", 'useFocusEffect('])('contains %s', needle => {
			expect(code).toContain(needle);
		});
		it.each(["navigation.navigate('ReviewSubmit')", 'revealOnOpen', 'AsyncStorage', 'openVoteRecord', 'console.'])(
			'does not contain %s',
			needle => {
				expect(code).not.toContain(needle);
			},
		);
	});
});
