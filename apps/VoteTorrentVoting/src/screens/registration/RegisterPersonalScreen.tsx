/**
 * RegisterPersonalScreen — Register form Step 1 · Personal (REG-03, `2868:1522`). First of the
 * 3 pushed form-step routes (RESEARCH Pattern 1): each field binds write-through directly to the
 * shared `RegistrationDraftProvider` instance via `updateField` — NO local `useState` buffer
 * (RESEARCH Anti-Patterns) — so Back/Continue across all 3 steps always sees the same durable
 * draft. `StepProgressBar step={1}` is hardcoded per screen (not derived from route params).
 *
 * Continue is always enabled (D-02 mock-permissive — no required-field validation blocks
 * advancing).
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {LabeledTextInput} from '../../components/LabeledTextInput';
import {StepProgressBar} from '../../components/StepProgressBar';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type RegisterPersonalNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegisterPersonal'
>;

export default function RegisterPersonalScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate) — token call, unused value is fine (Pitfall 1).
	useVotingApp();
	const {draft, updateField} = useRegistrationDraft();
	const navigation = useNavigation<RegisterPersonalNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<StepProgressBar step={1} />
			<Text
				style={[
					styles.sectionTitle,
					{
						color: colors.text,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.h4.fontSize,
						lineHeight: typeScale.h4.lineHeight,
					},
				]}>
				{t('form.sectionTitle')}
			</Text>

			<View style={styles.fieldGroup}>
				<LabeledTextInput
					testID="register-first-name"
					label={t('form.firstName')}
					value={draft.firstName}
					onChangeText={v => updateField('firstName', v)}
				/>
				<LabeledTextInput
					testID="register-last-name"
					label={t('form.lastName')}
					value={draft.lastName}
					onChangeText={v => updateField('lastName', v)}
				/>
				<LabeledTextInput
					testID="register-dob"
					label={t('form.dob')}
					value={draft.dob}
					placeholder={t('form.dobPlaceholder')}
					onChangeText={v => updateField('dob', v)}
				/>
			</View>

			<View style={styles.fieldGroup}>
				<LabeledTextInput
					testID="register-email"
					label={t('form.email')}
					value={draft.email}
					onChangeText={v => updateField('email', v)}
				/>
				<LabeledTextInput
					testID="register-phone"
					label={t('form.phone')}
					value={draft.phone}
					onChangeText={v => updateField('phone', v)}
				/>
			</View>

			<Pressable
				testID="register-continue"
				onPress={() => navigation.navigate('RegisterAddressParty')}
				style={[styles.continueCta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
				<Text style={[styles.continueLabel, {color: colors.light}]}>{t('form.continueCta')}</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	sectionTitle: {
		marginTop: 24, // lg spacing token
	},
	fieldGroup: {
		marginTop: 24, // lg spacing token
	},
	continueCta: {
		marginTop: 24, // lg spacing token
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 12,
	},
	continueLabel: {
		fontWeight: '600',
	},
});
