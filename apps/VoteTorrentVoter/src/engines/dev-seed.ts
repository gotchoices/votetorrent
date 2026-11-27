/**
 * dev-seed.ts — D-05/D-07/D-08 dev-only network/authority/election/policy fixture
 * (Phase 44-06).
 *
 * DECISIVE RESEARCH FINDING THIS MODULE OPERATIONALIZES (44-RESEARCH.md Pitfall 1):
 * `RegistrationEngine.register()` signs BOTH the row-level `Registrant.Signature`
 * digest AND the `vrg`-scoped `AdminSigning` ceremony with the SAME signer — and
 * `AdminSigning.UserIdValid` requires that signer's `signerUserId` already be a row
 * in `Officer` for the target authority. Neither a throwaway voter keypair nor the
 * libp2p/CadreNode peer key (`loadOrCreateRNPeerKey`) satisfies this — that key is
 * NEVER inserted into User/Officer/UserKey (44-RESEARCH.md Anti-Patterns).
 *
 * Resolution: this seed makes the device's own resolved identity (`device-user.ts`/
 * `device-signer.ts`, from 44-02) the network's FOUNDING OFFICER via
 * `NetworksEngine.create()`'s first-authority branch (`votetorrent.qsql` Officer.
 * InsertValid: "part of the very first authority in the network — no invite, no
 * signing"). The SAME device signer then signs `register()` — one identity, two
 * roles (voter + authority officer), matching the project's local-single-device
 * dev posture (D-04/D-07).
 *
 * The seed also writes `ElectionRegistrationField` policy rows — one per tier
 * (public/private/selective) — via the real `RegistrationEngine.
 * addElectionRegistrationField` (Phase 42-07). An empty policy table makes
 * `validateFieldPolicy` a silent no-op (`field-policy.ts:96`, Pitfall 5); this seed
 * deliberately avoids that gap so D-08's "policy enforced for real" claim holds.
 *
 * Do NOT hand-roll any signing-ceremony SQL here — every mutation below goes
 * through a real `vote-engine` method (`NetworksEngine.create`, `ElectionsEngine.
 * seedElectionSigning`/`seedElectionRevisionSigning`/`createElection`,
 * `RegistrationEngine.addElectionRegistrationField`, `ElectionEngine.proposeBallot`/`submitBallotForConfirmation`,
`SignatureTasksEngine.completeSignature`)
 * that owns its own Digest/AdminSigning/AdminSignature ceremony internally. The app layer only ever
 * supplies a `SignCallback` — never a raw private key, never a raw AdminSigning
 * INSERT, and never a schema-CHECK-context signature bypass flag.
 *
 * `__DEV__`-guarded and idempotent: re-running against an already-seeded network
 * (matched by name in `getRecentNetworks()`) re-attaches and returns the existing
 * network/election instead of re-creating them; the policy rows are only inserted
 * once (a second `addElectionRegistrationField` for the same (ElectionId,
 * FieldName) would violate that table's primary key).
 */

import {
	ElectionEvent,
	ElectionType,
	type ElectionCoreInit,
	type ElectionRevisionInit,
	type Ballot,
	type BallotSignatureTask,
	type NetworkInit,
	type NetworkReference,
	type Question,
	type Scope,
	type User,
} from '@votetorrent/vote-core'
import {
	ElectionsEngine,
	NetworksEngine,
	RegistrationEngine,
	SignatureTasksEngine,
	peekNextElectionTid,
	type EngineContext,
} from '@votetorrent/vote-engine/rn'
import { createDeviceSigner, type SignCallback } from './device-signer'
import { getOrCreateDeviceUser } from './device-user'
import { resolveAttestationProducer } from './attestation-producer'
import { isDeviceKeyAbsent } from './attestation-failure'
import { SEED_REGISTERED_STATE_FIXTURE } from './proof-flags.generated'

/** Display name used for the seeded device identity (voter + founding officer, one identity). */
const DEV_SEED_DISPLAY_NAME = 'Dev Voter'

/** Marker name used to find the previously-seeded network on re-run (idempotency). */
export const DEV_SEED_NETWORK_NAME = 'VoteTorrent Dev Network'

/** Marker name for the seeded primary authority. */
const DEV_SEED_AUTHORITY_NAME = 'Dev Election Authority'

/** Marker title for the seeded election. */
const DEV_SEED_ELECTION_TITLE = 'Dev Voter Registration Election'

/**
 * Deterministic id for the D-23(f) dev-seeded `registered`-state `Registrant` —
 * stable across dev boots so `seedRegistrantAssociation`'s idempotent re-attach can
 * find the EXISTING row via `getRegistrant()` rather than minting a fresh random id
 * (and therefore a duplicate row) on every boot.
 */
const DEV_SEED_ASSOCIATION_REGISTRANT_ID = 'dev-seed-registered-state-registrant'

/**
 * D-23(f) (owner-locked 2026-09-15): the minimal structural shape this file needs
 * from `packages/vote-engine/src/dev/seed-registrant-association.ts`'s
 * `seedRegistrantAssociation` export — declared here rather than imported from
 * `@votetorrent/vote-engine`, matching `attach-voter-request-transport.ts`'s own
 * convention for its deep-relative dev-only imports.
 */
type SeedRegistrantAssociationFn = (
	ctx: EngineContext,
	authorityId: string,
	registrant: { id: string; privateCid?: string; expiration?: number | string },
	deviceKey: string,
	sign: SignCallback,
) => Promise<{ registrant: unknown; association: unknown }>;

// Deep RELATIVE dist-path require — deliberately NOT a bare "@votetorrent/vote-engine"
// specifier. The package's `exports` map only publishes the `.`/`./rn` subpaths — this
// dev-only ceremony module lives outside either, by design (D-23f: it must never be
// reachable via a bare specifier a release bundler could resolve implicitly). `__DEV__`
// build-time-gated and lazily `require`d so a release build's module graph never
// includes it — Metro replaces `__DEV__` with a literal `false` in the release
// transform, making the branch below unreachable there. Mirrors
// `attach-voter-request-transport.ts`'s `loadRestAssociationTransport()` shape exactly:
// same early return, same eslint-disable, same relative `packages/vote-engine/dist/...`
// path shape (resolved by running `yarn workspace @votetorrent/vote-engine build` and
// checking its actual `dist/dev/` output — not guessed).
function loadRegistrantAssociationSeeder(): SeedRegistrantAssociationFn | undefined {
	if (!__DEV__) return undefined;
	return require('../../../../packages/vote-engine/dist/dev/seed-registrant-association.js')
		.seedRegistrantAssociation as SeedRegistrantAssociationFn;
}

/**
 * D-23(f)/D-23(b)/D-23(c) — seeds (or re-attaches to) the dev-only `registered`-state
 * fixture: a `Status = 'a'` `Registrant` and its matching `Association`, bound to the
 * SAME P-256 device key `resolveAttestationProducer().getCurrentDeviceKey()` returns
 * (resolved by CALLING the producer, never a hardcoded placeholder — D-23b), so a real
 * device-key round trip through `getAssociationsByDeviceKey` finds it.
 *
 * OPT-IN (62-51): this fixture is no longer seeded by default. A default-on binding of the stub
 * device key made every fresh dev Voter read as registered-without-a-code (UAT 62 test 14), hiding
 * the Continue on This Device entry link. Enable it with `SEED_REGISTERED_STATE_FIXTURE` in
 * `proof-flags.generated.ts` or the `registeredStateFixture` option of `seedDevNetwork`.
 *
 * HONESTY FENCE: this seeds a UI FIXTURE. It is NEVER evidence that the real
 * registration ceremony works — the real ceremony requires a cross-device authority
 * decision this single-process seed does not exercise. SUNSET: delete this call (and
 * the engine-side fixture it drives) once D-17 / P2P-11 unblocks the real cross-device
 * authority path — tracked at
 * `.planning/todos/pending/2026-09-15-retire-engine-side-registered-state-dev-fixture.md`.
 *
 * `dev-seed.ts` itself gains no ceremony token of its own here — the forbidden
 * identifiers (`register(`/`associate(`/`seedSignedMutation`/`issueAttestationChallenge`)
 * stay inside the engine-side module this function only calls through
 * `loadRegistrantAssociationSeeder()`.
 */
async function seedRegisteredAssociationFixture(
	ctx: EngineContext,
	authorityId: string,
	sign: SignCallback,
): Promise<void> {
	const seedRegistrantAssociation = loadRegistrantAssociationSeeder();
	// Unreachable while __DEV__ is true (seedDevNetwork already throws above when it is
	// not), but checked because the loader is itself gated — an unattached harness must
	// be a silent no-op, never a throw.
	if (!seedRegistrantAssociation) return;

	// Bind the association to the CURRENT key. `provisionDeviceKey` regenerates the key on Android, so
	// calling it on a device that already has one would orphan the association (63-18). Create the
	// key (once) only when none exists, i.e. a fresh install.
	const producer = resolveAttestationProducer();
	let deviceKey: string;
	try {
		deviceKey = (await producer.getCurrentDeviceKey()).publicKey;
	} catch (err) {
		if (!isDeviceKeyAbsent(err)) throw err;
		deviceKey = (await producer.provisionDeviceKey()).publicKey;
	}
	await seedRegistrantAssociation(ctx, authorityId, { id: DEV_SEED_ASSOCIATION_REGISTRANT_ID }, deviceKey, sign);
}

/** One `select` question for the dev ballot: `voteFor` becomes `optionRange.max`. */
function devSelectQuestion(
	code: string,
	title: string,
	group: string,
	sequence: number,
	voteFor: number,
	options: Array<[code: string, title: string, party: string]>,
	required: boolean,
): Question {
	return {
		code,
		title,
		instructions: '',
		type: 'select',
		optionRange: { min: 1, max: voteFor },
		group,
		sequence,
		required,
		options: options.map(([optionCode, optionTitle, party]) => ({ code: optionCode, title: optionTitle, details: party })),
	}
}

/** The dev election's ballot content (the voter app's former in-memory mock ballot, now real rows). */
export const DEV_SEED_BALLOT_QUESTIONS: Question[] = [
	devSelectQuestion('us-senate', 'U.S. Senate', 'Federal', 0, 1, [
		['diana', 'Diana Foster', 'Democratic Party'],
		['marcus', 'Marcus Whitfield', 'Republican Party'],
		['elena', 'Elena Vasquez', 'Independent'],
	], true),
	devSelectQuestion('us-house', 'U.S. House of Representatives, District 2', 'Federal', 1, 1, [
		['james', 'James Okafor', 'Democratic Party'],
		['laura', 'Laura Bennett', 'Republican Party'],
	], false),
	devSelectQuestion('governor', 'Governor', 'State (UT)', 0, 1, [
		['priya', 'Priya Nandan', 'Democratic Party'],
		['robert', 'Robert Kessler', 'Republican Party'],
	], true),
	// voteFor 2 — the capped-checkbox CandidateSelector variant.
	devSelectQuestion('state-board-education', 'State Board of Education', 'State (UT)', 1, 2, [
		['angela', 'Angela Torres', 'Nonpartisan'],
		['brian', 'Brian Michaels', 'Nonpartisan'],
		['cynthia', 'Cynthia Park', 'Nonpartisan'],
		['david', 'David Nguyen', 'Nonpartisan'],
	], true),
	devSelectQuestion('state-senate', 'State Senate, District 8', 'State (UT)', 2, 1, [
		['maria', 'Maria Gutierrez', 'Democratic Party'],
		['thomas', 'Thomas Reyes', 'Republican Party'],
	], false),
]

/**
 * D-03: runs the real single-officer, threshold-1 ballot confirmation for `ballotId` — the
 * production `ElectionEngine.submitBallotForConfirmation` followed by
 * `SignatureTasksEngine.completeSignature` with the device signer (software key: no biometric
 * prompt). Idempotent and resumable: a confirmed ballot returns immediately; a ballot already
 * submitted (locked, not yet confirmed) skips the submit and just completes its open task.
 */
export async function confirmDevBallot(
	ctx: EngineContext,
	ref: NetworkReference,
	electionId: string,
	ballotId: string,
	sign: SignCallback,
): Promise<void> {
	const electionEngine = await new ElectionsEngine(ctx).openElection(electionId)
	const state = await electionEngine.getBallotConfirmationState(ballotId)
	if (state.confirmed) return
	if (!state.locked) await electionEngine.submitBallotForConfirmation(ballotId)

	const tasks = new SignatureTasksEngine(ref, ctx)
	const task = (await tasks.getRequestedSignatures(true)).find(
		(t) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId,
	)
	if (!task) throw new Error('confirmDevBallot: no pending ballot task for ' + ballotId)

	const digest = await tasks.getSignatureDigest(task)
	await tasks.completeSignature(task, { isAccepted: true, signature: await sign(digest), sign })
}

/**
 * Proposes the dev election's ballot through the real `ElectionEngine.proposeBallot` if the
 * election has none, then confirms it through the real threshold-1 single-officer ceremony
 * (`confirmDevBallot`, D-03) so the confirmed-only Submit gate is reachable in dev exactly as in
 * release. Idempotent: an existing ballot is never re-proposed, and a confirmed one is left
 * alone — an install seeded before this change confirms its existing ballot on the next dev boot.
 *
 * LONG-LIVED INSTALL NOTE: once a ballot is confirmed, `proposeBallot` refuses to overwrite it, so
 * the `required: false` seed data (D-04) reaches only a fresh DB. An existing dev install keeps its
 * old, all-required content until Start Fresh or `pm clear`.
 */
async function seedDevBallot(
	ctx: EngineContext,
	ref: NetworkReference,
	electionId: string,
	authorityId: string,
	sign: SignCallback,
): Promise<void> {
	const electionEngine = await new ElectionsEngine(ctx).openElection(electionId)
	if ((await electionEngine.getBallots()).length === 0) {
		const ballot: Ballot = {
			id: (globalThis as any).crypto.randomUUID(),
			electionId,
			authorityId,
			description: 'Dev-seeded ballot for local voter testing.',
			districts: [],
			questions: DEV_SEED_BALLOT_QUESTIONS,
		}
		await electionEngine.proposeBallot(ballot)
	}

	// Sequential on purpose: concurrent Quereus cursors deadlock on one handle.
	for (const summary of await electionEngine.getBallots()) {
		await confirmDevBallot(ctx, ref, electionId, summary.id, sign)
	}
}

/** Result handed to the composition root / ConfirmationScreen (D-05/D-07/D-08). */
export interface DevSeedResult {
	/** Reference to the seeded (or re-attached) network — pass to `EngineFactory.getEngine('network', ref)`. */
	networkReference: NetworkReference
	/** The seeded election's id — pass as `RegisterInit.electionId` so `validateFieldPolicy` enforces the seeded policy. */
	electionId: string
	/** The device's resolved identity — the network's founding officer AND the registrant's own identity. */
	deviceUser: User
	/** The SAME device signer used both as the founding-officer key and as `register()`'s `signatureOrCallback`. */
	sign: SignCallback
}

/**
 * Seed (or re-attach to) the local dev network + founding-officer authority +
 * election + per-tier `ElectionRegistrationField` policy. `networksEngine` is
 * caller-supplied so this module stays DB-factory-agnostic — the production
 * composition root passes the `rnDbFactory`-backed instance it already owns
 * (`EngineFactory.getNetworksEngine()`); tests may pass an in-memory-backed one.
 */
export async function seedDevNetwork(
	networksEngine: NetworksEngine,
	options?: { registeredStateFixture?: boolean },
): Promise<DevSeedResult> {
	if (!(globalThis as { __DEV__?: boolean }).__DEV__) {
		throw new Error('seedDevNetwork: must never run outside __DEV__ — this is a dev-only fixture (D-07)')
	}

	const deviceUser = await getOrCreateDeviceUser(DEV_SEED_DISPLAY_NAME)
	const sign = await createDeviceSigner(DEV_SEED_DISPLAY_NAME)
	const wantFixture = options?.registeredStateFixture ?? SEED_REGISTERED_STATE_FIXTURE

	// Idempotency: if the dev-seed network already exists (by its marker name),
	// re-attach instead of re-creating (a second networksEngine.create() would
	// mint a brand-new network id, and a second addElectionRegistrationField
	// for the same policy row would violate its primary key).
	const existingRef = (await networksEngine.getRecentNetworks()).find(
		(ref) => ref.name === DEV_SEED_NETWORK_NAME,
	)

	if (existingRef) {
		const networkEngine = await networksEngine.open(existingRef, deviceUser)
		const details = await networkEngine.getDetails()
		const authorityId = details.network.primaryAuthorityId
		const ctx = networksEngine.getEstablishedContext(existingRef.hash)
		if (!ctx) {
			throw new Error('seedDevNetwork: no established context after re-opening the seeded network')
		}
		const electionRow = await ctx.db
			.prepare('select Id from Election where AuthorityId = :authorityId limit 1')
			.get({ authorityId })
		if (!electionRow) {
			throw new Error('seedDevNetwork: seeded network re-opened but no Election row found — inconsistent dev-seed state')
		}
		const electionId = electionRow.Id as string

		// D-23(f): re-attach path also re-runs the registered-state fixture — it is
		// idempotent (seedRegistrantAssociation re-attaches to the existing rows rather
		// than duplicating them), and a re-opened network must not silently lose the
		// registered state a PRIOR boot already seeded.
		if (wantFixture) await seedRegisteredAssociationFixture(ctx, authorityId, sign)
		await seedDevBallot(ctx, existingRef, electionId, authorityId, sign)

		return { networkReference: existingRef, electionId, deviceUser, sign }
	}

	// ---------- fresh seed ----------

	// (1) Founding-officer network. `admin.officers[0].init.scopes` is `['mel']`
	// ONLY (D-09/D-20) — 'vrg' (Scope.vrg = "Validate registrations",
	// votetorrent.qsql:59) is DELIBERATELY NOT granted here. 'vrg' is the
	// authority's registration-ceremony scope; granting it to the device's own
	// user is exactly what let the voter app run the authority's ceremony
	// (D-01 — see 51-CONTEXT.md / 51-11-SUMMARY.md). 'mel' (Scope.mel = "Manage
	// Elections") stays — the election + per-tier policy-row ceremonies below
	// need it, and D-12's `ElectionRecordValidityPolicy` row is 'mel'-scoped.
	// Officer.InsertValid's first-authority branch needs no invite, no signing
	// for officer #1 — networksEngine.create(networkInit, deviceUser) makes the
	// device user that officer directly (the Officer row's UserId binds to the
	// `user` param, not to anything in OfficerInit — OfficerInit carries no
	// userId field, see votetorrent.qsql:164-210 / networks-engine.ts:84-125).
	//
	// Honesty note (D-09 gate research): `AdminSigning.UserIdValid`
	// (votetorrent.qsql:247-252) only checks that the signer is SOME Officer
	// row at this authority+AdminEffectiveAt — it does not join against
	// `Officer.Scopes` at all, and no engine-side check does either
	// (`registration-engine.ts`'s own doc comment on `rejectRegistrationRequest`
	// says so verbatim: "this method never claims the scope is enforced").
	// Dropping 'vrg' therefore does NOT, by itself, make THIS identity's
	// `register()` calls fail at `UserIdValid` — the device user remains an
	// Officer of this authority regardless of which Scopes it carries. What
	// removing 'vrg' DOES do: it stops this fixture from asserting/documenting
	// a grant that was only ever needed to imitate the authority's own
	// ceremony, and keeps a future reader from treating 'vrg' as an obvious,
	// convenient scope to restore. The real structural backstops against a
	// reintroduced voter-side ceremony are (a) the comment-stripped source gate
	// (`no-vrg-ceremony.gate.test.ts`) that fails on any reintroduced
	// `register(`/`associate(`/`seedSignedMutation`/`issueAttestationChallenge`
	// call under `apps/VoteTorrentVoter/src`, and (b) the fact that a genuine
	// (non-dev-seed) voter identity — one never inserted into `Officer` at all —
	// fails `UserIdValid` for real, which the same gate file also proves.
	const networkInit: NetworkInit = {
		name: DEV_SEED_NETWORK_NAME,
		relays: [],
		primaryAuthority: {
			name: DEV_SEED_AUTHORITY_NAME,
			domainName: 'dev.votetorrent.local',
		},
		admin: {
			officers: [
				{
					init: {
						name: deviceUser.name,
						title: 'Registrar',
						scopes: ['mel'] as Scope[],
					},
				},
			],
			effectiveAt: Date.now(),
			thresholdPolicies: [],
		},
		policies: {
			timestampAuthorities: [],
			numberRequiredTSAs: 0,
			electionType: ElectionType.adhoc,
		},
	}

	await networksEngine.create(networkInit, deviceUser)

	const ref = (await networksEngine.getRecentNetworks()).find((r) => r.name === DEV_SEED_NETWORK_NAME)
	if (!ref) {
		throw new Error('seedDevNetwork: network not found in recentNetworks immediately after create()')
	}

	const ctx = networksEngine.getEstablishedContext(ref.hash)
	if (!ctx) {
		throw new Error('seedDevNetwork: no established context immediately after create()')
	}

	// networksEngine.create() opened the network and cached the ctx — read the
	// primary authority id back via getDetails() rather than re-deriving it.
	const networkEngine = await networksEngine.open(ref, deviceUser)
	const details = await networkEngine.getDetails()
	const authorityId = details.network.primaryAuthorityId

	// (2) Election, signed by the SAME founding-officer device signer via the
	// engine's own election-signing seam (ElectionsEngine.seedElectionSigning /
	// seedElectionRevisionSigning) — the production API the authority app's
	// create-election screen uses; this seed does not hand-roll any Digest/
	// AdminSigning SQL of its own.
	const electionsEngine = new ElectionsEngine(ctx)
	const electionId: string = (globalThis as any).crypto.randomUUID()
	const now = Date.now()
	const electionDate = now + 180 * 86_400_000 // 180 days out — DateValid requires >= context.now
	const electionFields: ElectionCoreInit = {
		id: electionId,
		authorityId,
		title: DEV_SEED_ELECTION_TITLE,
		date: electionDate,
		revisionDeadline: electionDate - 30 * 86_400_000,
		ballotDeadline: electionDate - 7 * 86_400_000,
		type: ElectionType.adhoc,
	}

	// Peek (not consume) the Tid pair BEFORE signing so the revision's tid
	// (T+1) is known — seedElectionSigning below consumes the SAME cached T.
	const tid = await peekNextElectionTid(ctx.db)

	const electionNonce = await electionsEngine.seedElectionSigning(electionFields, sign)

	const revisionInit: ElectionRevisionInit = {
		electionId,
		revision: 0,
		revisionTimestamp: now - 1000,
		tags: [],
		instructions: 'Dev-seeded election for local voter registration testing (Phase 44-06).',
		keyholders: [],
		timeline: {
			// D-13/61-05: votingStarts -> tallyingStarts widened to a 31-day gap so the honest
			// long-remainder countdown case is reachable on hardware (a flat 2-day gap maxed the
			// countdown at 48h, never clipping). registrationEnds/ballotsFinal move ahead of it
			// TOGETHER with votingStarts -- moving votingStarts alone would leave both preparation
			// events later than it, and parseTimeline's PREPARATION rule
			// (packages/ui-web/src/lifecycle/timeline-core.js) raises a blocking OUT_OF_ORDER
			// conflict for any preparation event after votingStarts, which blanks the ENTIRE
			// view-model (INDETERMINATE_CONFLICT_CODES, derive-timeline.ts). All three literals
			// below move together; do not pull votingStarts back without the other two.
			[ElectionEvent.registrationEnds]: electionDate - 52 * 86_400_000,
			[ElectionEvent.ballotsFinal]: electionDate - 40 * 86_400_000,
			[ElectionEvent.votingStarts]: electionDate - 31 * 86_400_000,
			[ElectionEvent.accruingVotes]: electionDate - 20 * 3_600_000,
			[ElectionEvent.hashingVotes]: electionDate - 16 * 3_600_000,
			[ElectionEvent.releasingKeys]: electionDate - 12 * 3_600_000,
			[ElectionEvent.tallyingStarts]: electionDate,
			[ElectionEvent.validation]: electionDate + 86_400_000,
			[ElectionEvent.certificationStarts]: electionDate + 2 * 86_400_000,
			[ElectionEvent.closed]: electionDate + 3 * 86_400_000,
		},
		keyholderThreshold: 1,
	}
	const revisionNonce = await electionsEngine.seedElectionRevisionSigning(
		electionId,
		authorityId,
		revisionInit,
		tid + 1,
		sign,
	)

	await electionsEngine.createElection(
		{ election: electionFields, revision: revisionInit },
		{ signingNonce: electionNonce, revisionSigningNonce: revisionNonce },
	)

	// (3) Per-tier ElectionRegistrationField policy rows (Pattern 4 mapping,
	// 44-RESEARCH.md) — signed with the SAME device signer, now a registered
	// Officer so AdminSigning.UserIdValid passes. At least one row per tier
	// (public/private/selective) so validateFieldPolicy is never a silent
	// no-op (Pitfall 5).
	const registrationEngine = new RegistrationEngine(ctx)
	await registrationEngine.addElectionRegistrationField(
		{ electionId, fieldName: 'firstname', tier: 'public', requirement: 'required' },
		sign,
	)
	await registrationEngine.addElectionRegistrationField(
		{ electionId, fieldName: 'email', tier: 'private', requirement: 'required' },
		sign,
	)
	await registrationEngine.addElectionRegistrationField(
		{ electionId, fieldName: 'party', tier: 'selective', requirement: 'optional' },
		sign,
	)

	// (4) D-23(f): the registered-state dev fixture — see
	// seedRegisteredAssociationFixture's own doc comment for the honesty fence and the
	// sunset obligation. This grants dev-seed.ts NO ceremony token of its own; the
	// forbidden identifiers stay inside the engine-side module reached through
	// loadRegistrantAssociationSeeder().
	if (wantFixture) await seedRegisteredAssociationFixture(ctx, authorityId, sign)

	// (5) The election's ballot (see seedDevBallot).
	await seedDevBallot(ctx, ref, electionId, authorityId, sign)

	return { networkReference: ref, electionId, deviceUser, sign }
}
