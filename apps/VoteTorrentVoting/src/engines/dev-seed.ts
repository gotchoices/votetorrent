/**
 * dev-seed.ts — D-05/D-07/D-08 dev-only network/authority/election/policy fixture
 * (Phase 44-06).
 *
 * DECISIVE RESEARCH FINDING THIS MODULE OPERATIONALIZES (44-RESEARCH.md Pitfall 1):
 * `RegistrationEngine.register()` signs BOTH the row-level `Registrant.Signature`
 * digest AND the `'vrg'`-scoped `AdminSigning` ceremony with the SAME signer — and
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
 * `RegistrationEngine.addElectionRegistrationField`) that owns its own Digest/
 * AdminSigning/AdminSignature ceremony internally. The app layer only ever
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
	type NetworkInit,
	type NetworkReference,
	type Scope,
	type User,
} from '@votetorrent/vote-core'
import {
	ElectionsEngine,
	NetworksEngine,
	RegistrationEngine,
	peekNextElectionTid,
} from '@votetorrent/vote-engine/rn'
import { createDeviceSigner, type SignCallback } from './device-signer'
import { getOrCreateDeviceUser } from './device-user'

/** Display name used for the seeded device identity (voter + founding officer, one identity). */
const DEV_SEED_DISPLAY_NAME = 'Dev Voter'

/** Marker name used to find the previously-seeded network on re-run (idempotency). */
export const DEV_SEED_NETWORK_NAME = 'VoteTorrent Dev Network'

/** Marker name for the seeded primary authority. */
const DEV_SEED_AUTHORITY_NAME = 'Dev Election Authority'

/** Marker title for the seeded election. */
const DEV_SEED_ELECTION_TITLE = 'Dev Voter Registration Election'

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
export async function seedDevNetwork(networksEngine: NetworksEngine): Promise<DevSeedResult> {
	if (!(globalThis as { __DEV__?: boolean }).__DEV__) {
		throw new Error('seedDevNetwork: must never run outside __DEV__ — this is a dev-only fixture (D-07)')
	}

	const deviceUser = await getOrCreateDeviceUser(DEV_SEED_DISPLAY_NAME)
	const sign = await createDeviceSigner(DEV_SEED_DISPLAY_NAME)

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
		return { networkReference: existingRef, electionId, deviceUser, sign }
	}

	// ---------- fresh seed ----------

	// (1) Founding-officer network. `admin.officers[0].init.scopes` includes 'vrg'
	// (Scope.vrg = "Validate registrations", votetorrent.qsql:59 — required by
	// register()'s AdminSigning ceremony) and 'mel' (Scope.mel = "Manage
	// Elections" — required by the election + policy-row ceremonies below).
	// Officer.InsertValid's first-authority branch needs no invite, no signing
	// for officer #1 — networksEngine.create(networkInit, deviceUser) makes the
	// device user that officer directly (the Officer row's UserId binds to the
	// `user` param, not to anything in OfficerInit — OfficerInit carries no
	// userId field, see votetorrent.qsql:164-210 / networks-engine.ts:84-125).
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
						scopes: ['vrg', 'mel'] as Scope[],
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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
			[ElectionEvent.registrationEnds]: electionDate - 25 * 86_400_000,
			[ElectionEvent.ballotsFinal]: electionDate - 14 * 86_400_000,
			[ElectionEvent.votingStarts]: electionDate - 2 * 86_400_000,
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

	return { networkReference: ref, electionId, deviceUser, sign }
}
