/**
 * continuity.ts — Phase 62 Plan 28 (D-40/D-41/D-43/D-45). The Voter-side continuity seam: code
 * availability/minting, the identity-fallback field builder, re-association request submission,
 * the challenge-advance driver, resume-from-replicated-rows, and the old device's own retirement
 * read.
 *
 * D-40 (re-associate, never export): no function in this module reads, holds, logs or exports a
 * private key. Every signature is produced through an injected callback
 * (`createDeviceSigner`/`AttestationProducer.signDeviceKeyDigest`) — never a raw key. The
 * secp256k1 identity key is read ONLY as a public key (`getOrCreateDeviceUser(...).activeKeys[0].key`)
 * for comparison against `getRegistrationCodeHolderKey`.
 *
 * D-45 (code, never persisted): `resolveRegistrationCodeAvailability` re-derives the code fresh on
 * every call (59 D-23) — nothing here is cached. No registrantId, device key or rejection reason
 * ever leaves this module in a `RegistrationCodeAvailability` result; a caught failure logs a fixed
 * string, never the error's own message/code/id (same disclosure posture as
 * `classifyAttestationFailure`/`registration-status.ts`).
 *
 * D-41 (retirement): `resolveDeviceRetired` is a pure read of the replicated `AssociationDecision`
 * table through `IReassociationEngine.getDeviceRetirement` — it has no write path and fails open
 * (`false`) on any read error, matching `registration-status.ts`'s established disclosure/fail-open
 * posture.
 *
 * D-43 (restart): this module has no restart-specific surface — the restart branch
 * (`ContinueOnAnotherDeviceScreen`) is pure navigation (into `DeviceAttestation`, the ordinary
 * first-time flow) and submits nothing, so there is nothing to drive from here.
 *
 * Gate discipline: this module never uses the substrings `register(` or `associate(`
 * (no-vrg-ceremony.gate.test.ts) — every mutating call below goes through
 * `VoterRequestTransports`' `submitRequest`/`submitAttestation`, never a direct engine write. It
 * never imports AsyncStorage.
 */
import type {
	AssociationAttestationAnswer,
	AssociationIdentityField,
	AssociationRequestInit,
	AttestationChallenge,
	IAssociationEngine,
	INetworkEngine,
	IReassociationEngine,
	IRegistrationEngine,
	Signature,
} from '@votetorrent/vote-core';
import {
	normalizeRegistrationCode,
	REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
} from '@votetorrent/vote-core';
import {resolveVoterRequestTransports} from '../screens/registration/attach-voter-request-transport';
import type {
	VoterRequestTransportDeps,
	VoterRequestTransports,
} from '../screens/registration/attach-voter-request-transport';
import {createDeviceSigner} from './device-signer';
import {getDeviceIdentityKeyState, getOrCreateDeviceUser} from './device-user';
import type {DeviceIdentityKeyState} from './device-user';
import type {AttestationProducer} from './attestation-producer';
import {isDeviceKeyAbsent} from './attestation-failure';

export interface ContinuityDeps {
	/** `useVoterApp()`'s own composition-root read. */
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>;
	/** READ-ONLY current P-256 device-key lookup — pass `() => resolveAttestationProducer().getCurrentDeviceKey()`.
	 * Never `provisionDeviceKey`: on Android that mints a NEW key on every call (63-18). */
	getCurrentDeviceKey: () => Promise<{publicKey: string}>;
	/** Defaults to `resolveVoterRequestTransports` — injected so every branch is testable without
	 * the real P2P/strand transport source (D-28/D-32). */
	resolveTransports?: (deps: VoterRequestTransportDeps) => Promise<VoterRequestTransports | undefined>;
}

/** D-45. `code` is always the normalized 10-char code — never a registrantId, key or reason. */
export type RegistrationCodeAvailability =
	| {kind: 'available'; code: string}
	| {kind: 'not-registered'}
	| {kind: 'not-holder'}
	| {kind: 'not-sent'}
	| {kind: 'unavailable'; reason: 'holder-key-missing' | 'read-failed'; registrantKnown: boolean};
// 'holder-key-missing' is the permanent "not available on this device" (it implies registrantKnown).
// 'read-failed' is a retryable read failure (network not ready, read error, signer/biometric cancel);
// registrantKnown tells the caller whether the device's registration was resolved before the failure
// (false: a never-registered voter must still be offered "continue on another device"). No id, key or
// error text ever rides on the result.

/**
 * Re-showable (D-45, Claude's discretion): reads fresh every call, never cached. Four conditions,
 * all engine reads — see this plan's `<decisions_and_discretion>` for the full rationale:
 *   1. This device's P-256 key has an `Association` whose registrant is active ('a') for the
 *      network's primary authority.
 *   2. `getRegistrationCodeHolderKey(registrantId)` equals this device's secp256k1 identity key.
 *   3. This device staged that registration over P2P (`ownStagedRegistrationRequestIds` contains
 *      the registration request id, which equals the registrantId).
 *   4. `deriveRegistrationCode` succeeds.
 * Never throws — every failure (including an engine read rejecting) resolves `'unavailable'` with a reason. Two
 * fixed-string warns tell the cases apart: 'continuity: registration code holder key not found'
 * (silent-looking holder-key miss) and 'continuity: code availability read failed' (a read threw).
 */
export async function resolveRegistrationCodeAvailability(
	deps: ContinuityDeps,
): Promise<RegistrationCodeAvailability> {
	let registrantKnown = false;
	try {
		let p256DeviceKey: string;
		try {
			({publicKey: p256DeviceKey} = await deps.getCurrentDeviceKey());
		} catch (err) {
			// No device key yet (fresh install) means nothing was ever registered — never create one here.
			if (isDeviceKeyAbsent(err)) return {kind: 'not-registered'};
			throw err;
		}

		const network = await deps.getEngine<INetworkEngine>('network');
		const details = await network.getDetails();
		const authorityId = details.network.primaryAuthorityId;

		const association = await deps.getEngine<IAssociationEngine & IReassociationEngine>('association');
		const rows = await association.getAssociationsByDeviceKey(p256DeviceKey);

		const registration = await deps.getEngine<IRegistrationEngine>('registration');
		let registrantId: string | undefined;
		for (const row of rows) {
			const registrant = await registration.getRegistrant(row.registrantId);
			// Allow-list status === 'a' — never `!== 'r'` (a suspended registrant must not read as
			// holding an available code).
			if (registrant !== undefined && registrant.authorityId === authorityId && registrant.status === 'a') {
				registrantId = row.registrantId;
				break;
			}
		}
		if (registrantId === undefined) {
			return {kind: 'not-registered'};
		}
		registrantKnown = true;

		// Only now: the identity key, the holder-key comparison and the own-staging/derive reads —
		// none of these run for a device that was never registered.
		const identityUser = await getOrCreateDeviceUser('Device User');
		const identityKey = identityUser.activeKeys[0]!.key;

		const holderKey = await association.getRegistrationCodeHolderKey(registrantId);
		if (holderKey === undefined) {
			// Fixed string only (T-62-28-01 / T-62-51-01): no registrant id, key or error text.
			console.warn('continuity: registration code holder key not found');
			return {kind: 'unavailable', reason: 'holder-key-missing', registrantKnown: true};
		}
		if (holderKey !== identityKey) {
			return {kind: 'not-holder'};
		}

		const resolveTransports = deps.resolveTransports ?? resolveVoterRequestTransports;
		const transports = await resolveTransports({getEngine: deps.getEngine, authorityId});
		if (!transports) {
			return {kind: 'not-sent'};
		}
		const ownIds = await transports.ownStagedRegistrationRequestIds(identityKey);
		if (!ownIds.includes(registrantId)) {
			return {kind: 'not-sent'};
		}

		const sign = await createDeviceSigner('Device User');
		const code = await association.deriveRegistrationCode(registrantId, sign);
		return {kind: 'available', code};
	} catch {
		// Fixed string only — never the error's own message/code/id (T-62-28-01 disclosure posture).
		console.warn('continuity: code availability read failed');
		return {kind: 'unavailable', reason: 'read-failed', registrantKnown};
	}
}

/**
 * The registering device, at ORIGINAL registration time: mint the code to pass as
 * `extras.registrationCode` on the P2P route. No catch — a rejection propagates (the ceremony
 * treats it as a failed attempt, same as any other ceremony step).
 */
export async function mintRegistrationCodeForSubmit(
	getEngine: ContinuityDeps['getEngine'],
	registrantId: string,
	sign: (digest: Uint8Array) => Promise<Signature>,
): Promise<string> {
	const association = await getEngine<IReassociationEngine>('association');
	return association.deriveRegistrationCode(registrantId, sign);
}

export interface IdentityFallbackInput {
	firstName: string;
	lastName: string;
	dob: string;
	email: string;
	phone: string;
	addressLine1: string;
	addressLine2: string;
	addressLine3: string;
}

/** Catalog order — the exact field-name set 62-18's `identityRecordOf` flattens from a
 * registration payload. */
const IDENTITY_FALLBACK_FIELD_ORDER: ReadonlyArray<keyof IdentityFallbackInput> = [
	'firstName',
	'lastName',
	'dob',
	'email',
	'phone',
	'addressLine1',
	'addressLine2',
	'addressLine3',
];

/** Trims, drops empty values, keeps catalog order — never persisted, never logged (T-62-28-03). */
export function buildIdentityFallbackFields(input: IdentityFallbackInput): AssociationIdentityField[] {
	const out: AssociationIdentityField[] = [];
	for (const name of IDENTITY_FALLBACK_FIELD_ORDER) {
		const value = input[name].trim();
		if (value !== '') {
			out.push({name, value});
		}
	}
	return out;
}

export type ReassociationEvidenceInput =
	| {kind: 'code'; code: string}
	| {kind: 'identity'; fields: readonly AssociationIdentityField[]};

/** Exactly one of `registrationCode` / `identityFields` is ever produced — never both, never
 * neither (D-45). */
export function reassociationExtrasFor(
	evidence: ReassociationEvidenceInput,
): {registrationCode: string} | {identityFields: readonly AssociationIdentityField[]} {
	if (evidence.kind === 'code') {
		const normalized = normalizeRegistrationCode(evidence.code);
		if (normalized === undefined) {
			throw new TypeError('reassociationExtrasFor: not a valid registration code');
		}
		return {registrationCode: normalized};
	}
	if (evidence.fields.length === 0) {
		throw new TypeError('reassociationExtrasFor: identity evidence requires at least one field');
	}
	return {identityFields: evidence.fields};
}

/** `registrantId` is ALWAYS the sentinel (D-40/T-62-28-04) — the new device never names a
 * registrant; the authority resolves it from the sealed evidence. */
export function buildReassociationRequestInit(params: {
	id: string;
	authorityId: string;
	deviceKey: string;
	electionId?: string;
	submittedAt: string;
}): AssociationRequestInit {
	const init: AssociationRequestInit = {
		id: params.id,
		authorityId: params.authorityId,
		registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
		deviceKey: params.deviceKey,
		submittedAt: params.submittedAt,
	};
	if (params.electionId !== undefined) {
		init.electionId = params.electionId;
	}
	return init;
}

export interface ReassociationCeremonyDeps {
	transports: VoterRequestTransports;
	producer: AttestationProducer;
	authorityId: string;
	electionId?: string;
	deviceKey: string;
}

/** D-40: the device's own P-256 key signs this request, through `producer.signDeviceKeyDigest`
 * ONLY — never a raw key. Never calls `.submitRequest` when the producer cannot sign (checked
 * BEFORE any transport call, so a missing signer never stages a request nothing can ever answer). */
export async function submitReassociationRequest(
	deps: ReassociationCeremonyDeps,
	init: AssociationRequestInit,
	evidence: ReassociationEvidenceInput,
): Promise<string> {
	const extras = reassociationExtrasFor(evidence);
	const sign = deps.producer.signDeviceKeyDigest;
	if (typeof sign !== 'function') {
		throw new Error('Device attestation signer is not available yet — please try again later.');
	}
	const signCb = (digest: Uint8Array): Promise<Signature> => sign(digest);
	return deps.transports.associationTransport.submitRequest(init, deps.deviceKey, signCb, extras);
}

/** The bounded number of decision-poll rounds `advanceReassociation` will run before giving up —
 * timer-free, mirrors `ConfirmationScreen.tsx`'s `MAX_POLL_ATTEMPTS`. */
export const REASSOCIATION_MAX_POLL_ROUNDS = 20;

export type ReassociationProgress =
	| {kind: 'pending'; answered: boolean}
	| {kind: 'approved'}
	| {kind: 'rejected'};

/**
 * Up to `REASSOCIATION_MAX_POLL_ROUNDS` rounds of `pollDecisions`, forwarding the cursor between
 * calls. A `'c'` notice (with a nonce, not yet answered) drives `producer.produce` then
 * `submitAttestation` — a `'duplicate-request-id'` rejection from `submitAttestation` is treated
 * as already-answered, not an error. Timer-free; an empty round, or a round whose resume cursor did
 * not move (above-ceiling decisions are re-delivered with an unchanged cursor), ends the run as
 * pending and the next call resumes. Cursors are compared for equality only.
 */
export async function advanceReassociation(
	deps: ReassociationCeremonyDeps,
	requestId: string,
	answered: boolean,
): Promise<ReassociationProgress> {
	let cursor: string | undefined;
	let isAnswered = answered;
	// A rejection is remembered while later pages are read looking for an approval.
	let sawRejection = false;

	for (let round = 0; round < REASSOCIATION_MAX_POLL_ROUNDS; round++) {
		const forwarded = cursor;
		const notices = (await deps.transports.associationTransport.pollDecisions(cursor)) ?? [];
		if (notices.length === 0) {
			return sawRejection ? {kind: 'rejected'} : {kind: 'pending', answered: isAnswered};
		}

		let latest: (typeof notices)[number] | undefined;
		for (const notice of notices) {
			cursor = notice.cursor;
			if (notice.requestId === requestId) {
				// Approval wins over everything else on the page: two officers can decide one request on
				// two devices before syncing, and the approval is the decision that retires the old device
				// key, so reporting 'rejected' would strand the voter. The schema CHECK that forbids the
				// pair is deferred with the other re-attach-sensitive amendments (gap G5 WR-04).
				if (notice.status === 'a') {
					return {kind: 'approved'};
				}
				if (notice.status === 'r') {
					sawRejection = true;
				} else {
					latest = notice;
				}
			}
		}
		if (!latest) {
			if (cursor === forwarded) {
				return sawRejection ? {kind: 'rejected'} : {kind: 'pending', answered: isAnswered};
			}
			continue;
		}

		// Once this request has been rejected, never answer its challenge: answering would prompt for a
		// biometric and publish a signed attestation for a request that is already decided. An approval
		// still wins because it returns above, before this point.
		if (latest.status === 'c' && latest.challengeNonce && !isAnswered && !sawRejection) {
			const challenge: AttestationChallenge = {
				nonce: latest.challengeNonce,
				authorityId: deps.authorityId,
				// The sentinel registrant — the real producer binds only (nonce, deviceKey), so this
				// never needs to be the real registrantId (D-40/T-62-28-04).
				registrantId: REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
				deviceKey: deps.deviceKey,
				electionId: deps.electionId,
			};
			const attestation = await deps.producer.produce(challenge);

			const sign = deps.producer.signDeviceKeyDigest;
			if (typeof sign !== 'function') {
				throw new Error('Device attestation signer is not available yet — please try again later.');
			}
			const signCb = (digest: Uint8Array): Promise<Signature> => sign(digest);
			const answer: AssociationAttestationAnswer = {
				requestId,
				nonce: latest.challengeNonce,
				attestation,
			};
			try {
				await deps.transports.associationTransport.submitAttestation(answer, deps.deviceKey, signCb);
				isAnswered = true;
			} catch (err) {
				if ((err as {code?: string} | null | undefined)?.code === 'duplicate-request-id') {
					isAnswered = true;
				} else {
					throw err;
				}
			}
		}
		// A 'c' notice already answered, or any other status, just keeps polling — unless the resume
		// cursor did not move, in which case another round would re-read the same rows.
		if (cursor === forwarded) {
			return sawRejection ? {kind: 'rejected'} : {kind: 'pending', answered: isAnswered};
		}
	}

	return sawRejection ? {kind: 'rejected'} : {kind: 'pending', answered: isAnswered};
}

export type ReassociationResume =
	| {kind: 'fresh'}
	| {kind: 'pending'; requestId: string; challengeNonce?: string}
	| {kind: 'approved'};

/**
 * Resumes from the replicated `AssociationRequest` row (own P-256 key + sentinel registrant,
 * newest by `submittedAt`) — never from persisted state (an app kill loses nothing resumable).
 * Catches to `'fresh'` on any read failure.
 */
export async function resolveReassociationResume(deps: ContinuityDeps): Promise<ReassociationResume> {
	try {
		const {publicKey: p256DeviceKey} = await deps.getCurrentDeviceKey();

		const network = await deps.getEngine<INetworkEngine>('network');
		const details = await network.getDetails();
		const authorityId = details.network.primaryAuthorityId;

		const association = await deps.getEngine<IAssociationEngine>('association');
		const requests = await association.listAssociationRequests(authorityId);
		const mine = requests
			.filter(r => r.deviceKey === p256DeviceKey && r.registrantId === REASSOCIATION_UNRESOLVED_REGISTRANT_ID)
			.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0));

		const newest = mine[0];
		if (!newest) {
			return {kind: 'fresh'};
		}
		if (newest.status === 'p' || newest.status === 'c') {
			return {kind: 'pending', requestId: newest.requestId, challengeNonce: newest.challengeNonce};
		}
		if (newest.status === 'a') {
			return {kind: 'approved'};
		}
		return {kind: 'fresh'};
	} catch {
		return {kind: 'fresh'};
	}
}

/**
 * D-41: the old device's own read of whether it has been retired by a completed re-association.
 * Fail-open (`false`) on any read error — the actual security property is enforced by the deleted
 * `Association` row, not by this notice (T-62-28-07). Never calls `getCurrentDeviceKey`/`getEngine`
 * when the identity key state is `'absent'` (a never-registered phone does no hardware-key
 * provisioning at app open).
 */
export async function resolveDeviceRetired(
	deps: Pick<ContinuityDeps, 'getEngine' | 'getCurrentDeviceKey'> & {
		identityKeyState?: () => Promise<DeviceIdentityKeyState>;
	},
): Promise<boolean> {
	try {
		const stateFn = deps.identityKeyState ?? getDeviceIdentityKeyState;
		const state = await stateFn();
		if (state === 'absent') {
			return false;
		}

		const {publicKey: p256DeviceKey} = await deps.getCurrentDeviceKey();
		const association = await deps.getEngine<IReassociationEngine>('association');
		// No `source` argument — the established ctx's own replicated `AssociationDecision` table is
		// the read, per 62-18.
		const record = await association.getDeviceRetirement(p256DeviceKey);
		return record !== undefined;
	} catch {
		return false;
	}
}
