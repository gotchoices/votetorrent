/**
 * ConfirmationScreen (REG-04/D-05/D-07) — the Face-ID confirmation screen. The "Confirm with
 * Face ID" tap IS the deliberate confirming gesture (D-05), not decorative or an auto-advance.
 * `navigation.popToTop()` clears the whole `DeviceAttestation → RegisterPersonal →
 * RegisterAddressParty → RegisterConfirm → Confirmation` chain in one call (41-RESEARCH.md
 * Pattern 5) — NOT `navigate('RegistrationHome')`, which would leave that entire chain on the
 * back stack. No native biometric module (D-07); no auto-advance on this screen (unlike
 * DeviceAttestation), since D-05 requires the explicit tap.
 *
 * Phase 44-08 (the phase's capstone plan) — the CONFIRMING TAP now drives the REAL signed
 * registration + association ceremony end-to-end, per the research resolution of Pitfall 4 /
 * Open Question 1: navigation order is UNCHANGED, `DeviceAttestationScreen` stays a pure visual
 * interstitial, and ALL real engine calls are deferred to THIS screen's tap — a real
 * `registrantId` does not exist until `register()` runs.
 *
 * The 5-step ceremony (44-PATTERNS.md):
 *   1. Map the shared draft (`useRegistrationDraft().draft`) onto `RegisterInit` tiers —
 *      firstName/lastName -> public, dob/email/phone/address -> private `PrivateDetail[]`,
 *      party -> selective (D-13, only when non-empty) — with `electionId` set to the D-07
 *      seeded election id (`useVotingApp().seededElectionId`) so `validateFieldPolicy` fires
 *      (D-08/D-09).
 *   2. `RegistrationEngine.register(init, sign)` with the device signer
 *      (`useVotingApp().sign` — the SAME founding-officer/device identity 44-06 seeded, never
 *      the CadreNode peer key).
 *   3. `AssociationEngine.issueAttestationChallenge(registrantId, deviceKey, expiration, sign)`.
 *   4. The D-03 `StubAttestationProducer` answers the challenge with a `DeviceAttestation`
 *      (the phase's ONE clearly-marked stub — Phase 45 drops a `RealAttestationProducer` into
 *      this exact seam).
 *   5. `AssociationEngine.buildAssociate()...setAttestation(stub)...commit()`.
 *
 * On full success: `useRegistrationDraft().clearDraft()` (T-42-01c submit-path wipe, pairs with
 * 44-05's abandon-path wipe) then `navigation.popToTop()`. On ANY thrown step: an inline error
 * message renders and the CTA becomes a retry affordance (mirrors
 * `AppProvider.tsx`'s "Try Again" button shape) — no nav, no draft clear, so the user can retry
 * with their data intact (T-44-23).
 */
import React, {useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
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
import {useVotingApp} from '../../providers/VotingAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {getOrCreateDeviceUser} from '../../engines/device-user';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
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
	const {seededElectionId, sign, getEngine} = useVotingApp();
	const {draft, clearDraft} = useRegistrationDraft();
	const navigation = useNavigation<ConfirmationNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	const [isSubmitting, setIsSubmitting] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
		setErrorMessage(null);
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

			// The seeded network's founding-officer authority (dev-seed.ts, 44-06) — resolved from
			// the already-established network context, never hand-rolled.
			const networkEngine = await getEngine<INetworkEngine>('network');
			const details = await networkEngine.getDetails();
			const authorityId = details.network.primaryAuthorityId;

			// The SAME device identity used as the signer (device-user.ts) — its public key is the
			// association's DeviceKey (D-05/D-07). Idempotent: returns the already-persisted user.
			const deviceUser = await getOrCreateDeviceUser('Device User');
			const deviceKey = deviceUser.activeKeys[0]!.key;

			// WR-02: mint the registrantId once per attempt and reuse it on retry.
			if (registrantIdRef.current === null) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				registrantIdRef.current = (globalThis as any).crypto.randomUUID();
			}
			const registrantId: string = registrantIdRef.current;
			const expiration = Date.now() + TEN_YEARS_MS;
			const challengeExpiration = new Date(expiration).toISOString();

			// Pattern 4 tier mapping — name -> public, contact/dob/address -> private, party -> selective.
			const privateDetails: PrivateDetail[] = [
				{name: 'dob', value: draft.dob},
				{name: 'email', value: draft.email},
				{name: 'phone', value: draft.phone},
				{name: 'addressLine1', value: draft.addressLine1},
				{name: 'addressLine2', value: draft.addressLine2},
				{name: 'addressLine3', value: draft.addressLine3},
			];

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

			// (2)-(4) Step 2 — challenge, then the D-03 stub attestation producer answers it.
			const associationEngine = await getEngine<IAssociationEngine>('association');
			const challenge = await associationEngine.issueAttestationChallenge(
				registrantId,
				deviceKey,
				challengeExpiration,
				sign,
			);
			// CR-01/D-03: resolve the producer through the fail-closed gate — a real
			// producer wins, else the stub under __DEV__, else throw in a release build.
			// Phase 45 drops its RealAttestationProducer into this exact seam.
			const produceAttestation = resolveAttestationProducer();
			const attestation = await produceAttestation(challenge, deviceKey);

			// (5) Step 3 — the real associate ceremony, committing the stub attestation.
			await (associationEngine.buildAssociate() as unknown as AssociateBuilderChain)
				.setRegistrantId(registrantId)
				.setDeviceKey(deviceKey)
				.setNonce(challenge.nonce)
				.setAttestation(attestation)
				.setSignatureOrCallback(sign)
				.commit();

			// Only on full success: wipe the draft (T-42-01c) and pop the whole registration chain.
			clearDraft();
			navigation.popToTop();
		} catch (err) {
			console.error('ConfirmationScreen: registration ceremony failed:', err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			setIsSubmitting(false);
		}
	}

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
				{errorMessage ? (
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
						{errorMessage}
					</Text>
				) : null}
				<Pressable
					testID="confirmation-confirm-face-id"
					onPress={onConfirm}
					disabled={isSubmitting}
					style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.ctaLabel, {color: colors.light}]}>
						{errorMessage ? 'Try Again' : t('confirmation.cta')}
					</Text>
				</Pressable>
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
	ctaLabel: {
		fontWeight: '600',
	},
});
