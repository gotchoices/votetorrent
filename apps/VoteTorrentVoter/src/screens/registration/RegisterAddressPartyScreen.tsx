/**
 * RegisterAddressPartyScreen — Register form Step 2 · Address + Party (REG-03, Figma `2891:1542`).
 * Full-bleed (headerShown:false, tab bar hidden). Matches the Figma frame: RegisterFormHeader,
 * one grouped card of the three address lines, then "Select Your Party" as a DROPDOWN (not chips),
 * then a full-width Continue. The old footer Back button is gone — Back is the header arrow.
 *
 * Fields bind write-through to the shared RegistrationDraftProvider. Party stores the stable KEY.
 * Continue validates (address line 1 + party required) and only advances when valid.
 */
import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {RegisterFormHeader} from '../../components/RegisterFormHeader';
import {FieldGroupCard, FieldRow} from '../../components/FieldGroup';
import {PartyDropdown} from '../../components/PartyDropdown';
import type {PartyOption} from '../../components/PartyDropdown';
import {globalStyles} from '../../theme/styles';
import {
	validateAddressParty,
	hasErrors,
	type AddressPartyField,
	type FieldError,
} from '../../utils/registrationForm';
import type {RegistrationStackParamList} from '../../navigation/types';

type RegisterAddressPartyNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegisterAddressParty'
>;

export default function RegisterAddressPartyScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate) — token call, unused value is fine (Pitfall 1).
	useVoterApp();
	const {draft, updateField} = useRegistrationDraft();
	const navigation = useNavigation<RegisterAddressPartyNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');
	const insets = useSafeAreaInsets();

	const [errors, setErrors] = useState<Partial<Record<AddressPartyField, FieldError>>>({});

	const errText = (f: AddressPartyField): string | undefined =>
		errors[f] ? t('form.errors.' + errors[f]) : undefined;

	const partyOptions: PartyOption[] = [
		{key: 'democratic', label: t('form.party.democratic')},
		{key: 'republican', label: t('form.party.republican')},
		{key: 'independent', label: t('form.party.independent')},
		{key: 'other', label: t('form.party.other')},
	];

	const onContinue = () => {
		const errs = validateAddressParty(draft);
		setErrors(errs);
		if (!hasErrors(errs)) navigation.navigate('RegisterConfirm');
	};

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
					title={t('formHeaderTitle')}
					subtitle={t('form.sectionTitle')}
					step={2}
					onBack={() => navigation.goBack()}
					onClose={() => navigation.popToTop()}
				/>

				<View style={styles.groups}>
					<FieldGroupCard>
						<FieldRow
							testID="register-address-1"
							placeholder={t('form.addressLine1')}
							value={draft.addressLine1}
							onChangeText={v => {
								updateField('addressLine1', v);
								if (errors.addressLine1) setErrors(e => ({...e, addressLine1: undefined}));
							}}
							error={errText('addressLine1')}
						/>
						<FieldRow
							testID="register-address-2"
							placeholder={t('form.addressLine2')}
							value={draft.addressLine2}
							onChangeText={v => updateField('addressLine2', v)}
						/>
						<FieldRow
							testID="register-address-3"
							placeholder={t('form.addressLine3')}
							value={draft.addressLine3}
							onChangeText={v => updateField('addressLine3', v)}
						/>
					</FieldGroupCard>

					<View style={styles.groupGap}>
						<PartyDropdown
							testID="register-party"
							options={partyOptions}
							value={draft.party}
							placeholder={t('form.selectParty')}
							onChange={v => {
								updateField('party', v);
								if (errors.party) setErrors(e => ({...e, party: undefined}));
							}}
							error={errText('party')}
						/>
					</View>
				</View>
			</ScrollView>

			<View style={styles.footer}>
				<Pressable
					testID="register-continue"
					onPress={onContinue}
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
						{t('form.continueCta')}
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
	groups: {
		marginTop: 24,
	},
	groupGap: {
		marginTop: 16,
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
