/**
 * RegisterConfirmScreen — Register form Step 3 · Confirm/Review (REG-03, `2891:1590`). Third and
 * final pushed form-step route (RESEARCH Pattern 1) — read-only review of the shared
 * `RegistrationDraftProvider` instance, mirroring `ValidationDetailsScreen`'s labelled-row list
 * shape (Phase 40). Reads the draft directly (not route params, per RESEARCH Pattern 2).
 *
 * Submit navigates to `Confirmation` but deliberately does NOT flip `isRegistered` — that only
 * happens on Confirmation's own Face-ID tap (D-05). This screen intentionally does NOT
 * destructure `setIsRegistered` from `useVotingApp()`.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {StepProgressBar} from '../../components/StepProgressBar';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type RegisterConfirmNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegisterConfirm'
>;

export default function RegisterConfirmScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate) — token call only. Do NOT destructure
	// setIsRegistered here: the confirming flip is Confirmation's job (D-05).
	useVotingApp();
	const {draft} = useRegistrationDraft();
	const navigation = useNavigation<RegisterConfirmNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	const fullName = `${draft.firstName} ${draft.lastName}`.trim();
	const address = [draft.addressLine1, draft.addressLine2, draft.addressLine3]
		.filter(line => line.length > 0)
		.join(', ');

	const rows: Array<{key: string; labelKey: string; value: string}> = [
		{key: 'fullName', labelKey: 'form.review.fullName', value: fullName},
		{key: 'dob', labelKey: 'form.review.dob', value: draft.dob},
		{key: 'email', labelKey: 'form.review.email', value: draft.email},
		{key: 'phone', labelKey: 'form.review.phone', value: draft.phone},
		{key: 'party', labelKey: 'form.review.party', value: draft.party},
		{key: 'address', labelKey: 'form.review.address', value: address},
	];

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<StepProgressBar step={3} />
			<Text
				style={[
					styles.instruction,
					{
						color: colors.textSecondary,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					},
				]}>
				{t('form.confirmInstruction')}
			</Text>

			<View style={styles.rowList}>
				{rows.map(row => (
					<View
						key={row.key}
						testID={`register-review-${row.key}`}
						style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
						<Text
							style={[
								styles.rowLabel,
								{
									color: colors.textSecondary,
									fontFamily: fonts.regular.fontFamily,
									fontWeight: fonts.regular.fontWeight,
									fontSize: typeScale.caption.fontSize,
									lineHeight: typeScale.caption.lineHeight,
								},
							]}>
							{t(row.labelKey)}
						</Text>
						<Text
							style={[
								styles.rowValue,
								{
									color: colors.text,
									fontFamily: fonts.regular.fontFamily,
									fontWeight: fonts.regular.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
								},
							]}>
							{row.value}
						</Text>
					</View>
				))}
			</View>

			<View style={[globalStyles.footerButtonsContainer, styles.footer]}>
				<Pressable
					testID="register-back"
					onPress={() => navigation.goBack()}
					style={[
						styles.footerButton,
						styles.backButton,
						{
							backgroundColor: colors.secondaryButtonSurface,
							borderColor: colors.primary,
							borderRadius: radii.pill,
						},
					]}>
					<Text style={[styles.footerButtonLabel, {color: colors.primary}]}>{t('form.backCta')}</Text>
				</Pressable>
				<Pressable
					testID="register-submit"
					onPress={() => navigation.navigate('Confirmation')}
					style={[styles.footerButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.footerButtonLabel, {color: colors.light}]}>{t('form.submitCta')}</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	instruction: {
		marginTop: 16, // md spacing token
	},
	rowList: {
		marginTop: 24, // lg spacing token
	},
	rowLabel: {},
	rowValue: {
		marginTop: 4, // xs spacing token
	},
	footer: {
		marginTop: 24, // lg spacing token
	},
	footerButton: {
		flex: 1,
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 12,
	},
	backButton: {
		borderWidth: 1,
	},
	footerButtonLabel: {
		fontWeight: '600',
	},
});
