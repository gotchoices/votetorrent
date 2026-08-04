/**
 * RegisterPersonalScreen — Register form Step 1 · Personal (REG-03, Figma `2868:1522`). Full-bleed
 * (headerShown:false; the bottom tab bar is hidden across the whole form flow, see navigation/
 * index.tsx) so the register form reads as one continuous, un-interruptible process.
 *
 * Layout matches the Figma frame: an in-content RegisterFormHeader (back-arrow top-left, close
 * top-right, "Register" title + subtitle + step dots), then two grouped field cards
 * ({First, Last, DOB} and {Email, Phone}) with placeholder labels, then a full-width Continue.
 *
 * Fields bind write-through to the shared RegistrationDraftProvider (no local buffer). DOB is a
 * masked MM/DD/YYYY text field (the app has no date-picker package — DOB is its only date input).
 * Continue now VALIDATES (required + email/phone/dob format) and only advances when the step is
 * valid, surfacing inline field errors otherwise.
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
import {globalStyles} from '../../theme/styles';
import {
	maskDateInput,
	validatePersonal,
	hasErrors,
	type PersonalField,
	type FieldError,
} from '../../utils/registrationForm';
import type {RegistrationStackParamList} from '../../navigation/types';

type RegisterPersonalNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegisterPersonal'
>;

export default function RegisterPersonalScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate) — token call, unused value is fine (Pitfall 1).
	useVoterApp();
	const {draft, updateField} = useRegistrationDraft();
	const navigation = useNavigation<RegisterPersonalNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');
	const insets = useSafeAreaInsets();

	const [errors, setErrors] = useState<Partial<Record<PersonalField, FieldError>>>({});

	const errText = (f: PersonalField): string | undefined =>
		errors[f] ? t('form.errors.' + errors[f]) : undefined;

	// Update a field and clear its error (re-validated on the next Continue attempt).
	const bind = (field: PersonalField) => (v: string) => {
		updateField(field, v);
		if (errors[field]) setErrors(e => ({...e, [field]: undefined}));
	};

	const onContinue = () => {
		const errs = validatePersonal(draft);
		setErrors(errs);
		if (!hasErrors(errs)) navigation.navigate('RegisterAddressParty');
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
					step={1}
					onBack={() => navigation.goBack()}
					onClose={() => navigation.popToTop()}
				/>

				<View style={styles.groups}>
					<FieldGroupCard>
						<FieldRow
							testID="register-first-name"
							placeholder={t('form.firstName')}
							value={draft.firstName}
							onChangeText={bind('firstName')}
							autoCapitalize="words"
							error={errText('firstName')}
						/>
						<FieldRow
							testID="register-last-name"
							placeholder={t('form.lastName')}
							value={draft.lastName}
							onChangeText={bind('lastName')}
							autoCapitalize="words"
							error={errText('lastName')}
						/>
						<FieldRow
							testID="register-dob"
							placeholder={t('form.dobPlaceholder')}
							value={draft.dob}
							onChangeText={v => bind('dob')(maskDateInput(v))}
							keyboardType="number-pad"
							maxLength={10}
							error={errText('dob')}
						/>
					</FieldGroupCard>

					<View style={styles.groupGap}>
						<FieldGroupCard>
							<FieldRow
								testID="register-email"
								placeholder={t('form.email')}
								value={draft.email}
								onChangeText={bind('email')}
								keyboardType="email-address"
								autoCapitalize="none"
								error={errText('email')}
							/>
							<FieldRow
								testID="register-phone"
								placeholder={t('form.phone')}
								value={draft.phone}
								onChangeText={bind('phone')}
								keyboardType="phone-pad"
								error={errText('phone')}
							/>
						</FieldGroupCard>
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
		marginTop: 24, // lg — space below the header/dots
	},
	groupGap: {
		marginTop: 16, // md — gap between the two field-group cards
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
