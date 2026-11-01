/**
 * RegistrationScreen — Registration tab root. Renders the branded blue NetworkHeader (Figma) then
 * the not-registered / registered RegistrationCard, reading draft from useRegistrationDraft().
 * Card callbacks map to navigation: Register now -> DeviceAttestation, Update registration ->
 * RegisterPersonal, (?) help -> RegistrationInfo.
 *
 * UAT 65 gap 5 / D-100: the card now reads the authoritative registration status
 * (`resolveRegistrationStatus`, the Association row for this device's key) on every focus, so a
 * device the election office has approved shows the registered card without any in-session action.
 * The session-only `isRegistered`/`registeredAt` state from Phase 44-07 remains as the __DEV__
 * toggle's override for manual QA: once toggled in this session it wins over the engine read. An
 * engine-derived registration carries no date, so `registeredAt` stays null (the card handles it).
 *
 * headerShown:false for RegistrationHome (navigation/index.tsx) — NetworkHeader replaces the plain
 * native header. A __DEV__-gated isRegistered toggle is kept for manual QA (compiled out of release).
 *
 * Phase 62 Plan 28 (D-40/D-45) addition: below the card, a `useFocusEffect`-driven read of
 * `resolveRegistrationCodeAvailability` offers 'available' -> the show-again link (re-resolves
 * fresh on tap, never cached — 59 D-23), 'not-registered' -> `newDevice.entryLink` into
 * `ContinueOnAnotherDevice`, 'not-sent'/'not-holder'/'unavailable' -> the code-unavailable notice,
 * and an unsettled read (null) -> a distinct "checking" line, so "still loading" is never visually
 * identical to "settled with nothing to show" (UAT 62 test 14: a settled 'unavailable' rendered
 * nothing and read as a hang).
 * Known limitation: the code read is independent of the __DEV__ toggle override above, so a
 * toggled-off approved device can show the not-registered card alongside "Show my registration code".
 */
import React, {useCallback, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useNetworkName} from '../../hooks/useNetworkName';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {resolveRegistrationCodeAvailability} from '../../engines/continuity';
import {resolveRegistrationStatus} from '../../engines/registration-status';
import type {RegistrationCodeAvailability} from '../../engines/continuity';
import {RegistrationConfirmationCodeCard} from './RegistrationConfirmationCodeCard';
import type {RegistrationStackParamList} from '../../navigation/types';
import {RegistrationCard} from '../../components/RegistrationCard';
import {NetworkHeader} from '../../components/NetworkHeader';

type RegistrationNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegistrationHome'
>;

export default function RegistrationScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline fixture-module import.
	const {isInitialized, getEngine, hasNetwork} = useVoterApp();
	const networkName = useNetworkName();
	const {draft} = useRegistrationDraft();
	// __DEV__ toggle override (null until toggled this session) — see file header comment.
	const [devOverride, setDevOverride] = useState<boolean | null>(null);
	const [devRegisteredAt, setDevRegisteredAt] = useState<string | null>(null);
	// D-100: the authoritative read, re-resolved on every focus.
	const [engineRegistered, setEngineRegistered] = useState(false);
	const isRegistered = devOverride ?? engineRegistered;
	const registeredAt = devOverride === true ? devRegisteredAt : null;
	const setIsRegistered = useCallback((value: boolean) => {
		setDevOverride(value);
		if (value) {
			setDevRegisteredAt(new Date().toISOString());
		}
	}, []);
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const navigation = useNavigation<RegistrationNavigationProp>();
	const {t} = useTranslation('continuity');
	const {t: tJoin} = useTranslation('join');

	const [codeAvailability, setCodeAvailability] = useState<RegistrationCodeAvailability | null>(null);
	// Explicit, voter-initiated reveal (D-23/D-45) — set only by the showAgainLink tap below, and
	// cleared on blur so a return visit is a fresh, un-revealed state, never a stale one.
	const [revealed, setRevealed] = useState<RegistrationCodeAvailability | null>(null);

	useFocusEffect(
		useCallback(() => {
			let cancelled = false;
			(async () => {
				const result = await resolveRegistrationCodeAvailability({
					getEngine,
					getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
				});
				if (!cancelled) setCodeAvailability(result);
			})();
			return () => {
				cancelled = true;
				setRevealed(null);
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [getEngine]),
	);

	useFocusEffect(
		useCallback(() => {
			let cancelled = false;
			(async () => {
				try {
					const result = await resolveRegistrationStatus({
						getEngine,
						getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
					});
					// An indeterminate read (a dangling linkage, or a failed network or strand read) is not a
					// "no": it leaves the card as it was, like a throw. `pending` is determinate (no active
					// association yet), so it shows the not-registered card.
					if (!cancelled && result.kind !== 'indeterminate') setEngineRegistered(result.kind === 'registered');
				} catch {
					// An unreadable status leaves the card as it was.
				}
			})();
			return () => {
				cancelled = true;
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [getEngine]),
	);

	const retryInFlightRef = useRef(false);
	async function onRetryCodeRead() {
		if (retryInFlightRef.current) return;
		retryInFlightRef.current = true;
		try {
			const result = await resolveRegistrationCodeAvailability({
				getEngine,
				getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
			});
			setCodeAvailability(result);
		} finally {
			retryInFlightRef.current = false;
		}
	}

	async function onShowAgain() {
		const result = await resolveRegistrationCodeAvailability({
			getEngine,
			getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
		});
		setRevealed(result);
	}

	return (
		<View style={[styles.screen, {backgroundColor: colors.background}]}>
			<NetworkHeader networkName={networkName} onPressNetwork={() => navigation.navigate('RegistrationInfo')} />

			<ScrollView contentContainerStyle={styles.content}>
				{/* Spike 100: no network open yet — the way in is the authority's join code. */}
				{isInitialized && !hasNetwork ? (
					<Pressable
						testID="join-network-entry-link"
						onPress={() => navigation.navigate('JoinNetwork')}
						style={styles.link}>
						<Text style={[styles.linkText, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
							{tJoin('entryLink')}
						</Text>
					</Pressable>
				) : null}
				{isInitialized ? (
					<RegistrationCard
						isRegistered={isRegistered}
						draft={draft}
						registeredAt={registeredAt}
						networkName={networkName}
						onRegisterNow={() => navigation.navigate('DeviceAttestation')}
						onUpdateRegistration={() => navigation.navigate('RegisterPersonal')}
						onHelp={() => navigation.navigate('RegistrationInfo')}
					/>
				) : null}

				{codeAvailability?.kind === 'available' ? (
					<View style={styles.codeSection}>
						<Pressable testID="registration-code-show-again-link" onPress={onShowAgain} style={styles.link}>
							<Text style={[styles.linkText, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
								{t('code.showAgainLink')}
							</Text>
						</Pressable>
						{revealed ? (
							<RegistrationConfirmationCodeCard
								state={revealed.kind === 'available' ? {kind: 'code', code: revealed.code} : {kind: 'unavailable'}}
							/>
						) : null}
					</View>
				) : codeAvailability?.kind === 'not-registered' ? (
					<View style={styles.codeSection}>
						<Pressable
							testID="continue-device-entry-link"
							onPress={() => navigation.navigate('ContinueOnAnotherDevice')}
							style={styles.link}>
							<Text style={[styles.linkText, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
								{t('newDevice.entryLink')}
							</Text>
						</Pressable>
					</View>
				) : codeAvailability?.kind === 'unavailable' && codeAvailability.reason === 'read-failed' ? (
					// gap6/WR-07: a FAILED read is retryable and distinct from the permanent not-available
					// notice. If the failure came before the device's registration was known, the voter
					// still gets the continue-on-another-device entry so they are never at a dead end.
					<View style={styles.codeSection}>
						<Text
							testID="registration-code-unavailable"
							style={{color: colors.textSecondary, fontSize: typeScale.body.fontSize}}>
							{t('code.unavailable')}
						</Text>
						<Pressable testID="registration-code-retry" onPress={onRetryCodeRead} style={styles.link}>
							<Text style={[styles.linkText, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
								{t('code.retryButton')}
							</Text>
						</Pressable>
						{codeAvailability.registrantKnown === false ? (
							<Pressable
								testID="continue-device-entry-link"
								onPress={() => navigation.navigate('ContinueOnAnotherDevice')}
								style={styles.link}>
								<Text style={[styles.linkText, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
									{t('newDevice.entryLink')}
								</Text>
							</Pressable>
						) : null}
					</View>
				) : codeAvailability?.kind === 'not-sent' ||
				  codeAvailability?.kind === 'not-holder' ||
				  codeAvailability?.kind === 'unavailable' ? (
					<View style={styles.codeSection}>
						<Text
							testID="registration-code-not-available"
							style={{color: colors.textSecondary, fontSize: typeScale.body.fontSize}}>
							{t('code.notAvailableOnDevice')}
						</Text>
					</View>
				) : codeAvailability === null && isInitialized ? (
					<View style={styles.codeSection}>
						<Text
							testID="registration-code-checking"
							style={{color: colors.textSecondary, fontSize: typeScale.body.fontSize}}>
							{t('code.checking')}
						</Text>
					</View>
				) : null}

				{/* D-03: __DEV__-gated isRegistered toggle — manual QA only, never ships to release. */}
				{__DEV__ && isInitialized ? (
					<Pressable
						onPress={() => setIsRegistered(!isRegistered)}
						style={styles.devToggle}
						testID="registration-dev-toggle">
						<Text style={{color: colors.muted, fontSize: typeScale.caption.fontSize}}>
							Toggle isRegistered (dev): {String(isRegistered)}
						</Text>
					</Pressable>
				) : null}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	codeSection: {
		marginTop: 16, // md
	},
	link: {
		minHeight: 44,
		justifyContent: 'center',
	},
	linkText: {},
	devToggle: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
