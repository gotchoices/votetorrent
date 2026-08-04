/**
 * RegistrationCard (REG-01/REG-05) — the not-registered / registered card, restyled to the Figma
 * frames: a RED card for not-registered and a GREEN card for registered (both white text), with a
 * yellow "Valid through" badge on the registered card and a separate light-grey "Update
 * registration" card below it (blue CTA). Brand fills come from theme tokens (registerNegative /
 * registerPositive / validBadge).
 *
 * Pure presentational (props + callbacks) — no useVoterApp()/useNavigation(). The registered
 * identity line is interpolated from `draft`; the valid-through badge is FROZEN from `registeredAt`
 * via computeValidThrough (parses once, +1 year — never drifts as "today + 1 year" would).
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {globalStyles} from '../theme/styles';
import type {RegistrationDraft} from '../providers/RegistrationDraftProvider';

export interface RegistrationCardProps {
	isRegistered: boolean;
	draft: RegistrationDraft;
	registeredAt: string | null;
	onRegisterNow?: () => void;
	onUpdateRegistration?: () => void;
	onHelp?: () => void;
}

/** Parses `registeredAt`, adds 1 year, formats `MM/DD/YY`. Frozen from the passed value. */
export function computeValidThrough(registeredAt: string | null): string {
	if (!registeredAt) {
		return '';
	}
	const validThrough = new Date(registeredAt);
	validThrough.setFullYear(validThrough.getFullYear() + 1);
	const mm = String(validThrough.getMonth() + 1).padStart(2, '0');
	const dd = String(validThrough.getDate()).padStart(2, '0');
	const yy = String(validThrough.getFullYear()).slice(-2);
	return `${mm}/${dd}/${yy}`;
}

export function RegistrationCard({
	isRegistered,
	draft,
	registeredAt,
	onRegisterNow,
	onUpdateRegistration,
	onHelp,
}: RegistrationCardProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	if (!isRegistered) {
		return (
			<View style={[globalStyles.cardSurface, styles.brandCard, {backgroundColor: colors.registerNegative}]}>
				<Text
					style={[
						styles.heading,
						{
							color: colors.light,
							fontFamily: fonts.bold.fontFamily,
							fontWeight: fonts.bold.fontWeight,
							fontSize: typeScale.h4.fontSize,
							lineHeight: typeScale.h4.lineHeight,
						},
					]}>
					{t('notRegistered.heading')}
				</Text>
				<Text
					style={[
						styles.body,
						{
							color: colors.light,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{t('notRegistered.body')}{' '}
					<Text testID="registration-card-help" onPress={onHelp}>
						<FontAwesome6 name="circle-question" size={15} color={colors.light} />
					</Text>
				</Text>
				<Pressable
					testID="registration-card-register-now"
					onPress={onRegisterNow}
					style={[styles.actionButton, styles.translucentButton, {borderRadius: radii.pill}]}>
					<Text
						style={[
							styles.actionLabel,
							{color: colors.light, fontFamily: fonts.medium.fontFamily, fontWeight: fonts.medium.fontWeight},
						]}>
						{t('notRegistered.cta')}
					</Text>
				</Pressable>
			</View>
		);
	}

	const fullName = `${draft.firstName} ${draft.lastName}`.trim();
	const validThrough = computeValidThrough(registeredAt);
	const partyLabel = draft.party ? t('form.party.' + draft.party) : '';
	// Only render the identity line once the draft carries real data — otherwise the
	// interpolated template collapses to a stray ": " separator (e.g. the dev toggle,
	// which flips isRegistered without populating a draft).
	const hasIdentity = fullName.length > 0 || partyLabel.length > 0 || draft.dob.length > 0;

	return (
		<View>
			<View style={[globalStyles.cardSurface, styles.brandCard, {backgroundColor: colors.registerPositive}]}>
				<Text
					style={[
						styles.heading,
						{
							color: colors.light,
							fontFamily: fonts.bold.fontFamily,
							fontWeight: fonts.bold.fontWeight,
							fontSize: typeScale.h4.fontSize,
							lineHeight: typeScale.h4.lineHeight,
						},
					]}>
					{t('registered.heading')}
				</Text>
				<Text
					style={[
						styles.body,
						{
							color: colors.light,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{t('registered.body')}
				</Text>
				{hasIdentity ? (
					<Text
						testID="registration-card-identity-line"
						style={[
							styles.identityLine,
							{
								color: colors.light,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('registered.identityLine', {fullName, party: partyLabel, dob: draft.dob})}
					</Text>
				) : null}
				<View
					style={[
						styles.validThroughBadge,
						{backgroundColor: colors.validBadge, borderRadius: radii.pill},
					]}>
					<Text
						testID="registration-card-valid-through"
						style={[
							styles.validThroughText,
							{
								color: colors.light,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.caption.fontSize,
								lineHeight: typeScale.caption.lineHeight,
							},
						]}>
						{t('registered.validThrough', {validThrough})}
					</Text>
				</View>
			</View>

			<View style={[globalStyles.cardSurface, styles.updateBlock, {backgroundColor: colors.secondaryButtonSurface}]}>
				<View style={styles.updatePromptRow}>
					<Pressable testID="registration-card-help" onPress={onHelp} hitSlop={8}>
						<FontAwesome6 name="circle-question" size={22} color={colors.text} />
					</Pressable>
					<Text
						style={[
							styles.updatePrompt,
							{
								color: colors.text,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('registered.updatePrompt')}
					</Text>
				</View>
				<Pressable
					testID="registration-card-update"
					onPress={onUpdateRegistration}
					style={[styles.actionButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text
						style={[
							styles.actionLabel,
							{color: colors.light, fontFamily: fonts.medium.fontFamily, fontWeight: fonts.medium.fontWeight},
						]}>
						{t('registered.updateCta')}
					</Text>
				</Pressable>
			</View>
		</View>
	);
}

export default RegistrationCard;

const styles = StyleSheet.create({
	brandCard: {
		paddingVertical: 20,
		paddingHorizontal: 20,
	},
	heading: {
		marginBottom: 8,
	},
	body: {
		marginTop: 8,
	},
	identityLine: {
		marginTop: 16,
	},
	validThroughBadge: {
		marginTop: 16,
		alignSelf: 'flex-end',
		paddingVertical: 6,
		paddingHorizontal: 14,
	},
	validThroughText: {},
	updateBlock: {
		marginTop: 16,
		paddingVertical: 20,
		paddingHorizontal: 20,
	},
	updatePromptRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
	},
	updatePrompt: {
		flex: 1,
	},
	translucentButton: {
		backgroundColor: 'rgba(255, 255, 255, 0.25)',
	},
	actionButton: {
		marginTop: 20,
		minHeight: 48,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 12,
	},
	actionLabel: {
		textAlign: 'center',
	},
});
