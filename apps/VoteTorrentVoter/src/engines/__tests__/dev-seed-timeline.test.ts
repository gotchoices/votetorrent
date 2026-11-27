/**
 * dev-seed-timeline.test.ts — D-13 (phase 61, plan 61-05) Tier-1 coverage.
 *
 * 61-05 widened `dev-seed.ts`'s seeded timeline so the honest long-remainder countdown case is
 * reachable on hardware: `registrationEnds` 25d->52d, `ballotsFinal` 14d->40d, `votingStarts`
 * 2d->31d, all three moved TOGETHER. Until this file, that requirement's ONLY evidence was a
 * one-off manual device sanity pass recorded in `61-05-SUMMARY.md` — no automated gate asserted
 * either of D-13's two must-have truths, and `dev-seed.test.ts` contains no timeline reference at
 * all. A later edit could pull `votingStarts` back on its own (exactly the mistake `dev-seed.ts`'s
 * own comment warns against) and nothing in the 57-suite voter run would have gone red.
 *
 * Measured through the PRODUCT's own read chain, not by scanning the source literal:
 * `seedDevNetwork` -> `ElectionsEngine.openElection` -> `getElectionDetails()` ->
 * `details.current.timeline` -> `deriveTimeline` — the identical chain `TimelineScreen.tsx`'s
 * read effect walks. A source-text scan would pass even if `parseTimeline` rejected the blob;
 * reading the derived rows cannot.
 *
 * Tier boundary: this is Tier 1. It proves the seeded INSTANTS and that the view-model resolves
 * confidently over them. It does NOT prove anything rendered on a device — no Yoga pass runs
 * here. See `61-VALIDATION.md`'s Two-Tier Contract.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { ElectionsEngine, NetworksEngine, LocalStorageReact } from '@votetorrent/vote-engine/rn'
import { seedDevNetwork } from '../dev-seed'
import { deriveTimeline } from '../../timeline/derive-timeline'
import { TIMELINE_STAGE_IDS } from '../../timeline/stages'
import type { TimelineStageId } from '../../timeline/stages'
import { setDeviceKeyWrapProviderForTests } from '../device-key-wrap'
import { createInMemoryKeyWrapProviderForTests } from '../__fixtures__/in-memory-key-wrap-provider'

// D-42 (Phase 62 plan 08): seedDevNetwork -> getOrCreateDeviceUser now needs a DeviceKeyWrapProvider.
// Registered at FILE scope (before this file's own describe-level beforeAll seed) so the seed in
// that beforeAll already has a provider installed.
const wrapProvider = createInMemoryKeyWrapProviderForTests()
beforeAll(() => setDeviceKeyWrapProviderForTests(wrapProvider))
afterAll(() => setDeviceKeyWrapProviderForTests(undefined))

const DAY_MS = 86_400_000

/** The gap 61-05 widened, named once so a failure message says which number moved. */
const EXPECTED_VOTING_WINDOW_DAYS = 31

type SeededTimeline = {
	/** The raw blob exactly as `getElectionDetails()` hands it to `TimelineScreen`. */
	blob: unknown
	/** Election fields `deriveTimeline` cross-checks the blob against. */
	election: { ballotDeadline?: number; date?: number }
}

async function seedAndReadTimeline(): Promise<SeededTimeline> {
	const networksEngine = new NetworksEngine(new LocalStorageReact())
	const seeded = await seedDevNetwork(networksEngine)
	const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)
	if (!ctx) throw new Error('test setup: no established context after seedDevNetwork')
	const electionsEngine = new ElectionsEngine(ctx)
	const electionEngine = await electionsEngine.openElection(seeded.electionId)
	const details = await electionEngine.getElectionDetails()
	return {
		blob: details.current.timeline,
		election: { ballotDeadline: details.election.ballotDeadline, date: details.election.date },
	}
}

/** Derive at `now`, refusing to continue on an indeterminate answer (which is itself the defect). */
function instantsAt(seeded: SeededTimeline, now: number): Map<TimelineStageId, number | null> {
	const view = deriveTimeline({ timeline: seeded.blob, now, timeZone: 'UTC', election: seeded.election })
	if (view.indeterminate) {
		throw new Error(`the seeded timeline derived INDETERMINATE — D-13's second truth is broken: ${view.reason}`)
	}
	return new Map(view.rows.map(row => [row.stageId, row.instantMs]))
}

function requireInstant(at: Map<TimelineStageId, number | null>, stageId: TimelineStageId): number {
	const ms = at.get(stageId)
	if (typeof ms !== 'number') {
		throw new Error(`the seeded timeline carries no instant for ${stageId} (got ${String(ms)})`)
	}
	return ms
}

describe('dev seed timeline (D-13 / 61-05) — the widened voting window, read back through the product chain', () => {
	// Same isolation note as dev-seed.test.ts: the RN AsyncStorage jest mock is a module-scope
	// singleton, so a stale `recentNetworks` entry would push a fresh schema-less NetworksEngine
	// down dev-seed's idempotent re-attach branch and throw "Network not opened in this session".
	beforeEach(async () => {
		await AsyncStorage.clear()
	})

	// Seeded once per file: seeding runs the real engine stack and is the slow part. Every
	// assertion below is a pure read over the resulting blob, so they cannot contaminate one
	// another.
	let seeded: SeededTimeline
	beforeAll(async () => {
		await AsyncStorage.clear()
		seeded = await seedAndReadTimeline()
	})

	it('the votingStarts -> tallyingStarts gap is 31 days, measured from the DERIVED instants rather than the source literal', () => {
		const at = instantsAt(seeded, requireInstant(instantsAt(seeded, Date.now()), 'votingStarts'))
		const gapMs = requireInstant(at, 'tallyingStarts') - requireInstant(at, 'votingStarts')
		expect(gapMs / DAY_MS).toBe(EXPECTED_VOTING_WINDOW_DAYS)
	})

	it('at the Voting Period instant the seeded timeline is CONFIDENT, renders ten rows in D-09 order, and makes votingStarts current', () => {
		const votingStartsMs = requireInstant(instantsAt(seeded, Date.now()), 'votingStarts')
		// +1 minute mirrors the dev clock-offset control's own snap (`stop.instantMs + 60_000`),
		// so this is the exact state 61-05's device sanity pass observed.
		const view = deriveTimeline({
			timeline: seeded.blob,
			now: votingStartsMs + 60_000,
			timeZone: 'UTC',
			election: seeded.election,
		})

		expect(view.indeterminate).toBe(false)
		if (view.indeterminate) return
		expect(view.rows.map(row => row.stageId)).toEqual([...TIMELINE_STAGE_IDS])
		expect(view.currentStageId).toBe('votingStarts')
	})

	it('the three preparation instants stay monotonic — registrationEnds <= ballotsFinal <= votingStarts, the invariant that keeps the rail renderable', () => {
		const at = instantsAt(seeded, Date.now())
		const registrationEnds = requireInstant(at, 'registrationEnds')
		const ballotsFinal = requireInstant(at, 'ballotsFinal')
		const votingStarts = requireInstant(at, 'votingStarts')

		expect(registrationEnds).toBeLessThanOrEqual(ballotsFinal)
		expect(ballotsFinal).toBeLessThanOrEqual(votingStarts)
	})

	/**
	 * Committed positive control for the test above. `dev-seed.ts`'s comment claims that moving
	 * `votingStarts` WITHOUT the other two leaves both preparation events later than it, which
	 * raises a blocking `parseTimeline` PREPARATION conflict and blanks the whole view-model.
	 * That claim had no gate. Without this control the monotonicity assertion could be decorative
	 * — a timeline that merely happened to be ordered, with nothing proving disorder is punished.
	 *
	 * Direction matters and cost this test one red iteration: widening the window moves
	 * `votingStarts` EARLIER (further from `tallyingStarts`). So the unsafe edit is pulling it
	 * back past `registrationEnds`/`ballotsFinal` while those two stay put — not nudging it
	 * toward `tallyingStarts`, which preserves the order and is correctly NOT punished.
	 *
	 * The mutated blob is rebuilt from the SEEDED instants (stage ids and `ElectionEvent` members
	 * are the same strings), so it differs from the real seed in exactly one value.
	 */
	it('POSITIVE CONTROL: widening the window by moving votingStarts alone — the mistake the seed comment warns against — does make the view-model indeterminate', () => {
		const at = instantsAt(seeded, Date.now())
		const mutated: Record<string, number> = {}
		for (const stageId of TIMELINE_STAGE_IDS) {
			const ms = at.get(stageId)
			if (typeof ms === 'number') mutated[stageId] = ms
		}
		// One value changed: votingStarts pulled a day earlier than registrationEnds, leaving BOTH
		// preparation events after it while they stay exactly where the seed put them.
		mutated.votingStarts = requireInstant(at, 'registrationEnds') - DAY_MS
		expect(mutated.votingStarts).toBeLessThan(requireInstant(at, 'ballotsFinal'))
		expect(mutated.registrationEnds).toBe(requireInstant(at, 'registrationEnds'))
		expect(mutated.ballotsFinal).toBe(requireInstant(at, 'ballotsFinal'))

		const view = deriveTimeline({ timeline: mutated, now: Date.now(), timeZone: 'UTC', election: seeded.election })

		expect(view.indeterminate).toBe(true)
	})
})
