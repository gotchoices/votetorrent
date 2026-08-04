/**
 * RegisterConfirmScreen — Register form Step 3 · Confirm/Review (REG-03, Figma `2891:1590`).
 * Full-bleed (headerShown:false, tab bar hidden). Matches the Figma "Confirm" frame: the
 * RegisterFormHeader ("Confirm" title + "Check to ensure all information is correct" subtitle +
 * step dots), one review card whose rows are label-left / value-right, then a single full-width
 * "Submit" button. The old footer Back button is gone — Back is the header arrow.
 *
 * Read-only view of the shared RegistrationDraftProvider. Submit navigates to Confirmation but
 * does NOT flip isRegistered — that is Confirmation's Face-ID tap (D-05). draft.party is the stable
 * KEY, resolved to the current-locale label at this display site.
 */
import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {RegisterFormHeader} from '../../components/RegisterFormHeader';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type RegisterConfirmNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegisterConfirm'
>;

export default function RegisterConfirmScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate) — token call only. Do NOT destructure
	// setIsRegistered here: the confirming flip is Confirmation's job (D-05).
	useVoterApp();
	const {draft} = useRegistrationDraft();
	const navigation = useNavigation<RegisterConfirmNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');
	const insets = useSafeAreaInsets();

	const fullName = `${draft.firstName} ${draft.lastName}`.trim();
	const address = [draft.addressLine1, draft.addressLine2, draft.addressLine3]
		.filter(line => line.length > 0)
		.join(', ');
	const partyLabel = draft.party ? t('form.party.' + draft.party) : '';

	const rows: Array<{key: string; labelKey: string; value: string}> = [
		{key: 'fullName', labelKey: 'form.review.fullName', value: fullName},
		{key: 'dob', labelKey: 'form.review.dob', value: draft.dob},
		{key: 'email', labelKey: 'form.review.email', value: draft.email},
		{key: 'phone', labelKey: 'form.review.phone', value: draft.phone},
		{key: 'address', labelKey: 'form.review.address', value: address},
		{key: 'party', labelKey: 'form.review.party', value: partyLabel},
	];

	return (
		<View
			style={[
				globalStyles.container,
				styles.screen,
				{
					backgroundColor: colors.background,
					paddingTop: insets.top + 16,
					paddingBottom: insets.bottom + 12,
				},
			]}>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
				<RegisterFormHeader
					title={t('confirmHeaderTitle')}
					subtitle={t('form.confirmInstruction')}
					step={3}
					onBack={() => navigation.goBack()}
					onClose={() => navigation.popToTop()}
				/>

				<View
					style={[
						styles.card,
						{backgroundColor: colors.card, borderColor: colors.border, borderRadius: radii.lg},
					]}>
					{rows.map((row, i) => (
						<View
							key={row.key}
							testID={`register-review-${row.key}`}
							style={[styles.row, i > 0 ? styles.rowGap : null]}>
							<Text
								style={[
									styles.rowLabel,
									{
										color: colors.textSecondary,
										fontFamily: fonts.regular.fontFamily,
										fontWeight: fonts.regular.fontWeight,
										fontSize: typeScale.body.fontSize,
										lineHeight: typeScale.body.lineHeight,
									},
								]}>
								{t(row.labelKey)}
							</Text>
							<Text
								style={[
									styles.rowValue,
									{
										color: colors.text,
										fontFamily: fonts.medium.fontFamily,
										fontWeight: fonts.medium.fontWeight,
										fontSize: typeScale.body.fontSize,
										lineHeight: typeScale.body.lineHeight,
									},
								]}>
								{row.value}
							</Text>
						</View>
					))}
				</View>
			</ScrollView>

			<View style={styles.footer}>
				<Pressable
					testID="register-submit"
					onPress={() => navigation.navigate('Confirmation')}
					style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text
						style={[
							styles.ctaLabel,
							{
								color: colors.light,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.body.fontSize,
							},
						]}>
						{t('form.submitCta')}
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
	scroll: {
		flex: 1,
	},
	scrollContent: {
		flexGrow: 1,
	},
	card: {
		marginTop: 24,
		borderWidth: 1,
		padding: 16,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 16,
	},
	rowGap: {
		marginTop: 20, // lg-ish vertical rhythm between review rows (Figma spacing, no dividers)
	},
	rowLabel: {
		flexShrink: 0,
	},
	rowValue: {
		flex: 1,
		textAlign: 'right',
	},
	footer: {
		paddingTop: 16,
	},
	cta: {
		minHeight: 52,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 14,
	},
	ctaLabel: {
		textAlign: 'center',
	},
});
