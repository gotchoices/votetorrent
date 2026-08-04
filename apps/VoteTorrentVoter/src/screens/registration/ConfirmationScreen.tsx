/**
 * ConfirmationScreen (REG-04/D-03/D-05/D-07/D-09/D-11) — the Face-ID confirmation screen. The
 * "Confirm with Face ID" tap IS the deliberate confirming gesture (D-05), not decorative or an
 * auto-advance. `navigation.popToTop()` clears the whole `DeviceAttestation → RegisterPersonal →
 * RegisterAddressParty → RegisterConfirm → Confirmation` chain in one call (41-RESEARCH.md
 * Pattern 5) — NOT `navigate('RegistrationHome')`, which would leave that entire chain on the
 * back stack.
 *
 * Phase 45-06 (this plan) — the CONFIRMING TAP drives the REAL signed registration + association
 * ceremony bound to the hardware **P-256** device key (D-03), with the D-11 two-step producer
 * seam driven in the correct order and the D-09 three-way failure UX wired:
 *
 * The ceremony (order matters, D-11):
 *   1. `provisionDeviceKey()` — resolves the hardware-backed P-256 public key BEFORE `register()`.
 *      Idempotent against the same stable key alias `DeviceAttestationScreen`'s pre-register
 *      capability probe already used, so this does NOT prompt biometric and does NOT create a
 *      second hardware key.
 *   2. Map the shared draft (`useRegistrationDraft().draft`) onto `RegisterInit` tiers —
 *      firstName/lastName -> public, dob/email/phone/address -> private `PrivateDetail[]`,
 *      party -> selective (D-13, only when non-empty) — with `electionId` set to the D-07 seeded
 *      election id (`useVoterApp().seededElectionId`) so `validateFieldPolicy` fires (D-08/D-09).
 *   3. `RegistrationEngine.register(init, sign)` with the device signer (`useVoterApp().sign` —
 *      the SAME founding-officer/device identity 44-06 seeded, never the CadreNode peer key).
 *      The secp256k1 identity key (`getOrCreateDeviceUser`) stays the registration SIGNING key
 *      via `sign` — it is never the attested DeviceKey (D-03).
 *   4. `AssociationEngine.issueAttestationChallenge(registrantId, p256DeviceKey, expiration, sign,
 *      seededElectionId)` — the P-256 key from step 1, `seededElectionId` threaded as the
 *      trailing arg (45-04's D-14a signature).
 *   5. `producer.produce(challenge)` — the D-11 second step; this is where BiometricPrompt fires
 *      ("Confirm with Face ID", D-06/D-15/D-16 biometric-last).
 *   6. `AssociationEngine.buildAssociate()...setDeviceKey(p256DeviceKey)...commit()`.
 *
 * On full success: `useRegistrationDraft().clearDraft()` (T-42-01c submit-path wipe) then
 * `navigation.popToTop()`. On ANY thrown step, `classifyAttestationFailure(err)` (D-09) drives
 * the failure UX: `'recoverable-action'` (e.g. biometrics not enrolled) renders a setup prompt
 * that deep-links to system enrollment plus a "Try Again" retry reusing the same `registrantId`
 * (WR-02); `'recoverable-transient'` renders a generic "Try again" retry; `'terminal'`
 * (release-only — never reachable under `__DEV__`, see `attestation-failure.ts`) renders a
 * terminal message with NO retry CTA. Classified copy is generic by design (T-45-06-04) — raw
 * reject codes / internal error messages never reach the UI.
 */
import React, {useRef, useState} from 'react';
import {Linking, Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import type {
	DeviceAttestation,
	IAssociationEngine,
	INetworkEngine,
	IRegistrationEngine,
	PrivateDetail,
	RegisterInit,
	Signature,
} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {getOrCreateDeviceUser} from '../../engines/device-user';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {classifyAttestationFailure, type AttestationFailureClass} from '../../engines/attestation-failure';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type ConfirmationNavigationProp = NativeStackNavigationProp<RegistrationStackParamList, 'Confirmation'>;

/** Ten years in milliseconds — mirrors device-user.ts's own key-expiration convention (dev posture). */
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * `AssociationAssociateBuilder`'s fluent setter chain (setRegistrantId/setDeviceKey/setNonce/
 * setAttestation/setSignatureOrCallback) is deliberately additive convenience on the CONCRETE
 * class, NOT part of `IAssociationAssociateBuilder` (see association-associate-builder.ts's
 * header comment) — `IAssociationEngine.buildAssociate()` is typed to return the bare interface.
 * This local shape widens that return value just enough to drive the exact chain
 * `association.spec.ts`'s own builder tests use against the concrete class directly.
 */
interface AssociateBuilderChain {
	setRegistrantId(registrantId: string): AssociateBuilderChain;
	setDeviceKey(deviceKey: string): AssociateBuilderChain;
	setNonce(nonce: string): AssociateBuilderChain;
	setAttestation(attestation: DeviceAttestation): AssociateBuilderChain;
	setSignatureOrCallback(signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>)): AssociateBuilderChain;
	commit(): Promise<void>;
}

export default function ConfirmationScreen() {
	const {seededElectionId, sign, getEngine} = useVoterApp();
	const {draft, clearDraft} = useRegistrationDraft();
	const navigation = useNavigation<ConfirmationNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	const [isSubmitting, setIsSubmitting] = useState(false);
	const [failureClass, setFailureClass] = useState<AttestationFailureClass | null>(null);

	// WR-02: one registrantId per registration attempt (this mounted ceremony), minted
	// once and reused on every "Try Again" retry. A fresh id on each retry would re-run
	// register() with a new id after a mid-ceremony failure — orphaning the already-
	// committed Registrant row and duplicating rows on repeated retries. A brand-new
	// registration is a fresh mount (popToTop unmounts this screen), so the ref resets
	// naturally without leaking the prior attempt's id.
	const registrantIdRef = useRef<string | null>(null);

	async function onConfirm() {
		if (isSubmitting) {
			return;
		}
		setIsSubmitting(true);
		setFailureClass(null);
		try {
			if (!sign) {
				throw new Error('Device signer is not ready yet — please wait for setup to finish and try again.');
			}

			// WR-03: register() only enforces field policy when init.electionId is set
			// (validateFieldPolicy is skipped otherwise). Fail closed rather than submit a
			// registration with field-policy enforcement silently disabled.
			if (!seededElectionId) {
				throw new Error('No election configured — cannot register (field policy would be unenforced).');
			}

			// D-11: resolve the producer once and provision the hardware P-256 key BEFORE
			// register() — idempotent against the same stable key alias
			// DeviceAttestationScreen's pre-register capability probe already used, so this
			// does NOT prompt biometric (biometric fires later, inside produce()) and does
			// NOT create a second hardware key.
			const producer = resolveAttestationProducer();
			const {publicKey: p256DeviceKey} = await producer.provisionDeviceKey();

			// The seeded network's founding-officer authority (dev-seed.ts, 44-06) — resolved from
			// the already-established network context, never hand-rolled.
			const networkEngine = await getEngine<INetworkEngine>('network');
			const details = await networkEngine.getDetails();
			const authorityId = details.network.primaryAuthorityId;

			// The SAME device identity used as the signer (device-user.ts). Its secp256k1 key
			// remains the registration SIGNING key (via `sign`) — it is NEVER the attested
			// DeviceKey; `p256DeviceKey` (provisioned above) is the attested device key (D-03).
			await getOrCreateDeviceUser('Device User');

			// WR-02: mint the registrantId once per attempt and reuse it on retry.
			let registrantId = registrantIdRef.current;
			if (registrantId === null) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				registrantId = (globalThis as any).crypto.randomUUID() as string;
				registrantIdRef.current = registrantId;
			}
			const expiration = Date.now() + TEN_YEARS_MS;
			const challengeExpiration = new Date(expiration).toISOString();

			// Pattern 4 tier mapping — name -> public, contact/dob/address -> private, party -> selective.
			// WR-04: only furnish details that actually have a value. Furnishing an empty
			// {name, value:''} entry would satisfy the engine's name-presence check for a
			// policy-Required private field (e.g. a blank required email), letting a blank
			// required field slip past field-policy enforcement. Dropping empties means a
			// blank required field is genuinely absent, so validateFieldPolicy rejects it.
			const privateDetails: PrivateDetail[] = [
				{name: 'dob', value: draft.dob},
				{name: 'email', value: draft.email},
				{name: 'phone', value: draft.phone},
				{name: 'addressLine1', value: draft.addressLine1},
				{name: 'addressLine2', value: draft.addressLine2},
				{name: 'addressLine3', value: draft.addressLine3},
			].filter(detail => detail.value !== '');

			const init: RegisterInit = {
				electionId: seededElectionId,
				registrant: {id: registrantId, authorityId, expiration},
				public: {firstName: draft.firstName, lastName: draft.lastName},
				private: {expiration, details: privateDetails},
				// D-13: an absent/empty selective payload means no RegistrantSelective row at all —
				// only enter this branch when the voter actually picked a party.
				selective: draft.party
					? {expiration, details: [{name: 'party', value: draft.party}]}
					: undefined,
			};

			// (1) Step 1 — real, signed registration against the real engine.
			const registrationEngine = await getEngine<IRegistrationEngine>('registration');
			await registrationEngine.register(init, sign);

			// (2) Step 2 — the election-terms-bound challenge, keyed to the P-256 device key
			// (D-03) with the seeded electionId threaded as the trailing arg (D-11 / 45-04).
			const associationEngine = await getEngine<IAssociationEngine>('association');
			const challenge = await associationEngine.issueAttestationChallenge(
				registrantId,
				p256DeviceKey,
				challengeExpiration,
				sign,
				seededElectionId,
			);

			// (3) Step 3 — the D-11 second producer step answers the challenge; this is the
			// "Confirm with Face ID" biometric step (D-06/D-15/D-16 biometric-last).
			const attestation = await producer.produce(challenge);

			// (4) Step 4 — the real associate ceremony, binding the P-256 device key (D-03).
			await (associationEngine.buildAssociate() as unknown as AssociateBuilderChain)
				.setRegistrantId(registrantId)
				.setDeviceKey(p256DeviceKey)
				.setNonce(challenge.nonce)
				.setAttestation(attestation)
				.setSignatureOrCallback(sign)
				.commit();

			// Only on full success: wipe the draft (T-42-01c) and pop the whole registration chain.
			clearDraft();
			navigation.popToTop();
		} catch (err) {
			console.error('ConfirmationScreen: registration ceremony failed:', err);
			// D-09/T-45-06-04: classify to a generic UX class — raw reject codes / internal
			// error messages never reach the UI.
			setFailureClass(classifyAttestationFailure(err));
		} finally {
			setIsSubmitting(false);
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
			console.error('ConfirmationScreen: BIOMETRIC_ENROLL intent failed, falling back to security settings:', err);
			try {
				await Linking.sendIntent('android.settings.SECURITY_SETTINGS');
			} catch (fallbackErr) {
				console.error('ConfirmationScreen: SECURITY_SETTINGS fallback intent also failed:', fallbackErr);
			}
		}
	}

	const errorCopy =
		failureClass === 'recoverable-action'
			? t('confirmation.error.biometricNotEnrolled')
			: failureClass === 'terminal'
				? t('confirmation.error.terminal')
				: failureClass === 'recoverable-transient'
					? t('confirmation.error.transient')
					: null;

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
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
					{t('confirmation.body')}
				</Text>
				<View style={styles.iconWrap}>
					<FontAwesome6 name="fingerprint" size={96} color={colors.primary} />
				</View>
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
					{t('confirmation.caption')}
				</Text>
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
				{failureClass === 'terminal' ? null : failureClass === 'recoverable-action' ? (
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
							<Text style={[styles.ctaLabel, {color: colors.primary}]}>Try Again</Text>
						</Pressable>
					</>
				) : (
					<Pressable
						testID="confirmation-confirm-face-id"
						onPress={onConfirm}
						disabled={isSubmitting}
						style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
						<Text style={[styles.ctaLabel, {color: colors.light}]}>
							{errorCopy ? 'Try Again' : t('confirmation.cta')}
						</Text>
					</Pressable>
				)}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	centerColumn: {
		flex: 1,
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
	ctaLabel: {
		fontWeight: '600',
	},
});
