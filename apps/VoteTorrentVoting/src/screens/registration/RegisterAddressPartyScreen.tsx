/**
 * RegisterAddressPartyScreen — Register form Step 2 · Address + Party (REG-03, `2891:1542`).
 * Second of the 3 pushed form-step routes (RESEARCH Pattern 1). Address fields + party selection
 * bind write-through directly to the shared `RegistrationDraftProvider` instance — NO local
 * `useState` buffer (RESEARCH Anti-Patterns) — so Back returns to Step 1 and Continue advances to
 * Step 3 with the draft fully preserved either way.
 *
 * Both footer CTAs are always enabled (D-02 mock-permissive — no required-field validation).
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
import {PartyChipSelector} from '../../components/PartyChipSelector';
import type {PartyChipOption} from '../../components/PartyChipSelector';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type RegisterAddressPartyNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegisterAddressParty'
>;

export default function RegisterAddressPartyScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate) — token call, unused value is fine (Pitfall 1).
	useVotingApp();
	const {draft, updateField} = useRegistrationDraft();
	const navigation = useNavigation<RegisterAddressPartyNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	const partyOptions: PartyChipOption[] = [
		{key: 'democratic', label: t('form.party.democratic')},
		{key: 'republican', label: t('form.party.republican')},
		{key: 'independent', label: t('form.party.independent')},
		{key: 'other', label: t('form.party.other')},
	];

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<StepProgressBar step={2} />
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
					testID="register-address-1"
					label={t('form.addressLine1')}
					value={draft.addressLine1}
					onChangeText={v => updateField('addressLine1', v)}
				/>
				<LabeledTextInput
					testID="register-address-2"
					label={t('form.addressLine2')}
					value={draft.addressLine2}
					onChangeText={v => updateField('addressLine2', v)}
				/>
				<LabeledTextInput
					testID="register-address-3"
					label={t('form.addressLine3')}
					value={draft.addressLine3}
					onChangeText={v => updateField('addressLine3', v)}
				/>
			</View>

			<View style={styles.fieldGroup}>
				<Text
					style={[
						styles.partyLabel,
						{
							color: colors.text,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.h4.fontSize,
							lineHeight: typeScale.h4.lineHeight,
						},
					]}>
					{t('form.selectParty')}
				</Text>
				<PartyChipSelector
					options={partyOptions}
					value={draft.party}
					onChange={v => updateField('party', v)}
				/>
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
					testID="register-continue"
					onPress={() => navigation.navigate('RegisterConfirm')}
					style={[styles.footerButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.footerButtonLabel, {color: colors.light}]}>{t('form.continueCta')}</Text>
				</Pressable>
			</View>
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
	partyLabel: {
		marginBottom: 8, // sm spacing token
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
