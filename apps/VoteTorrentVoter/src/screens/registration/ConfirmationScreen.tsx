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
 *      the key, so "Try Again" — and a press on a fresh mount that resumes the stored attempt —
 *      reuses the attempt's key (read back with `getCurrentDeviceKey`, never re-provisioned); the
 *      cached association request names it. Only a key that is gone or changed starts a new
 *      association request for a newly provisioned key. The key is resolved after the network
 *      details and the stored attempt are read, so a resume never provisions.
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
 * D-32/D-05: both inits (not just their ids) are minted once per attempt and reused
 * byte-identical on every "Try Again" retry — a P2P re-submit of an identical Digest + RequesterKey
 * is idempotent, but a fresh `submittedAt` would change the Digest and be refused forever as
 * 'duplicate-request-id'. The decision wait is bounded by wall clock (64 D-27) and ends on a
 * timeout, a Stop or an unmount; a timeout or a Stop is recovered by "Try Again", which re-submits
 * idempotently and waits again.
 *
 * An attempt outlives its mount (registration-attempt-store.ts): the ids, the association init, the
 * device key and the registration's `submittedAt` — never the payload — are stored before the first
 * submit, and a press on a fresh mount (navigation back and forth, an app restart, a Fast Refresh)
 * resumes them, so a wait that ends before the officer's manual approval never forks the request
 * into a second registrant. The stored attempt ends when the answer is staged (an answer already
 * staged by an earlier press counts), when the authority closes the registration request, or when
 * it belongs to another identity, authority or election; a refused association request is replaced
 * by a new one for the same registrant.
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
 *
 * Phase 67 (CLI-02): steps 1-6 above now run in `runRegistrationCeremony`
 * (`packages/workflows/src/voter/registration-ceremony.ts`), the one shared copy the CLI voter drives
 * too. This screen reads the identity (step 0), resolves the producer, injects the app's attempt store,
 * transports, election read, code mint and commit tracker, and owns the React state, the refs (the
 * attempt memory and the in-flight press), the Stop/unmount wake, the failure classification, the debug
 * line and all presentation.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {createRegistrationCeremonyMemory, runRegistrationCeremony, throwIfCeremonyStopped} from '@votetorrent/workflows/voter';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {getOrCreateDeviceUser} from '../../engines/device-user';
import {createDeviceSigner} from '../../engines/device-signer';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {resolveCurrentElectionId} from '../../engines/election-read';
import {resolveRegistrationStatus} from '../../engines/registration-status';
import {classifyAttestationFailure, type AttestationFailureClass} from '../../engines/attestation-failure';
import {mintRegistrationCodeForSubmit, resolveRegistrationCodeAvailability} from '../../engines/continuity';
import {
	clearRegistrationAttempt,
	readRegistrationAttempt,
	writeRegistrationAttempt,
} from '../../engines/registration-attempt-store';
import {vtDebug} from '../../engines/vt-debug';
import type {RegistrationCodeAvailability} from '../../engines/continuity';
import {resolveVoterRequestTransports} from './attach-voter-request-transport';
import {RegistrationConfirmationCodeCard} from './RegistrationConfirmationCodeCard';
import {globalStyles} from '../../theme/styles';
import {errorClassName} from '../../utils/errorClassName';
import {IdentityRecoveryView} from '../../components/IdentityRecoveryView';
import type {RegistrationStackParamList} from '../../navigation/types';
import {trackCommits, useActionShareState, useCommitShareTracker} from '../../hooks/useCommitShare';

type ConfirmationNavigationProp = NativeStackNavigationProp<RegistrationStackParamList, 'Confirmation'>;

/** 64 D-27: the decision wait's cadence and cap live in the shared ceremony; re-exported for the tests. */
export {DECISION_POLL_INTERVAL_MS, DECISION_WAIT_MAX_MS, pollForNotice} from '@votetorrent/workflows/voter';

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

/** File-local: the failure classes of the attestation ceremony plus the two ends of the wait. */
type ConfirmationFailureClass = AttestationFailureClass | 'wait-stopped';

/** File-local: one Confirm press. Stop and unmount flip its flags; `wake` ends a sleeping wait at once. */
interface CeremonyAttempt {
	cancelled: boolean;
	stopRequested: boolean;
	wake: (() => void) | null;
}

/** A closed code token or a numeric status code, for the debug line; anything else is dropped. */
function errorCodeOf(err: unknown): string | number | undefined {
	const code = (err as {code?: unknown} | null | undefined)?.code;
	if (typeof code === 'number' && Number.isFinite(code)) return code;
	return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(code) ? code : undefined;
}

/** The app key-value attempt store (registration-attempt-store.ts), as the shared ceremony's store seam. */
const attemptStore = {read: readRegistrationAttempt, write: writeRegistrationAttempt, clear: clearRegistrationAttempt};

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

	// WR-02: one registrantId (and one registration-request id, one association-request id, both FULL
	// init objects, the D-45 registration code, the spike-104 device key, the registration's submittedAt
	// and the 64 D-28 election id) per registration attempt: minted once and reused byte-identical on
	// every "Try Again" retry (D-28/D-32: a fresh submittedAt would be refused forever as
	// 'duplicate-request-id'; on Android provisionDeviceKey mints a NEW key every call). The attempt
	// memory is the shared ceremony's, held in one ref; a fresh mount starts empty and the ceremony fills
	// it from the stored attempt when one is pending, so a remount never starts over.
	const ceremonyMemoryRef = useRef(createRegistrationCeremonyMemory());
	const shareState = useActionShareState(ceremonyMemoryRef.current.registrantId ? `registration:${ceremonyMemoryRef.current.registrantId}` : null);
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

	async function onConfirm() {
		if (isSubmitting) {
			return;
		}
		setIsSubmitting(true);
		setFailureClass(null);
		const attempt: CeremonyAttempt = {cancelled: false, stopRequested: false, wake: null};
		attemptRef.current = attempt;
		const isStopped = (): boolean => attempt.cancelled || attempt.stopRequested;
		// Which step of the ceremony was running, for the debug-only failure line below.
		let step = 'identity';
		const throwIfStopped = (): void => {
			throwIfCeremonyStopped(isStopped);
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
			const deviceSign = await createDeviceSigner('Device User');
			throwIfStopped();

			// Steps 1-6 (election, network, transports, resume, device key, the two self-signed submits, the
			// open-ended decision wait, produce, the attestation answer) run ONCE in the shared ceremony; this
			// screen injects every app-side piece. D-11: the producer is resolved once, here, after the identity
			// read; it is synchronous and neither prompts nor provisions. The attempt memory outlives the press
			// (ceremonyMemoryRef), so Try Again reuses the byte-identical inits (D-05/D-32).
			await runRegistrationCeremony({
				getEngine,
				deviceUser,
				deviceSign,
				producer: resolveAttestationProducer(),
				store: attemptStore,
				memory: ceremonyMemoryRef.current,
				draft,
				// WR-03 / 64 D-28: the election is the joined network's current one; the dev seed stands in only
				// for an EMPTY list in a dev build, and that fallback and its gate stay in the app.
				resolveElectionId: () => resolveCurrentElectionId({getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined}),
				// D-28/D-29/D-32: the joined network's own strand, P2P by default or the REST bridge for registration.
				resolveTransports: authorityId => resolveVoterRequestTransports({getEngine, authorityId}),
				// D-45: the registration code, from the SAME identity-key signer that signs the request.
				mintRegistrationCode: (registrantId, sign) => mintRegistrationCodeForSubmit(getEngine, registrantId, sign),
				trackSubmit: (actionKey, fn) => trackCommits(commitTracker, actionKey, fn),
				now: () => decisionWaitClock.now(),
				// Stop or unmount wakes a sleeping wait at once, instead of after the interval.
				sleep: ms =>
					new Promise<void>(resolve => {
						attempt.wake = resolve;
						decisionWaitClock.sleep(ms).then(resolve, resolve);
					}),
				shouldStop: isStopped,
				// 64 D-27 / UI-SPEC A3: the waiting view shows from the decision wait to the decision notice.
				onStep: event => {
					if (event.type === 'step') {
						step = event.step;
						if (event.step === 'decision-wait') {
							setIsWaiting(true);
						}
					} else if (event.milestone === 'decision-received') {
						setIsWaiting(false);
					}
				},
			});

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
			if (err instanceof Error && err.name === 'DecisionWaitStoppedError') {
				console.info('ConfirmationScreen: decision wait: stopped');
				setFailureClass('wait-stopped');
				return;
			}
			console.error('ConfirmationScreen: registration ceremony failed:', errorClassName(err));
			// Off unless the __DEV__ debug switch is on: the step, the class, a code and the cause's
			// class name — never a message, key, id or code value beyond a closed token.
			vtDebug('registration', 'ceremony-failed', {
				step,
				class: errorClassName(err),
				code: errorCodeOf(err),
				cause: errorClassName((err as {cause?: unknown} | null | undefined)?.cause),
			});
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
						electionId: ceremonyMemoryRef.current.electionId ?? undefined,
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
	const confirmStepCurrent = !isPending && !isWaiting;
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
							: failureClass === 'wait-stopped'
								? t('confirmation.error.waitStopped')
								: null; // includes 'identity-lost': IdentityRecoveryView above, never error copy

	return (
		<ScrollView
			style={[styles.screen, {backgroundColor: colors.background}]}
			contentContainerStyle={[globalStyles.container, styles.centerColumn]}>
			{/* The Face ID step's heading, prompt, glyph and caption show only while that step is current: once the
			    confirm succeeds (waiting, pending, registered) they would still tell the voter to confirm. */}
			{confirmStepCurrent ? (
				<>
					<Text
						testID="confirmation-heading"
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
						testID="confirmation-body"
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
					<Text
						testID="confirmation-caption"
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
				</>
			) : null}
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
