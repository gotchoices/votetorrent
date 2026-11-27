/**
 * RegistrationInfoScreen — the `RegistrationInfo` modal (Registration and Timeline stacks), reached
 * from the Registration tab's network header and the RegistrationCard "(?)" help. Replaces the
 * `PlaceholderModal`; only the rendered component swaps — the route's modal chrome (title, close X)
 * stays in navigation/index.tsx.
 *
 * Shows this device's LIVE registration status and the current election's registration deadline,
 * both read fresh on every focus (59 D-23: nothing cached), then a short explanation of the steps
 * the Registration tab walks the voter through. Status reuses the Timeline panel's four sentences
 * (`resolveRegistrationStatus` -> registered / pending / notRegistered / indeterminate) so the two
 * surfaces can never disagree in wording. A missing `registrationEnds` is shown as absent, never
 * defaulted. This screen navigates nowhere (Timeline Gate B).
 */
import React, {useCallback, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {resolveRegistrationStatus} from '../../engines/registration-status';
import type {RegistrationStatusKind, RegistrationStatusResult} from '../../engines/registration-status';
import {readRegistrationDeadline} from '../../engines/info-read';
import type {RegistrationDeadlineInfo} from '../../engines/info-read';

const STATUS_SENTENCE_KEY: Record<RegistrationStatusKind, string> = {
	registered: 'registration.isRegistered',
	pending: 'registration.pending',
	notRegistered: 'registration.notRegistered',
	indeterminate: 'registration.unknown',
};

const STEP_KEYS = ['info.step1', 'info.step2', 'info.step3', 'info.step4'] as const;

type DeadlineState = {kind: 'loading'} | {kind: 'none'} | {kind: 'ready'; info: RegistrationDeadlineInfo};

export default function RegistrationInfoScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline fixture-module import.
	const {getEngine, seededElectionId} = useVoterApp();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t, i18n} = useTranslation('registration');
	const {t: tTimeline} = useTranslation('timeline');
	const [deadline, setDeadline] = useState<DeadlineState>({kind: 'loading'});
	const [status, setStatus] = useState<RegistrationStatusResult | null>(null);

	useFocusEffect(
		useCallback(() => {
			let live = true;
			setDeadline({kind: 'loading'});
			setStatus(null);
			(async () => {
				let electionId: string | undefined;
				try {
					const info = await readRegistrationDeadline({
						getEngine,
						fallbackElectionId: __DEV__ ? seededElectionId : undefined,
					});
					electionId = info.electionId;
					if (live) setDeadline({kind: 'ready', info});
				} catch {
					if (live) setDeadline({kind: 'none'});
				}
				const result = await resolveRegistrationStatus({
					getEngine,
					getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
					...(electionId ? {electionId} : {}),
				}).catch((): RegistrationStatusResult => ({kind: 'indeterminate'}));
				if (live) setStatus(result);
			})();
			return () => {
				live = false;
			};
		}, [getEngine, seededElectionId]),
	);

	const bodyText = {
		color: colors.text,
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: typeScale.body.fontSize,
		lineHeight: typeScale.body.lineHeight,
	};
	const labelText = {
		color: colors.textSecondary,
		fontFamily: fonts.medium.fontFamily,
		fontWeight: fonts.medium.fontWeight,
		fontSize: typeScale.caption.fontSize,
		lineHeight: typeScale.caption.lineHeight,
	};
	const headingText = {
		color: colors.text,
		fontFamily: fonts.bold.fontFamily,
		fontWeight: fonts.bold.fontWeight,
		fontSize: typeScale.h4.fontSize,
		lineHeight: typeScale.h4.lineHeight,
	};

	const statusSentence =
		status === null
			? null
			: status.kind === 'indeterminate'
				? tTimeline(STATUS_SENTENCE_KEY.indeterminate)
				: tTimeline(STATUS_SENTENCE_KEY[status.kind], {
						bold: tTimeline('registration.isRegisteredBold'),
						network: status.networkName ?? '',
					});

	const registrationEnds = deadline.kind === 'ready' ? deadline.info.registrationEnds : undefined;
	const deadlinePassed = registrationEnds !== undefined && registrationEnds <= Date.now();

	return (
		<View style={[styles.screen, {backgroundColor: colors.background}]}>
			<ScrollView contentContainerStyle={styles.content}>
				<View style={[styles.card, {backgroundColor: colors.card, borderRadius: radii.lg}]}>
					<Text style={headingText}>{t('info.statusHeading')}</Text>
					{statusSentence === null ? (
						<ActivityIndicator testID="registration-info-status-loading" color={colors.primary} style={styles.loading} />
					) : (
						<Text testID="registration-info-status" style={bodyText}>
							{statusSentence}
						</Text>
					)}
					{status?.networkName ? (
						<View style={styles.row}>
							<Text style={labelText}>{t('info.network')}</Text>
							<Text testID="registration-info-network" style={bodyText}>
								{status.networkName}
							</Text>
						</View>
					) : null}
				</View>

				<View style={[styles.card, {backgroundColor: colors.card, borderRadius: radii.lg}]}>
					{deadline.kind === 'loading' ? (
						<ActivityIndicator testID="registration-info-deadline-loading" color={colors.primary} style={styles.loading} />
					) : deadline.kind === 'none' ? (
						<Text testID="registration-info-no-election" style={bodyText}>
							{t('info.noElection')}
						</Text>
					) : (
						<>
							<View style={styles.row}>
								<Text style={labelText}>{t('info.election')}</Text>
								<Text testID="registration-info-election" style={bodyText}>
									{deadline.info.electionTitle}
								</Text>
							</View>
							{registrationEnds !== undefined ? (
								<View style={styles.row}>
									<Text style={labelText}>{deadlinePassed ? t('info.deadlinePassed') : t('info.deadline')}</Text>
									<Text testID="registration-info-deadline" style={bodyText}>
										{formatInstant(registrationEnds, i18n.language)}
									</Text>
								</View>
							) : null}
						</>
					)}
				</View>

				<View style={[styles.card, {backgroundColor: colors.card, borderRadius: radii.lg}]}>
					<Text style={headingText}>{t('info.howHeading')}</Text>
					{STEP_KEYS.map((key, index) => (
						<View key={key} style={styles.step}>
							<Text style={[bodyText, styles.stepNumber, {color: colors.primary}]}>{index + 1}.</Text>
							<Text style={[bodyText, styles.stepText]}>{t(key)}</Text>
						</View>
					))}
				</View>
			</ScrollView>
		</View>
	);
}

/** `registrationEnds` is an instant (not a day), so it is shown in the voter's own time zone. */
function formatInstant(ms: number, language: string): string {
	return new Intl.DateTimeFormat(language, {dateStyle: 'long', timeStyle: 'short'}).format(new Date(ms));
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
		gap: 16,
	},
	card: {
		padding: 16,
		gap: 12,
	},
	row: {
		gap: 4,
	},
	loading: {
		alignSelf: 'flex-start',
	},
	step: {
		flexDirection: 'row',
		gap: 8,
	},
	stepNumber: {
		minWidth: 20,
	},
	stepText: {
		flex: 1,
	},
});
