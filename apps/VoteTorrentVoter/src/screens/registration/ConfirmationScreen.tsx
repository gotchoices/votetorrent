/**
 * ConfirmationScreen (D-01/D-02/D-03/D-05/D-07/D-08/D-09/D-11/D-12/D-18/D-28/D-29/D-32) — the
 * Face-ID confirmation screen. The "Confirm with Face ID" tap IS the deliberate confirming
 * gesture (D-05), not decorative or an auto-advance. `navigation.popToTop()` clears the whole
 * `DeviceAttestation → RegisterPersonal → RegisterAddressParty → RegisterConfirm → Confirmation`
 * chain in one call (41-RESEARCH.md Pattern 5) — NOT `navigate('RegistrationHome')`, which would
 * leave that entire chain on the back stack.
 *
 * Plan 11 (D-07) / Phase 62 Plan 22 (D-28/D-29/D-32) — the voter never runs the authority's
 * admin-signed ceremony for either the register step or the associate step.
 * `doc/registration.md:10/:105/:119` puts issuing the challenge, verifying the produced attestation,
 * signing and writing on the AUTHORITY's side; the voter's job is to SUBMIT self-signed requests and
 * an answer, never to sign as an officer. The officer signer (`useVoterApp().sign`) is deliberately
 * not even destructured in this file — it must not appear anywhere in this ceremony. Delivery is
 * P2P by default over the Voter's own joined-network strand, or the authority-configured REST
 * bridge for registration only — association is ALWAYS P2P (D-28/D-29, `attach-voter-request-
 * transport.ts`'s `resolveVoterRequestTransports`).
 *
 * The ceremony (order matters — the biometric-last property, D-06/D-15/D-16, is unchanged):
 *   0. Read the voter's own secp256k1 identity (`getOrCreateDeviceUser` + `createDeviceSigner`,
 *      which unwraps eagerly) BEFORE the election and network preconditions, so a permanently lost
 *      identity reaches the recovery view in a release build too (62-REVIEW WR-04). No biometric:
 *      the identity wrap alias is `requireAuth: false`.
 *   1. `provisionDeviceKey()` — resolves the hardware-backed P-256 public key BEFORE any request is
 *      submitted. Does NOT prompt biometric. ONCE per attempt (spike 104): on Android it regenerates
 *      the key, so "Try Again" reuses the attempt's key (read back, never re-provisioned) — the cached
 *      association request names it. Only a key that is gone or changed starts a new association
 *      request for a newly provisioned key.
 *   2. Map the shared draft onto `RegisterInit` tiers (unchanged tier mapping / WR-04).
 *   3. Submit a self-signed registration-request document through the joined network's transports
 *      (`attach-voter-request-transport.ts`), signed under the voter's OWN secp256k1 device
 *      identity (62-08's `createDeviceSigner`, unwrapped in memory — D-42) — never the officer
 *      signer.
 *   4. Submit a self-signed association-request document bound to the P-256 device key, then wait
 *      for the authority's challenge-issued decision notice — a bounded wall-clock wait (64 D-27),
 *      cancelled by Stop or unmount — never calling the authority's challenge-issuing engine method
 *      directly.
 *   5. `producer.produce(challenge)` — the D-11 second step, after the challenge is obtained and before
 *      the attestation answer is submitted. On iOS this is where the biometric prompt fires. On
 *      Android it raises none (spike 104, R1d): a throwaway key answers the nonce and the voting key
 *      is left in place, so the answer below is signed by the SAME key that signed the request.
 *   6. Submit the self-signed attestation-answer document. The submission itself carries no
 *      decision, so the screen shows an honest PENDING state instead of claiming a success it cannot
 *      yet prove. D-100 (UAT 65 gap 5, replacing 51-11's "PENDING, not a further poll"): while
 *      pending, the screen re-reads the authoritative Association status
 *      (`resolveRegistrationStatus`, read-only device key) on focus and every 10 s for at most
 *      10 min, and moves to a completed state only on 'registered'. It pops the stack
 *      (`navigation.popToTop()`) only when the voter presses Done or Back to registration.
 *
 * D-12: the voter proposes NO expiration for a record the authority signs. `RegisterInit` still
 * requires an `expiration` field on `registrant`/`private`/`selective` (the type is unchanged this
 * phase); a clearly-named placeholder is passed and IGNORED — the authority's approval path
 * overrides it with its own policy-derived value before ever creating the Registrant record.
 *
 * D-32/D-05: both inits (not just their ids) are minted once per mounted attempt and reused
 * byte-identical on every "Try Again" retry — a P2P re-submit of an identical Digest + RequesterKey
 * is idempotent, but a fresh `submittedAt` would change the Digest and be refused forever as
 * 'duplicate-request-id'. The decision wait is bounded by wall clock (64 D-27) and ends on a
 * timeout, a Stop or an unmount; a timeout or a Stop is recovered by "Try Again", which re-submits
 * idempotently and waits again.
 *
 * On any thrown step, `classifyAttestationFailure(err)` (D-09) drives the failure UX exactly as
 * before: `'recoverable-action'` renders a setup prompt + retry reusing the same `registrantId`
 * (WR-02); `'recoverable-transient'` renders a generic retry; `'terminal'` (release-only) renders a
 * terminal message with no retry; `'identity-lost'` (WR-02, a permanently unrecoverable identity)
 * renders the identity recovery view with no retry. Classified copy is generic by design — raw
 * reject codes / internal error messages never reach the UI.
 *
 * Plan 28 (D-45) addition: on the P2P route only, step (1) also mints the registration code
 * (`mintRegistrationCodeForSubmit`, the registering device's own identity-key signer — never a raw
 * key) and passes it as `extras.registrationCode` on the registration-request submit. The REST
 * bridge route cannot carry extras at all (62-15's own constraint), so the mint and the 4th
 * argument are both skipped there. Once pending, a re-focus-driven read offers the
 * `RegistrationConfirmationCodeCard` appended below the existing pending content whenever this
 * device both staged the registration over P2P and holds the derived code's matching identity key.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import type {
	AssociationAttestationAnswer,
	AssociationRequestInit,
	AttestationChallenge,
	INetworkEngine,
	PrivateDetail,
	RegisterInit,
	RegistrationRequestInit,
	Signature,
} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {getOrCreateDeviceUser} from '../../engines/device-user';
import {createDeviceSigner} from '../../engines/device-signer';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {resolveCurrentElectionId} from '../../engines/election-read';
import {resolveRegistrationStatus} from '../../engines/registration-status';
import {
	classifyAttestationFailure,
	isDeviceKeyAbsent,
	isDeviceKeyInvalidated,
	type AttestationFailureClass,
} from '../../engines/attestation-failure';
import {mintRegistrationCodeForSubmit, resolveRegistrationCodeAvailability} from '../../engines/continuity';
import type {RegistrationCodeAvailability} from '../../engines/continuity';
import {resolveVoterRequestTransports} from './attach-voter-request-transport';
import {RegistrationConfirmationCodeCard} from './RegistrationConfirmationCodeCard';
import {globalStyles} from '../../theme/styles';
import {errorClassName} from '../../utils/errorClassName';
import {IdentityRecoveryView} from '../../components/IdentityRecoveryView';
import type {RegistrationStackParamList} from '../../navigation/types';
import {trackCommits, useActionShareState, useCommitShareTracker} from '../../hooks/useCommitShare';

type ConfirmationNavigationProp = NativeStackNavigationProp<RegistrationStackParamList, 'Confirmation'>;

/**
 * D-12: `RegisterInit`'s `registrant`/`private`/`selective` tiers still declare an expiration field
 * as required this phase (the type itself is untouched) — but the voter proposes NO validity window
 * for a record the authority signs. This value is a clearly-non-real placeholder, deliberately in
 * the deep past, and is IGNORED: the authority's approval path overrides all three occurrences with
 * its own policy-derived value before ever creating the Registrant record.
 */
const IGNORED_EXPIRATION_PLACEHOLDER = new Date(0).toISOString();

/**
 * 64 D-27: how long the first Confirm press waits for the officer's decision. 180 s, a 2 s poll
 * interval and a 300 s ceiling are the UI-SPEC A3 author's choice (RESEARCH C1). The rehearsal may
 * revise `DECISION_WAIT_DEADLINE_MS` once (64-28), never above `DECISION_WAIT_MAX_MS`.
 */
export const DECISION_WAIT_DEADLINE_MS = 180_000;
export const DECISION_POLL_INTERVAL_MS = 2_000;
export const DECISION_WAIT_MAX_MS = 300_000;

/** D-100: the pending screen's outcome poll — every 10 s, for at most 10 min of wall clock. */
export const OUTCOME_POLL_INTERVAL_MS = 10_000;
export const OUTCOME_POLL_MAX_MS = 600_000;

/**
 * The wait's clock. It is WALL clock (`Date.now`), so a suspended app cannot extend the deadline.
 * A test seam: tests spy on its two methods, so it is read at call time and never destructured.
 */
export const decisionWaitClock: {now(): number; sleep(ms: number): Promise<void>} = {
	now: () => Date.now(),
	sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

/**
 * The wait ended without a decision. Matched by `name` (the duck typing `NoElectionConfiguredError`
 * already uses), which is safe under Babel and Hermes class transforms.
 */
function decisionWaitError(name: 'DecisionWaitTimeoutError' | 'DecisionWaitStoppedError'): Error {
	return Object.assign(
		new Error(name === 'DecisionWaitTimeoutError' ? 'The decision wait reached its deadline.' : 'The decision wait was stopped.'),
		{name},
	);
}

interface DecisionNoticeLike {
	requestId: string;
	status: string;
	cursor: string;
	challengeNonce?: string;
}

/** File-local: the failure classes of the attestation ceremony plus the two ends of the wait. */
type ConfirmationFailureClass = AttestationFailureClass | 'decision-timeout' | 'wait-stopped';

/** File-local: one Confirm press. Stop and unmount flip its flags; `wake` ends a sleeping wait at once. */
interface CeremonyAttempt {
	cancelled: boolean;
	stopRequested: boolean;
	wake: (() => void) | null;
}

/**
 * Waits until a notice for `requestId` reaches one of `terminalStatuses` (64 D-27), forwarding the
 * cursor between reads. The first read is immediate; each later read follows a sleep of at most
 * `DECISION_POLL_INTERVAL_MS`, clamped to the time left. The wait is bounded by wall clock
 * (`options.deadlineMs`, itself capped at `DECISION_WAIT_MAX_MS`; a non-finite or non-positive
 * value falls to the cap) and rejects with `DecisionWaitTimeoutError`, or with
 * `DecisionWaitStoppedError` as soon as `shouldStop()` holds (a notice read after that is
 * discarded). A clock jump past the deadline ends the wait at the next tick with no further read.
 *
 * Every tick is a fresh `pollDecisions` cursor read, never a cached list. A timeout therefore says
 * nothing about whether the requests were written: they were already staged, and Try Again
 * re-submits them idempotently.
 */
export async function pollForNotice<T extends DecisionNoticeLike>(
	poll: (sinceCursor?: string) => Promise<T[]>,
	requestId: string,
	terminalStatuses: ReadonlySet<string>,
	options: {now: () => number; sleep: (ms: number) => Promise<void>; deadlineMs: number; shouldStop: () => boolean},
): Promise<T> {
	const bound =
		Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
			? Math.min(options.deadlineMs, DECISION_WAIT_MAX_MS)
			: DECISION_WAIT_MAX_MS;
	const deadlineAt = options.now() + bound;
	let cursor: string | undefined;
	for (;;) {
		if (options.shouldStop()) {
			throw decisionWaitError('DecisionWaitStoppedError');
		}
		const notices = await poll(cursor);
		if (options.shouldStop()) {
			throw decisionWaitError('DecisionWaitStoppedError');
		}
		for (const notice of notices) {
			cursor = notice.cursor;
			if (notice.requestId === requestId && terminalStatuses.has(notice.status)) {
				return notice;
			}
		}
		const left = deadlineAt - options.now();
		if (left <= 0) {
			throw decisionWaitError('DecisionWaitTimeoutError');
		}
		await options.sleep(Math.min(DECISION_POLL_INTERVAL_MS, left));
		if (options.shouldStop()) {
			throw decisionWaitError('DecisionWaitStoppedError');
		}
		if (options.now() >= deadlineAt) {
			throw decisionWaitError('DecisionWaitTimeoutError');
		}
	}
}

export default function ConfirmationScreen() {
	// WR-02: `createNewIdentity` is the provider's explicit, user-confirmed identity replacement —
	// reached ONLY from the recovery view's confirm step below (never the officer signer).
	const {seededElectionId, getEngine, createNewIdentity} = useVoterApp();
	const {draft, clearDraft} = useRegistrationDraft();
	const navigation = useNavigation<ConfirmationNavigationProp>();
	const {popToTop} = navigation;
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');
	const {t: tContinuity} = useTranslation('continuity');

	const [isSubmitting, setIsSubmitting] = useState(false);
	const [failureClass, setFailureClass] = useState<ConfirmationFailureClass | null>(null);
	const [isPending, setIsPending] = useState(false);
	// 64 D-27 / UI-SPEC A3: true only while the first Confirm waits for the officer's decision.
	const [isWaiting, setIsWaiting] = useState(false);
	// The request this phone submitted is attributed to `registration:<registrantId>`, so the waiting and
	// pending views can say when it has not reached the election network (todo 2026-09-11-optimystic-
	// commit-success-hides-unresolvable-cohort): an office cannot approve a request it never received.
	const commitTracker = useCommitShareTracker();
	// Plan 28 (D-45): the re-showable code card's own availability read — re-resolved on every
	// focus while pending, never cached beyond this render (59 D-23).
	const [codeAvailability, setCodeAvailability] = useState<RegistrationCodeAvailability | null>(null);
	// D-100: the authoritative outcome while pending; 'registered' completes the screen.
	const [registrationOutcome, setRegistrationOutcome] = useState<'pending' | 'registered'>('pending');
	// D-100: true once the bounded outcome poll has run out its 10 min.
	const [outcomePollExpired, setOutcomePollExpired] = useState(false);

	// WR-02: one registrantId (and, per this rewrite, one registration-request id and one
	// association-request id) per registration attempt (this mounted ceremony) — minted once and
	// reused on every "Try Again" retry, exactly as before. A brand-new registration is a fresh
	// mount, so the refs reset naturally without leaking the prior attempt's ids.
	const registrantIdRef = useRef<string | null>(null);
	const shareState = useActionShareState(registrantIdRef.current ? `registration:${registrantIdRef.current}` : null);
	const associationRequestIdRef = useRef<string | null>(null);
	// Phase 62 Plan 22 (D-28/D-32): the FULL init objects (not just their ids) are also minted once
	// and reused byte-identical on every retry. 62-15's P2P transports treat an identical
	// Digest + RequesterKey re-submit as idempotent (D-05) — a fresh `submittedAt` on retry would
	// instead be refused forever as 'duplicate-request-id'.
	const registrationRequestInitRef = useRef<RegistrationRequestInit | null>(null);
	const associationRequestInitRef = useRef<AssociationRequestInit | null>(null);
	// Plan 28 (D-45): minted once per attempt, 'peer' route only — reused byte-identical on retry,
	// same idempotency rationale as the two init refs above.
	const registrationCodeRef = useRef<string | null>(null);
	// Spike 104: the P-256 voting key this attempt's association request names. Provisioned once —
	// on Android `provisionDeviceKey` mints a NEW key every call, which would leave the reused
	// association request above naming a key the phone no longer holds.
	const deviceKeyRef = useRef<string | null>(null);
	// 64 D-28: one election id per mounted attempt. Both inits and the challenge embed it, and Try
	// Again reuses the inits byte-identical, so the id is resolved once and never re-read.
	const electionIdRef = useRef<string | null>(null);
	// 64 D-27: the in-flight press, so Stop and unmount can end its wait.
	const attemptRef = useRef<CeremonyAttempt | null>(null);

	// Unmount ends the attempt: no further read, no biometric prompt, no state set. A no-op on
	// StrictMode's simulated first cleanup, because no attempt exists then.
	useEffect(() => {
		return () => {
			const attempt = attemptRef.current;
			if (attempt) {
				attempt.cancelled = true;
				attempt.wake?.();
			}
		};
	}, []);

	/** The Stop control: ends the wait. It sets no state; the ceremony's catch owns the UI. */
	function onStopWaiting() {
		const attempt = attemptRef.current;
		if (attempt) {
			attempt.stopRequested = true;
			attempt.wake?.();
		}
	}

	/**
	 * Spike 104: this attempt's voting key. A retry reads the key back (read-only) and keeps it when it
	 * is still the one the association request names. Only a key that is absent or permanently
	 * invalidated — or a different key — is replaced, and then the association request is made again
	 * for the new key (the registration request is signed by the identity key and is kept). Any other
	 * lookup failure propagates rather than silently minting a new key.
	 */
	async function resolveAttemptDeviceKey(producer: ReturnType<typeof resolveAttestationProducer>): Promise<string> {
		const attemptKey = deviceKeyRef.current;
		if (attemptKey !== null) {
			let current: string | null;
			try {
				current = (await producer.getCurrentDeviceKey()).publicKey;
			} catch (err) {
				if (!isDeviceKeyAbsent(err) && !isDeviceKeyInvalidated(err)) {
					throw err;
				}
				current = null;
			}
			if (current === attemptKey) {
				return attemptKey;
			}
			associationRequestIdRef.current = null;
			associationRequestInitRef.current = null;
		}
		const {publicKey} = await producer.provisionDeviceKey();
		deviceKeyRef.current = publicKey;
		return publicKey;
	}

	async function onConfirm() {
		if (isSubmitting) {
			return;
		}
		setIsSubmitting(true);
		setFailureClass(null);
		const attempt: CeremonyAttempt = {cancelled: false, stopRequested: false, wake: null};
		attemptRef.current = attempt;
		const isStopped = (): boolean => attempt.cancelled || attempt.stopRequested;
		const throwIfStopped = (): void => {
			if (isStopped()) {
				throw decisionWaitError('DecisionWaitStoppedError');
			}
		};
		try {
			// The voter's OWN device identity (secp256k1, device-user.ts) — self-signs both requests
			// below as ITSELF. This is the SAME underlying keypair `useVoterApp().sign` wraps as the
			// dev-seeded founding officer, but it is deliberately resolved HERE, freshly, rather than
			// destructured from useVoterApp() — the officer signer must not appear anywhere in this
			// ceremony.
			//
			// 62-REVIEW WR-04: read FIRST, before the election and network preconditions. The release
			// build resolves the election through `resolveCurrentElectionId` (64 D-28); only the dev
			// seed's fallback is gated on __DEV__. A later identity read would still leave a permanently
			// lost identity hidden behind NoElectionConfiguredError and the recovery view unreachable. createDeviceSigner unwraps eagerly, so a lost identity
			// throws here. The read prompts nothing: the identity wrap alias is requireAuth:false
			// (device-key-wrap.ts; native unwrap skips BiometricPrompt / LAContext for it), so the
			// biometric-last property below is unchanged.
			const deviceUser = await getOrCreateDeviceUser('Device User');
			throwIfStopped();
			const deviceUserKey = deviceUser.activeKeys[0]!.key;
			const deviceSign = await createDeviceSigner('Device User');
			throwIfStopped();

			// WR-03: the registration request's payload only enforces field policy when
			// init.electionId is set. Fail closed rather than submit with policy unenforced. 64 D-28:
			// the election is the joined network's current one; the dev seed stands in only for an
			// EMPTY list in a dev build, and a rejected read propagates (transient copy, retry).
			let electionId = electionIdRef.current;
			if (electionId === null) {
				const resolved = await resolveCurrentElectionId({getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined});
				throwIfStopped();
				if (!resolved) {
					throw Object.assign(
						new Error('No election configured — cannot register (field policy would be unenforced).'),
						{name: 'NoElectionConfiguredError'},
					);
				}
				electionId = resolved;
				electionIdRef.current = resolved;
			}

			// D-11: resolve the producer once and provision the hardware P-256 key BEFORE any
			// request is submitted — does NOT prompt biometric.
			const producer = resolveAttestationProducer();
			const p256DeviceKey = await resolveAttemptDeviceKey(producer);
			throwIfStopped();

			// The seeded network's authority — resolved from the already-established network
			// context, never hand-rolled.
			const networkEngine = await getEngine<INetworkEngine>('network');
			const details = await networkEngine.getDetails();
			throwIfStopped();
			const authorityId = details.network.primaryAuthorityId;

			// D-28/D-29/D-32: reach the authority through the joined network's own strand — P2P by
			// default, or the authority-configured REST bridge for registration only. Unreachable
			// (no delivery path at all) is a user-visible condition, never a crash.
			const transports = await resolveVoterRequestTransports({getEngine, authorityId});
			throwIfStopped();
			if (!transports) {
				throw new Error('Cannot reach the authority right now — please try again later.');
			}

			// WR-02: mint each id once per attempt and reuse it on retry.
			let registrantId = registrantIdRef.current;
			if (registrantId === null) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				registrantId = (globalThis as any).crypto.randomUUID() as string;
				registrantIdRef.current = registrantId;
			}
			let associationRequestId = associationRequestIdRef.current;
			if (associationRequestId === null) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				associationRequestId = (globalThis as any).crypto.randomUUID() as string;
				associationRequestIdRef.current = associationRequestId;
			}

			// Pattern 4 tier mapping — name -> public, contact/dob/address -> private, party ->
			// selective. WR-04: only furnish details that actually have a value. Furnishing an empty
			// {name, value:''} entry would satisfy the engine's name-presence check for a
			// policy-required private field (e.g. a blank required email), letting a blank required
			// field slip past field-policy enforcement.
			const privateDetails: PrivateDetail[] = [
				{name: 'dob', value: draft.dob},
				{name: 'email', value: draft.email},
				{name: 'phone', value: draft.phone},
				{name: 'addressLine1', value: draft.addressLine1},
				{name: 'addressLine2', value: draft.addressLine2},
				{name: 'addressLine3', value: draft.addressLine3},
			].filter(detail => detail.value !== '');

			const init: RegisterInit = {
				electionId,
				registrant: {id: registrantId, authorityId, expiration: IGNORED_EXPIRATION_PLACEHOLDER},
				public: {firstName: draft.firstName, lastName: draft.lastName},
				private: {expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: privateDetails},
				// D-13: an absent/empty selective payload means no RegistrantSelective row at all —
				// only enter this branch when the voter actually picked a party.
				selective: draft.party
					? {expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: [{name: 'party', value: draft.party}]}
					: undefined,
			};

			// (1) Submit the self-signed registration request document — never a direct write, and
			// never the officer signer. Reuses the registrantId as the request document's own id (no
			// cross-table uniqueness constraint requires otherwise, and it keeps a single id to reuse
			// on retry). D-05/D-32: the whole init (including submittedAt) is minted ONCE and reused
			// byte-identical on every retry, so a P2P re-submit after a timeout is idempotent instead
			// of a permanent 'duplicate-request-id'.
			let registrationRequestInit = registrationRequestInitRef.current;
			if (registrationRequestInit === null) {
				registrationRequestInit = {
					id: registrantId,
					authorityId,
					payload: init,
					submittedAt: new Date().toISOString(),
				};
				registrationRequestInitRef.current = registrationRequestInit;
			}
			// D-45: mint the registration code on the P2P route ONLY — the REST bridge cannot carry
			// `extras` at all (62-15's own constraint), so a registration submitted over it never
			// gets a code (the identity fallback is the only later re-association path for it).
			// Minted once per attempt, from the SAME identity-key signer that signs the request
			// itself — never a raw key.
			if (transports.registrationRoute === 'peer' && registrationCodeRef.current === null) {
				registrationCodeRef.current = await mintRegistrationCodeForSubmit(getEngine, registrantId, deviceSign);
				throwIfStopped();
			}
			if (transports.registrationRoute === 'peer') {
				await trackCommits(commitTracker, `registration:${registrantId}`, () =>
					transports.registrationTransport.submitRequest(registrationRequestInit, deviceUserKey, deviceSign, {
						registrationCode: registrationCodeRef.current as string,
					}),
				);
			} else {
				await trackCommits(commitTracker, `registration:${registrantId}`, () =>
					transports.registrationTransport.submitRequest(registrationRequestInit, deviceUserKey, deviceSign),
				);
			}
			throwIfStopped();

			// (2) Submit the self-signed association-request document, bound to the P-256 device
			// key. The requester key MUST equal the device key (the authority's engine enforces this
			// with a pre-flight guard) — both are p256DeviceKey. Reused byte-identical on retry, same
			// idempotency rationale as the registration init above.
			let associationRequestInit = associationRequestInitRef.current;
			if (associationRequestInit === null) {
				associationRequestInit = {
					id: associationRequestId,
					authorityId,
					registrantId,
					deviceKey: p256DeviceKey,
					electionId,
					submittedAt: new Date().toISOString(),
				};
				associationRequestInitRef.current = associationRequestInit;
			}
			// The association-request self-signature must verify directly against the P-256 device
			// key (the schema checks the signature against that exact public key, not against any
			// registered identity) — `signDeviceKeyDigest` is the producer seam for that.
			const associationSign = async (digest: Uint8Array): Promise<Signature> => {
				if (typeof producer.signDeviceKeyDigest !== 'function') {
					throw new Error('Device attestation signer is not available yet — please try again later.');
				}
				return producer.signDeviceKeyDigest(digest);
			};
			await trackCommits(commitTracker, `registration:${registrantId}`, () =>
				transports.associationTransport.submitRequest(associationRequestInit, p256DeviceKey, associationSign),
			);
			throwIfStopped();

			// (3) Obtain the challenge nonce from a challenge-issued decision notice — never call the
			// authority's challenge-issuing engine method directly. 64 D-27: wait for the officer's
			// decision, bounded by wall clock, cancelled by Stop or unmount (UI-SPEC A3).
			setIsWaiting(true);
			const decisionNotice = await pollForNotice(
				transports.associationTransport.pollDecisions.bind(transports.associationTransport),
				associationRequestId,
				new Set(['c', 'r']),
				{
					now: () => decisionWaitClock.now(),
					// Stop or unmount wakes a sleeping wait at once, instead of after the interval.
					sleep: ms =>
						new Promise<void>(resolve => {
							attempt.wake = resolve;
							decisionWaitClock.sleep(ms).then(resolve, resolve);
						}),
					deadlineMs: DECISION_WAIT_DEADLINE_MS,
					shouldStop: isStopped,
				},
			);
			throwIfStopped();
			setIsWaiting(false);
			if (decisionNotice.status === 'r') {
				throw new Error('The authority rejected the association request.');
			}
			if (!decisionNotice.challengeNonce) {
				throw new Error('The authority issued a challenge notice with no nonce.');
			}

			// (4) The D-11 second producer step answers the challenge — after the challenge is
			// obtained, before the attestation answer is submitted. iOS prompts here; Android does not
			// (spike 104, R1d): its voting key stays under the alias, so the answer below is signed by
			// p256DeviceKey, the key the request named and the authority checks it against.
			const challenge: AttestationChallenge = {
				nonce: decisionNotice.challengeNonce,
				authorityId,
				registrantId,
				deviceKey: p256DeviceKey,
				electionId,
			};
			// On iOS `produce` raises Face ID: it never runs for a stopped or unmounted attempt.
			throwIfStopped();
			const attestation = await producer.produce(challenge);
			throwIfStopped();

			// (5) Submit the self-signed attestation-answer document — never a direct associate
			// write.
			const answer: AssociationAttestationAnswer = {
				requestId: associationRequestId,
				nonce: decisionNotice.challengeNonce,
				attestation,
			};
			await transports.associationTransport.submitAttestation(answer, p256DeviceKey, associationSign);
			throwIfStopped();

			// The authority's automatic driver processes the answer separately, on its own "Sync
			// Now" trigger, so claiming success here would be a lie. Show an honest pending state; the
			// bounded outcome poll below (D-100, replacing 51-11's no-poll decision) completes it once
			// the Association is recorded. The draft is safe to clear now. The screen is NOT popped by
			// itself: only the voter's Done or Back to registration pops.
			clearDraft();
			setIsPending(true);
		} catch (err) {
			if (attempt.cancelled) {
				// Unmounted: nothing is set or logged.
				return;
			}
			// 64 D-27: closed literal tokens only, never an id, nonce or cursor.
			if (err instanceof Error && err.name === 'DecisionWaitTimeoutError') {
				console.info('ConfirmationScreen: decision wait: timed-out');
				setFailureClass('decision-timeout');
				return;
			}
			if (err instanceof Error && err.name === 'DecisionWaitStoppedError') {
				console.info('ConfirmationScreen: decision wait: stopped');
				setFailureClass('wait-stopped');
				return;
			}
			console.error('ConfirmationScreen: registration ceremony failed:', errorClassName(err));
			// D-09/T-45-06-04: classify to a generic UX class — raw reject codes / internal
			// error messages never reach the UI.
			setFailureClass(classifyAttestationFailure(err));
		} finally {
			if (!attempt.cancelled) {
				setIsWaiting(false);
				setIsSubmitting(false);
			}
			if (attemptRef.current === attempt) {
				attemptRef.current = null;
			}
		}
	}

	/**
	 * D-09 recoverable-action remediation: deep-link to Android's biometric enrollment
	 * settings. Falls back to the general security-settings screen if the specific
	 * enrollment intent isn't resolvable on this device/OS version.
	 */
	async function handleSetupDeviceUnlock() {
		try {
			await Linking.sendIntent('android.settings.BIOMETRIC_ENROLL');
		} catch (err) {
			console.error('ConfirmationScreen: BIOMETRIC_ENROLL intent failed, falling back to security settings:', errorClassName(err));
			try {
				await Linking.sendIntent('android.settings.SECURITY_SETTINGS');
			} catch (fallbackErr) {
				console.error('ConfirmationScreen: SECURITY_SETTINGS fallback intent also failed:', errorClassName(fallbackErr));
			}
		}
	}

	// D-100: while pending, read the authoritative registration status on focus and every 10 s for
	// at most 10 min (wall clock). Read-only device key (never provisionDeviceKey, which rotates the
	// Android key). Stops on 'registered', on blur and on unmount.
	useFocusEffect(
		useCallback(() => {
			if (!isPending || registrationOutcome === 'registered') return;
			let cancelled = false;
			const startedAt = Date.now();
			let interval: ReturnType<typeof setInterval> | null = null;
			const stop = () => {
				if (interval !== null) {
					clearInterval(interval);
					interval = null;
				}
			};
			const read = async () => {
				try {
					const result = await resolveRegistrationStatus({
						getEngine,
						getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
						electionId: electionIdRef.current ?? undefined,
					});
					if (cancelled) return;
					if (result.kind === 'registered') {
						stop();
						setRegistrationOutcome('registered');
					}
				} catch {
					// An unreadable status keeps the pending state; the next tick reads again.
				}
			};
			setOutcomePollExpired(false);
			void read();
			interval = setInterval(() => {
				if (Date.now() - startedAt >= OUTCOME_POLL_MAX_MS) {
					stop();
					if (!cancelled) setOutcomePollExpired(true);
					return;
				}
				void read();
			}, OUTCOME_POLL_INTERVAL_MS);
			return () => {
				cancelled = true;
				stop();
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [isPending, registrationOutcome]),
	);

	// Plan 28 (D-45): re-resolved on every focus while pending — never cached beyond this render
	// (59 D-23). Inert before the ceremony reaches the pending state.
	const readCodeAvailability = useCallback(
		() =>
			resolveRegistrationCodeAvailability({
				getEngine,
				getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);
	useFocusEffect(
		useCallback(() => {
			if (!isPending) return;
			let cancelled = false;
			(async () => {
				const result = await readCodeAvailability();
				if (!cancelled) setCodeAvailability(result);
			})();
			return () => {
				cancelled = true;
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [isPending]),
	);

	// gap6/WR-07 (same dead end on this screen): Try Again re-reads fresh (nothing is stored — 59
	// D-23) and is busy-guarded against double taps.
	const codeRetryInFlightRef = useRef(false);
	async function onRetryCodeRead() {
		if (codeRetryInFlightRef.current) return;
		codeRetryInFlightRef.current = true;
		try {
			setCodeAvailability(await readCodeAvailability());
		} finally {
			codeRetryInFlightRef.current = false;
		}
	}

	// The confirm copy names the platform's own biometric: Face ID on iOS, the BIOMETRIC_STRONG
	// prompt (fingerprint / face unlock) on Android. Literal keys per branch keep the i18n parity
	// scan able to resolve each one.
	const isIos = Platform.OS === 'ios';
	const bodyCopy = isIos ? t('confirmation.body') : t('confirmation.body.android');
	const captionCopy = isIos ? t('confirmation.caption') : t('confirmation.caption.android');
	const ctaCopy = isIos ? t('confirmation.cta') : t('confirmation.cta.android');

	// WR-02: a permanently lost identity can never succeed on retry. In release the boot never
	// reads the identity (only the __DEV__ seed does), so registration is where the voter meets
	// it: offer the same recovery view as the boot, in place of the confirm screen. The provider's
	// createNewIdentity re-runs the boot (re-mounting the app tree), so no navigation is needed;
	// the view's Try Again (shown only after a failed create) re-runs this screen's ceremony.
	if (failureClass === 'identity-lost' && !isPending) {
		return (
			<View testID="confirmation-identity-lost" style={[styles.screen, {backgroundColor: colors.background}]}>
				<IdentityRecoveryView onCreateNewIdentity={createNewIdentity} onRetry={onConfirm} />
			</View>
		);
	}

	const errorCopy =
		failureClass === 'recoverable-action'
			? isIos
				? t('confirmation.error.biometricNotEnrolled')
				: t('confirmation.error.biometricNotEnrolled.android')
			: failureClass === 'terminal'
				? t('confirmation.error.terminal')
				: failureClass === 'recoverable-transient'
					? t('confirmation.error.transient')
					: failureClass === 'intake-unavailable'
						? t('confirmation.error.intakeUnavailable')
						: failureClass === 'no-election'
							? t('confirmation.error.noElection')
							: failureClass === 'decision-timeout'
								? t('confirmation.error.decisionTimeout')
								: failureClass === 'wait-stopped'
									? t('confirmation.error.waitStopped')
									: null; // includes 'identity-lost': IdentityRecoveryView above, never error copy

	return (
		<ScrollView
			style={[styles.screen, {backgroundColor: colors.background}]}
			contentContainerStyle={[globalStyles.container, styles.centerColumn]}>
			<Text
				style={[
					styles.heading,
					{
						color: colors.text,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.h2.fontSize,
						lineHeight: typeScale.h2.lineHeight,
					},
				]}>
				{t('confirmation.heading')}
			</Text>
			<Text
				style={[
					styles.body,
					{
						color: colors.textSecondary,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					},
				]}>
				{bodyCopy}
			</Text>
			<View style={styles.iconWrap}>
				<FontAwesome6 name="fingerprint" size={96} color={colors.primary} />
			</View>
			{isWaiting ? null : (
				<Text
					style={[
						styles.caption,
						{
							color: colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.caption.fontSize,
							lineHeight: typeScale.caption.lineHeight,
						},
					]}>
					{captionCopy}
				</Text>
			)}
			{isPending && registrationOutcome === 'registered' ? (
				<>
					<Text
						testID="confirmation-registered"
						style={[
							styles.error,
							{
								color: colors.text,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('confirmation.registered')}
					</Text>
					<Pressable
						testID="confirmation-done"
						accessibilityRole="button"
						onPress={() => popToTop()}
						style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
						<Text style={[styles.ctaLabel, {color: colors.light}]}>{t('confirmation.doneCta')}</Text>
					</Pressable>
				</>
				) : isPending ? (
				<>
					<Text
						testID="confirmation-pending"
						style={[
							styles.error,
							{
								color: colors.text,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('confirmation.pending')}
					</Text>
					{shareState === 'waiting' ? (
						<Text
							testID="confirmation-not-shared"
							accessibilityLiveRegion="polite"
							style={[
								styles.waitingText,
								{
									color: colors.textSecondary,
									fontFamily: fonts.regular.fontFamily,
									fontWeight: fonts.regular.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
								},
							]}>
							{t('confirmation.notShared')}
						</Text>
					) : null}
					{/* UI-SPEC Screen Composition Reference: appended, never replacing the pending
					    content above (D-45). */}
					{codeAvailability?.kind === 'available' ? (
						<RegistrationConfirmationCodeCard state={{kind: 'code', code: codeAvailability.code}} />
					) : codeAvailability?.kind === 'unavailable' && codeAvailability.reason === 'read-failed' ? (
						<>
							<Text
								testID="confirmation-code-unavailable"
								style={[
									styles.body,
									{
										color: colors.textSecondary,
										fontFamily: fonts.regular.fontFamily,
										fontWeight: fonts.regular.fontWeight,
										fontSize: typeScale.body.fontSize,
										lineHeight: typeScale.body.lineHeight,
									},
								]}>
								{tContinuity('code.unavailable')}
							</Text>
							<Pressable
								testID="confirmation-code-retry"
								onPress={onRetryCodeRead}
								style={[styles.retryCta, {borderColor: colors.primary, borderRadius: radii.pill}]}>
								<Text style={[styles.ctaLabel, {color: colors.primary}]}>{tContinuity('code.retryButton')}</Text>
							</Pressable>
						</>
					) : codeAvailability?.kind === 'not-sent' ||
					  codeAvailability?.kind === 'not-holder' ||
					  (codeAvailability?.kind === 'unavailable' && codeAvailability.reason === 'holder-key-missing') ? (
						<Text
							testID="confirmation-code-not-available"
							style={[
								styles.body,
								{
									color: colors.textSecondary,
									fontFamily: fonts.regular.fontFamily,
									fontWeight: fonts.regular.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
								},
							]}>
							{tContinuity('code.notAvailableOnDevice')}
						</Text>
					) : null}
				{outcomePollExpired ? (
					<Text
						testID="confirmation-pending-check-later"
						style={[
							styles.body,
							{
								color: colors.textSecondary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('confirmation.pendingCheckLater')}
					</Text>
				) : null}
				<Pressable
					testID="confirmation-pending-back"
					accessibilityRole="button"
					onPress={() => popToTop()}
					style={[styles.retryCta, {borderColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.ctaLabel, {color: colors.primary}]}>{t('confirmation.pendingBackCta')}</Text>
				</Pressable>
				</>
			) : isWaiting ? (
				<View testID="confirmation-waiting" style={styles.waiting}>
					<ActivityIndicator testID="confirmation-waiting-indicator" size="large" color={colors.primary} accessible={false} />
					<Text
						testID="confirmation-waiting-text"
						accessibilityLiveRegion="polite"
						style={[
							styles.waitingText,
							{
								color: colors.text,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('confirmation.waiting')}
					</Text>
					{shareState === 'waiting' ? (
						<Text
							testID="confirmation-not-shared"
							accessibilityLiveRegion="polite"
							style={[
								styles.waitingText,
								{
									color: colors.textSecondary,
									fontFamily: fonts.regular.fontFamily,
									fontWeight: fonts.regular.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
								},
							]}>
							{t('confirmation.notShared')}
						</Text>
					) : null}
					<Pressable
						testID="confirmation-waiting-cancel"
						accessibilityRole="button"
						onPress={onStopWaiting}
						style={[styles.waitingCancel, {borderColor: colors.primary, borderRadius: radii.pill}]}>
						<Text
							style={{
								color: colors.primary,
								fontFamily: fonts.bold.fontFamily,
								fontWeight: fonts.bold.fontWeight,
								fontSize: typeScale.body.fontSize,
							}}>
							{t('confirmation.waitingCancel')}
						</Text>
					</Pressable>
				</View>
			) : (
				<>
					{errorCopy ? (
						<Text
							testID="confirmation-error"
							style={[
								styles.error,
								{
									color: colors.text,
									fontFamily: fonts.regular.fontFamily,
									fontWeight: fonts.regular.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
								},
							]}>
							{errorCopy}
						</Text>
					) : null}
					{failureClass === 'terminal' || failureClass === 'no-election' || failureClass === 'identity-lost' ? null : failureClass === 'recoverable-action' ? (
						<>
							<Pressable
								testID="confirmation-setup-cta"
								onPress={handleSetupDeviceUnlock}
								style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
								<Text style={[styles.ctaLabel, {color: colors.light}]}>{t('confirmation.error.setupCta')}</Text>
							</Pressable>
							<Pressable
								testID="confirmation-retry-cta"
								onPress={onConfirm}
								disabled={isSubmitting}
								style={[styles.retryCta, {borderColor: colors.primary, borderRadius: radii.pill}]}>
								<Text style={[styles.ctaLabel, {color: colors.primary}]}>{t('confirmation.retryCta')}</Text>
							</Pressable>
						</>
					) : (
						<Pressable
							testID="confirmation-confirm-face-id"
							onPress={onConfirm}
							disabled={isSubmitting}
							style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
							<Text style={[styles.ctaLabel, {color: colors.light}]}>
								{errorCopy ? t('confirmation.retryCta') : ctaCopy}
							</Text>
						</Pressable>
					)}
				</>
			)}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	centerColumn: {
		flexGrow: 1,
		justifyContent: 'center',
		alignItems: 'center',
	},
	heading: {
		textAlign: 'center',
	},
	body: {
		marginTop: 16, // md spacing token
		textAlign: 'center',
	},
	iconWrap: {
		marginTop: 32, // xl spacing token
	},
	caption: {
		marginTop: 8, // sm spacing token
		textAlign: 'center',
	},
	error: {
		marginTop: 16, // md spacing token
		textAlign: 'center',
	},
	cta: {
		marginTop: 32, // xl spacing token
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	retryCta: {
		marginTop: 16, // md spacing token
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		borderWidth: 1,
	},
	waiting: {
		marginTop: 24, // lg spacing token
		alignItems: 'center',
	},
	waitingText: {
		marginTop: 16, // md spacing token
		textAlign: 'center',
	},
	waitingCancel: {
		marginTop: 24, // lg spacing token
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		borderWidth: 1,
	},
	ctaLabel: {
		fontWeight: '600',
	},
});
