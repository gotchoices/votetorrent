/**
 * registrant-dev-seed.ts — `__DEV__`-guarded, flag-gated registrant fixture
 * (Phase 47-23 Task 1, marker fixed in the 47-23 continuation).
 *
 * WHY THIS EXISTS (47-23-PLAN.md `<blocking_precondition>`): zero UI in this
 * app can create a registrant — `IRegistrationEngine.register()` is a real,
 * fully-implemented `'vrg'`-signed multi-row ceremony, but registration
 * request/approval flows are Phase 48's scope. Six of the nine Phase 47
 * surfaces (registrants list, registrant detail, private tier, status
 * change, associations, challenges, and the election roster's filtered rows)
 * are therefore unwalkable on a fresh device without seeded data. This
 * module is that data — nothing more. It is never reachable from any UI
 * control, and the committed tree ships it OFF (`REGISTRANT_SEED_ENABLED`
 * in `proof-flags.generated.ts`).
 *
 * Direct analog: `apps/VoteTorrentVoter/src/engines/dev-seed.ts` (Phase
 * 44-06) — same `__DEV__` throw guard, same "no hand-rolled signing SQL"
 * rule. This module differs in one structural way: it does NOT create the
 * network/authority/election — the D-15 walkthrough creates those through
 * the real Add Network / Create Election UI (47-23-PLAN.md leg A0), because
 * a successful network creation under the nine-code `FOUNDING_OFFICER_SCOPES`
 * seed IS the D-15 evidence this walkthrough exists to capture. This module
 * only seeds what happens AFTER that: registrants, a status spread, an
 * election enrollment, an attestation policy, two challenges, and one
 * association.
 *
 * COMPLETION-MARKER FIX (47-23 continuation, root-caused by the orchestrator
 * before this file was touched): the ORIGINAL design gated the "already
 * seeded — no writes" shortcut on `Registrant.Id = <first registrant's id>`
 * existing. That row is written in step (3); the status spread, enrollment,
 * attestation policy, challenges and association are steps (4)-(8). If the
 * seed threw ANYWHERE in (4)-(8), the marker row already existed, and every
 * later launch logged the "already seeded" line and skipped the unfinished
 * work FOREVER — the marker claimed completion of work it did not gate. This
 * is now fixed two ways:
 *   1. The completion signal is a DEDICATED AsyncStorage key
 *      (`seedCompletionKey`, below), written ONLY as the LAST statement of a
 *      successful run — after step (8), not step (3). AsyncStorage (not a
 *      DB row) so the marker cannot be confused with, or accidentally
 *      satisfied by, any of the seed's own data rows; the same pattern this
 *      app already uses for `persistence-proof-runner.ts`'s completion
 *      tracking. Keyed by `networkRef.hash` so seeding a second network
 *      never reads a stale marker from a different one.
 *   2. Every write in steps (3)-(8) is now individually idempotent (an
 *      existence check before each write), because "the completion marker is
 *      absent" can now mean EITHER "never started" OR "started and crashed
 *      partway" — and a re-run must resume, not re-throw on a primary-key
 *      collision against rows a prior partial run already wrote.
 *
 * MARKER/DATA DOMAIN SPLIT (47-REVIEW WR-07): moving the marker to
 * AsyncStorage fixed the mid-sequence problem but introduced a second one —
 * the marker and the data it describes now live in DIFFERENT persistence
 * domains. The seeded rows live in the network's LevelDB store, which "Start
 * Fresh" (`AppProvider`) and `run-vtest02.sh`'s `rm -rf votetorrent-q2-*` both
 * wipe; neither touches AsyncStorage. After any store reset the marker
 * survived and the seed reported "already seeded — re-attaching, no writes"
 * against an EMPTY database, leaving the walkthrough unseedable with no
 * indication why. The completion check therefore cross-checks the marker
 * against a witness row (registrant 0, written first in step (3)) before
 * trusting it. That witness can only DEMOTE a completion claim, never grant
 * one, so it does not reintroduce the mid-sequence bug above.
 *
 * Do NOT hand-roll any signing-ceremony SQL here — every mutation below goes
 * through a real `vote-engine` method (`RegistrationEngine.register` /
 * `changeStatus` / `enrollElectionRegistrant`, `AssociationEngine.
 * issueAttestationChallenge` / `associate`, `RegistrationEngine.
 * setElectionAttestationPolicy`) that owns its own Digest / admin-signing /
 * admin-signature ceremony internally. The app layer only ever supplies a
 * `SignCallback` — never a raw private key, never a raw admin-signing row
 * write, and never a schema-CHECK-context signature bypass flag. A
 * hand-rolled row write would bypass the very CHECK this walkthrough is
 * trying to prove (T-47-23-07). The idempotency guards above are plain
 * `select` reads — never a hand-rolled `insert`/`update`.
 *
 * Logging discipline (T-47-23-02, a hard constraint, not a style note):
 * every `console.*` line this module emits carries counts, registrant ids,
 * and step names ONLY. No `PrivateDetail`, no `RegisterInit`, and no caught
 * error object that could embed one may ever be passed to `console.*` — a
 * caught error is always logged as `err instanceof Error ? err.message :
 * String(err)`. If this module's own output leaked a private value, it
 * would poison Task 2's logcat grep and either manufacture a false T-47-02
 * failure or mask a real one.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import type {
	DeviceAttestation,
	NetworkReference,
	PrivateDetail,
	RegisterInit,
	Signature,
	User,
} from '@votetorrent/vote-core'
import type { EngineContext, IKeyVault } from '@votetorrent/vote-engine/rn'
import {
	AssociationEngine,
	IntakeEngine,
	NetworksEngine,
	RegistrationEngine,
} from '@votetorrent/vote-engine/rn'
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).
import { REGISTRANT_SEED_ENABLED } from './proof-flags.generated'
import { resolveAuthorityKeyVault } from './key-vault'

/** App-layer sign callback shape — mirrors `device-signer.ts`'s `SignCallback`. */
type SignCallback = (digest: Uint8Array) => Promise<Signature>

/** Deterministic id prefix — every id/key this module writes derives from this, never `crypto.randomUUID()` (idempotency must be structural). */
const SEED_ID_PREFIX = 'authority-47-23-dev-seed'

const REGISTRANT_COUNT = 12

/**
 * AsyncStorage key prefix for the DEDICATED completion marker — written ONLY
 * as the LAST statement of a successful seed (after step 8), never earlier.
 * Keyed by network hash so a second, distinct network's seed is never
 * short-circuited by a marker a different network's run left behind.
 */
const SEED_COMPLETE_KEY_PREFIX = `${SEED_ID_PREFIX}-complete`
const SEED_COMPLETE_MARKER_VALUE = 'v2'

function seedCompletionKey(networkHash: string): string {
	return `${SEED_COMPLETE_KEY_PREFIX}:${networkHash}`
}

/**
 * seedPrivateLiterals() — the EXHAUSTIVE list of every private-tier VALUE this
 * fixture writes (36 = 12 registrants x 3 fields). This is the grep corpus
 * 47-23 Task 2's leg B logcat/Metro check uses; exposing it as a single source
 * of truth means the grep list can never drift from the fixture. Every value
 * is drawn from a reserved/never-issued range so it is realistic in SHAPE (the
 * reveal UI renders what an officer would really see) but cannot collide with
 * real data and is unambiguous as a grep token:
 *   - SSN: the `900-86-XXXX` block (the 900-series is never issued by SSA).
 *   - DateOfBirth: `1970-01-XX` (an arbitrary but plausible epoch-adjacent date).
 *   - Phone: `+1-555-01XX` (the `555-0100`..`555-0199` fiction-reserved block).
 * A change here requires re-running Task 2's leg B logcat check — the grep
 * list and the fixture's actual writes must never diverge.
 *
 * A FUNCTION, not a module-level `const` built by an IIFE (47-REVIEW WR-11).
 * The IIFE form executed at IMPORT time, so a release bundle built and held 36
 * synthetic SSN/DOB/phone strings in memory on every cold start, for a module
 * whose entire body is gated off in release. Memoised, so the seed's own
 * repeated calls still build the list once.
 */
let seedPrivateLiteralsCache: readonly string[] | undefined

export function seedPrivateLiterals(): readonly string[] {
	if (seedPrivateLiteralsCache !== undefined) return seedPrivateLiteralsCache
	const literals: string[] = []
	for (let i = 0; i < REGISTRANT_COUNT; i++) {
		literals.push(`900-86-${String(4000 + i).padStart(4, '0')}`) // SSN
		literals.push(`1970-01-${String(10 + i).padStart(2, '0')}`) // DateOfBirth
		literals.push(`+1-555-01${String(10 + i).padStart(2, '0')}`) // Phone
	}
	seedPrivateLiteralsCache = literals
	return seedPrivateLiteralsCache
}

/** Deterministic per-index registrant id. */
function registrantId(i: number): string {
	return `${SEED_ID_PREFIX}-registrant-${i}`
}

/** Per-index district — at least THREE distinct values across 12 registrants. */
const DISTRICTS = ['North', 'South', 'East']

/** Per-index surname — 12 distinct surnames so both a non-empty and a provably-empty name search exist. */
const SURNAMES = [
	'Adler', 'Baxter', 'Cole', 'Drake', 'Ellison', 'Farrow',
	'Grant', 'Hale', 'Ibarra', 'Jasper', 'Kwan', 'Lane',
]

const FIRST_NAMES = [
	'Ada', 'Ben', 'Cora', 'Dane', 'Eve', 'Finn',
	'Gia', 'Hugo', 'Iris', 'Jax', 'Kira', 'Leo',
]

/** Per-index private-tier values (SSN/DateOfBirth/Phone) — sourced from seedPrivateLiterals(), never re-derived. */
function privateDetailsFor(i: number): PrivateDetail[] {
	const literals = seedPrivateLiterals()
	return [
		{ name: 'SSN', value: literals[i * 3]! },
		{ name: 'DateOfBirth', value: literals[i * 3 + 1]! },
		{ name: 'Phone', value: literals[i * 3 + 2]! },
	]
}

/** Result handed back to the AppProvider boot block. */
export interface SeedRegistrantFixturesResult {
	/** Whether this call performed writes (`false` on the idempotent re-attach branch). */
	seeded: boolean
	electionId: string
	registrantIds: string[]
	/** Registrant ids currently 'a' (active). */
	activeRegistrantIds: string[]
	/** Registrant ids currently 's' (suspended). */
	suspendedRegistrantIds: string[]
	/** Registrant ids currently 'r' (revoked). */
	revokedRegistrantIds: string[]
	/** Registrant ids enrolled in the election — a strict 5-of-12 subset (D-07 filter). */
	enrolledRegistrantIds: string[]
	/** The registrant id whose association was attempted (step 8) — undefined if that step never ran. */
	associationRegistrantId?: string
	/** Whether the association (step 8) is present — false if it was never attempted or its non-fatal attempt failed. */
	associationSucceeded: boolean
	/** The nonce of the challenge left outstanding (step 7's second challenge, never consumed). */
	outstandingChallengeNonce?: string
}

/**
 * Seed (or, if already seeded, report) the registrant fixtures against an
 * ALREADY-OPEN network. `__DEV__`-guarded with a throw (voter `dev-seed.ts`
 * precedent) so a release build can never reach it even if the flag were
 * mistakenly left on.
 *
 * RUNTIME-GUARDED, NOT ELIMINATED (47-REVIEW WR-11). An earlier version of
 * this comment claimed Metro strips this module from a release bundle as dead
 * code. It does not, and believing otherwise would be the wrong basis for
 * deciding what may live here:
 *   - `AppProvider.tsx` imports `maybeSeedRegistrantFixtures` statically, so
 *     this module is in the release module graph unconditionally.
 *   - Metro does not tree-shake by default; only `if (__DEV__)`-shaped
 *     BRANCHES are collapsed by the minifier. `seedRegistrantFixtures`,
 *     `SeedRegistrantFixturesResult`, `reattachSummary` and
 *     `seedPrivateLiterals` all survive into the release bundle.
 * What IS true: the throw guard below plus `maybeSeedRegistrantFixtures`'
 * `__DEV__ && REGISTRANT_SEED_ENABLED` gate mean nothing here EXECUTES in
 * release. `seedPrivateLiterals()` was converted from a module-level IIFE to a
 * memoised function for the same reason — as an IIFE it really did build its
 * 36 synthetic strings at import time in release.
 *
 * The fixture's 12 names and its literal generator therefore ship in the
 * release binary as inert code. The values are drawn from reserved/never-
 * issued ranges so they are not real PII; that is the actual mitigation, not
 * elimination.
 *
 * `networksEngine` is caller-supplied so this module stays DB-factory-
 * agnostic, mirroring the voter seed's `networksEngine` parameter.
 */
export async function seedRegistrantFixtures(
	networksEngine: NetworksEngine,
	networkRef: NetworkReference,
	user: User,
	sign: SignCallback,
	options?: { intakeVault?: IKeyVault },
): Promise<SeedRegistrantFixturesResult> {
	if (!(globalThis as { __DEV__?: boolean }).__DEV__) {
		throw new Error('seedRegistrantFixtures: must never run outside __DEV__ — this is a dev-only fixture (47-23)')
	}

	const ctx = networksEngine.getEstablishedContext(networkRef.hash)
	if (!ctx) {
		throw new Error('seedRegistrantFixtures: no established context for the given networkRef — open the network first')
	}

	const registrationEngine = new RegistrationEngine(ctx)
	const associationEngine = new AssociationEngine(ctx)

	// Completion check — a DEDICATED AsyncStorage marker, checked before any
	// write, but written ONLY at the very end of a successful run (see the
	// header comment). This is deliberately NOT a query against any row this
	// seed itself writes: a DB-row marker created mid-sequence is exactly the
	// bug this fix closes.
	const completionKey = seedCompletionKey(networkRef.hash)
	const alreadyComplete = (await AsyncStorage.getItem(completionKey)) === SEED_COMPLETE_MARKER_VALUE

	// Election lookup — needed on BOTH branches (reattach still needs
	// electionId). The walkthrough's operator creates the election through
	// the real UI (47-23-PLAN.md leg A0) — this fixture never creates one, so
	// a fixture that silently manufactured an election could hide a broken
	// create-election path behind the seed.
	const details = await (await networksEngine.open(networkRef, user)).getDetails()
	const authorityId = details.network.primaryAuthorityId
	const electionRow = await ctx.db
		.prepare('select Id from Election where AuthorityId = :authorityId limit 1')
		.get({ authorityId })
	if (!electionRow) {
		console.log('[seed] SKIPPED — create an Election in the app first, then relaunch')
		return {
			seeded: false,
			electionId: '',
			registrantIds: [],
			activeRegistrantIds: [],
			suspendedRegistrantIds: [],
			revokedRegistrantIds: [],
			enrolledRegistrantIds: [],
			associationSucceeded: false,
		}
	}
	const electionId = electionRow.Id as string

	if (alreadyComplete) {
		// The marker and the DATA live in two different persistence domains:
		// the marker in AsyncStorage, the seeded rows in the network's LevelDB
		// store. "Start Fresh" (AppProvider) and run-vtest02.sh's
		// `rm -rf votetorrent-q2-*` both wipe the store and neither touches
		// AsyncStorage — so after any store reset the marker survived, this
		// branch was taken, and reattachSummary returned all-empty arrays
		// against an empty DB. The walkthrough was unseedable with nothing at
		// all indicating why.
		//
		// So: cross-check the marker against a WITNESS row before trusting it.
		// Registrant 0 is written in step (3), the very first write of the
		// sequence, so its absence means the data is gone. This does not
		// reintroduce the DB-row-marker bug the header warns about: a witness
		// can only DEMOTE a completion claim, never grant one — a partial run
		// that wrote registrant 0 and crashed still has no marker and still
		// resumes below.
		const witness = await ctx.db.prepare('select Id from Registrant where Id = :id').get({ id: registrantId(0) })
		if (witness) {
			console.log('[seed] already seeded — re-attaching, no writes')
			return reattachSummary(ctx, electionId)
		}
		console.log('[seed] completion marker present but data absent (store reset) — re-seeding')
		await AsyncStorage.removeItem(completionKey)
	}

	// Fresh — or RESUMED-PARTIAL — seed. "Not complete" can mean "never
	// started" OR "started and crashed partway" (the exact scenario the
	// original marker design masked), so every write below is guarded by an
	// existence check rather than assumed to be a first run.

	// D-49 (62-31): register() below is now D-49-sealed (RegistrationRequest is not written here,
	// but RegistrantPrivate is, and register() always seals it). Before the first register() call,
	// ensure the seeding officer is an intake recipient — the default vault is the SAME one 62-21's
	// `officer-intake-key.ts` resolves (`resolveAuthorityKeyVault()`), so a key this seed registers
	// is the SAME one a real "enable encrypted intake" tap would have produced; a caller-supplied
	// `options.intakeVault` (the test's Map-backed vault) overrides it. Never writes or logs a raw
	// key — `registerOfficerEncryptionKey` owns that custody discipline internally.
	const intakeVault = options?.intakeVault ?? resolveAuthorityKeyVault()
	const intakeEngine = new IntakeEngine(ctx)
	const existingRecipients = await intakeEngine.listIntakeRecipients(authorityId)
	if (existingRecipients.recipients.length === 0) {
		await intakeEngine.registerOfficerEncryptionKey(authorityId, intakeVault, sign)
	}

	// (3) 12 registrants, all three tiers. Guarded per-registrant: a prior
	// partial run may have already written some of these.
	const farFutureExpiration = new Date(Date.now() + 3 * 365 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
	const nearTermExpiration = new Date(Date.now() + 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

	const registrantIds: string[] = []
	let registeredThisRun = 0
	for (let i = 0; i < REGISTRANT_COUNT; i++) {
		const id = registrantId(i)
		registrantIds.push(id)
		const existing = await ctx.db.prepare('select Id from Registrant where Id = :id').get({ id })
		if (existing) {
			continue
		}
		// At least one near-term and one far-future — indices 0 and 1 are
		// near-term, giving the expiration filter a real partition.
		const expiration = i < 2 ? nearTermExpiration : farFutureExpiration
		const init: RegisterInit = {
			// electionId deliberately OMITTED — including it would gate this
			// write on ElectionRegistrationField policy rows this fixture
			// deliberately does not create.
			registrant: { id, authorityId, expiration },
			public: {
				firstName: FIRST_NAMES[i % FIRST_NAMES.length],
				lastName: SURNAMES[i]!,
				district: DISTRICTS[i % DISTRICTS.length]!,
			},
			private: {
				expiration,
				details: privateDetailsFor(i),
			},
			selective: {
				expiration,
				// The engine generates the salts (D-13) — this fixture must
				// never construct or pass one.
				details: [
					{ name: 'Party', value: i % 2 === 0 ? 'Independent' : 'Unaffiliated' },
					{ name: 'BirthYear', value: 1970 + (i % 5) },
				],
			},
		}
		await registrationEngine.register(init, sign)
		registeredThisRun++
	}
	console.log(`[seed] registrants present=${registrantIds.length} registered-this-run=${registeredThisRun}`)

	// (4) Status spread — 9 active (default 'a', untouched), 2 suspended, 1
	// revoked. Guarded: only call changeStatus when the current row's status
	// differs from the target (a re-run against an already-transitioned
	// registrant must not re-fire the ceremony).
	const suspendedRegistrantIds = [registrantIds[9]!, registrantIds[10]!]
	const revokedRegistrantIds = [registrantIds[11]!]
	async function ensureStatus(id: string, target: 'a' | 's' | 'r'): Promise<void> {
		const row = await ctx!.db.prepare('select Status from Registrant where Id = :id').get({ id })
		const current = row ? (row.Status as string) : undefined
		if (current !== target) {
			await registrationEngine.changeStatus(id, target, sign)
		}
	}
	for (const id of suspendedRegistrantIds) {
		await ensureStatus(id, 's')
	}
	for (const id of revokedRegistrantIds) {
		await ensureStatus(id, 'r')
	}
	const activeRegistrantIds = registrantIds.filter(
		(id) => !suspendedRegistrantIds.includes(id) && !revokedRegistrantIds.includes(id),
	)
	console.log(`[seed] status spread applied — active=${activeRegistrantIds.length} suspended=${suspendedRegistrantIds.length} revoked=${revokedRegistrantIds.length}`)

	// (5) Election enrollment — a STRICT 5-of-12 subset. If all 12 were
	// enrolled, the roster surface would render identically to the
	// unfiltered roster and the pre-applied D-07 filter would be
	// unfalsifiable on device. Guarded: ElectionRegistrant's primary key is
	// (ElectionId, RegistrantId) — a second enroll for an already-enrolled
	// pair would throw.
	const enrolledRegistrantIds = registrantIds.slice(0, 5)
	for (const id of enrolledRegistrantIds) {
		const existing = await ctx.db
			.prepare('select 1 as x from ElectionRegistrant where ElectionId = :electionId and RegistrantId = :id')
			.get({ electionId, id })
		if (existing) {
			continue
		}
		await registrationEngine.enrollElectionRegistrant(electionId, id, sign)
	}
	console.log(`[seed] enrolled ${enrolledRegistrantIds.length} of ${registrantIds.length} registrants in the election`)

	// (6) Attestation policy — the ONLY way associate() can succeed on a
	// device with unprovisioned Play Console keys: it makes
	// association-engine.ts's fail-closed gate skip verifier.verify()
	// entirely. Consequence: no AttestationVerdict row will be written for
	// the resulting association below, so the badge will show the
	// no-verdict state — that is correct behavior, not a defect. This write
	// is `insert or replace` inside the engine, so it is naturally
	// idempotent and safe to call unconditionally on a resumed run.
	await registrationEngine.setElectionAttestationPolicy(electionId, false, sign)
	console.log('[seed] attestation policy set — AttestationRequired=false (non-attested path)')

	// (7) Two attestation challenges for two ACTIVE registrants — the
	// AttestationChallenge.RegistrantIdValid CHECK additionally requires
	// R.Status = 'a', so a suspended/revoked registrant would be rejected.
	// Guarded: reuse an existing outstanding challenge for the same
	// (registrant, deviceKey) pair rather than issuing a duplicate on a
	// resumed run.
	const firstChallengeDeviceKey = `${SEED_ID_PREFIX}-device-0`
	const secondChallengeDeviceKey = `${SEED_ID_PREFIX}-device-1`
	async function ensureChallenge(forRegistrantId: string, deviceKey: string): Promise<{ nonce: string }> {
		const existing = await ctx!.db
			.prepare('select Nonce from AttestationChallenge where RegistrantId = :registrantId and DeviceKey = :deviceKey')
			.get({ registrantId: forRegistrantId, deviceKey })
		if (existing) {
			return { nonce: existing.Nonce as string }
		}
		const issued = await associationEngine.issueAttestationChallenge(
			forRegistrantId,
			deviceKey,
			sign,
			electionId,
		)
		return { nonce: issued.nonce }
	}
	const firstChallenge = await ensureChallenge(activeRegistrantIds[0]!, firstChallengeDeviceKey)
	const secondChallenge = await ensureChallenge(activeRegistrantIds[1]!, secondChallengeDeviceKey)
	console.log(`[seed] challenges present — nonces=${firstChallenge.nonce.slice(0, 8)}…,${secondChallenge.nonce.slice(0, 8)}…`)

	// (8) One association, consuming the FIRST challenge — the SECOND is
	// left outstanding so the challenges section has a row to inspect and
	// expire. Guarded: Association's primary key is (RegistrantId,
	// DeviceKey) — check first, then attempt inside its own try/catch
	// (non-fatal): it is the single most environment-sensitive step, and
	// losing the associations row must not cost the walkthrough its other
	// eleven surfaces, and must not block the completion marker below.
	let associationSucceeded = false
	const existingAssociation = await ctx.db
		.prepare('select 1 as x from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
		.get({ registrantId: activeRegistrantIds[0]!, deviceKey: firstChallengeDeviceKey })
	if (existingAssociation) {
		associationSucceeded = true
		console.log(`[seed] association already present for registrant ${activeRegistrantIds[0]}`)
	} else {
		try {
			const attestation: DeviceAttestation = {
				publicKey: firstChallengeDeviceKey,
				deviceId: `${SEED_ID_PREFIX}-android-device-0`,
				attestationTime: Date.now(),
				certificateChain: [],
				// No attestationStatement — the non-attested path never reads one.
			}
			await associationEngine.associate(
				{
					registrantId: activeRegistrantIds[0]!,
					deviceKey: firstChallengeDeviceKey,
					deviceHash: `${SEED_ID_PREFIX}-device-hash-0`,
					nonce: firstChallenge.nonce,
					attestation,
				},
				sign,
			)
			associationSucceeded = true
			console.log(`[seed] association created for registrant ${activeRegistrantIds[0]}`)
		} catch (err) {
			console.log('[seed] association step failed (non-fatal)', err instanceof Error ? err.message : String(err))
		}
	}

	// (9) DEDICATED completion marker — the LAST statement of the seed,
	// written whether or not step (8)'s non-fatal association succeeded.
	// This is what makes the "already seeded" gate honest: it can only be
	// true once steps (3)-(8) have all been reached, never merely (3).
	await AsyncStorage.setItem(completionKey, SEED_COMPLETE_MARKER_VALUE)
	console.log('[seed] completion marker written — steps 1-8 reached (association non-fatal; see associationSucceeded)')

	return {
		seeded: true,
		electionId,
		registrantIds,
		activeRegistrantIds,
		suspendedRegistrantIds,
		revokedRegistrantIds,
		enrolledRegistrantIds,
		associationRegistrantId: activeRegistrantIds[0],
		associationSucceeded,
		outstandingChallengeNonce: secondChallenge.nonce,
	}
}

/**
 * Reconstruct an honest summary from the DB's actual state on the
 * already-complete branch — read-only `select`s against the deterministic
 * id set, never a hand-rolled write.
 */
async function reattachSummary(
	ctx: EngineContext,
	electionId: string,
): Promise<SeedRegistrantFixturesResult> {
	const registrantIds: string[] = []
	const activeRegistrantIds: string[] = []
	const suspendedRegistrantIds: string[] = []
	const revokedRegistrantIds: string[] = []
	for (let i = 0; i < REGISTRANT_COUNT; i++) {
		const id = registrantId(i)
		const row = await ctx.db.prepare('select Status from Registrant where Id = :id').get({ id })
		if (!row) {
			continue
		}
		registrantIds.push(id)
		const status = row.Status as string
		if (status === 's') {
			suspendedRegistrantIds.push(id)
		} else if (status === 'r') {
			revokedRegistrantIds.push(id)
		} else {
			activeRegistrantIds.push(id)
		}
	}

	const enrolledRegistrantIds: string[] = []
	for (const id of registrantIds) {
		const enrolled = await ctx.db
			.prepare('select 1 as x from ElectionRegistrant where ElectionId = :electionId and RegistrantId = :id')
			.get({ electionId, id })
		if (enrolled) {
			enrolledRegistrantIds.push(id)
		}
	}

	const associationRegistrantId = activeRegistrantIds[0]
	let associationSucceeded = false
	if (associationRegistrantId) {
		const assocRow = await ctx.db
			.prepare('select 1 as x from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
			.get({ registrantId: associationRegistrantId, deviceKey: `${SEED_ID_PREFIX}-device-0` })
		associationSucceeded = Boolean(assocRow)
	}

	return {
		seeded: false,
		electionId,
		registrantIds,
		activeRegistrantIds,
		suspendedRegistrantIds,
		revokedRegistrantIds,
		enrolledRegistrantIds,
		associationRegistrantId,
		associationSucceeded,
	}
}

/**
 * The flag gate. Returns immediately unless `__DEV__ && REGISTRANT_SEED_ENABLED`
 * (static import of the flag only; a dynamic `require()` breaks Metro, Phase
 * 16-07). Wraps `seedRegistrantFixtures` in try/catch, logging `[seed]
 * FATAL —` with the error MESSAGE only and swallowing it, so a seed failure
 * can never take down the app's boot path (the `signing-proof-runner.ts`
 * convention).
 *
 * `createSign` is a LAZY FACTORY, not a resolved signer, and that is the whole
 * point of its shape. `createDeviceSigner` (Phase 49 hardware rewrite) signs
 * through the Android Keystore-backed `signWithDeviceKey` native ceremony —
 * no private key material is ever read out of AsyncStorage — and it throws
 * `NO_KEY_PROVISIONED` when the device has never completed the biometric
 * `ProvisionSigningKeyScreen` ceremony. Taking a resolved `SignCallback`
 * forced the caller to do both key resolution and (pre-Phase-49) a raw-key
 * read on EVERY cold start — including release builds, where this function
 * is guaranteed to no-op — and a throw there landed in AppProvider's
 * re-attach catch, blanking a perfectly good network behind "Failed to load
 * network". Deferring the call to after the gate means release builds never
 * touch signer resolution for this fixture, and a signer failure in dev
 * (including an unprovisioned device) is caught below as a seed failure,
 * which is what it is.
 */
export async function maybeSeedRegistrantFixtures(
	networksEngine: NetworksEngine,
	networkRef: NetworkReference,
	user: User,
	createSign: () => Promise<SignCallback>,
): Promise<void> {
	if (!(__DEV__ && REGISTRANT_SEED_ENABLED)) {
		return
	}
	try {
		// Inside the try on purpose: a createSign() rejection is a seed failure,
		// not a boot failure.
		const sign = await createSign()
		await seedRegistrantFixtures(networksEngine, networkRef, user, sign)
	} catch (err) {
		console.log('[seed] FATAL —', err instanceof Error ? err.message : String(err))
	}
}
