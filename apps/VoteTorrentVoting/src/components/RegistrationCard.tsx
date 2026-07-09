/**
 * RegistrationCard (REG-01/REG-05) — the single presentational card that branches across the
 * not-registered / registered states, driven by the `isRegistered` prop (mirrors ElectionCard's
 * `STATE_DISPLAY`-lookup discipline, but here a simple boolean branch — only 2 states, not 7).
 *
 * Pure presentational (`isRegistered`/`draft`/`registeredAt` props + callback props) — does NOT
 * call `useVotingApp()` or `useNavigation()` (RESEARCH.md Anti-Patterns / this plan's
 * presentational-component constraint), so both states are unit-testable directly with fixture
 * props, no provider/navigator required. `RegistrationScreen` (41-08) owns the provider/draft
 * reads and maps these callbacks to real navigation.
 *
 * D-06 form→card loop: the registered variant's identity line is interpolated from the passed
 * `draft` (not static placeholder copy), and its valid-through badge is a computed mock date
 * FROZEN from `registeredAt` (41-RESEARCH.md Pattern 3) — `computeValidThrough` parses
 * `registeredAt` once and adds 1 year, so the badge does not silently drift across re-renders as
 * "today + 1 year" would (RESEARCH Anti-Patterns).
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

/**
 * Parses `registeredAt`, adds 1 year (native `Date.setFullYear`, no date library — RESEARCH
 * "Don't Hand-Roll" explicitly rejects pulling in date-fns/dayjs for one computation), and
 * formats as `MM/DD/YY`. Frozen from the passed `registeredAt` — never recomputed as
 * "today + 1 year" (that would drift on every render, RESEARCH Anti-Patterns).
 */
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
			<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
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
					{t('notRegistered.heading')}
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
					{t('notRegistered.body')}
				</Text>
				<Pressable
					testID="registration-card-register-now"
					onPress={onRegisterNow}
					style={[styles.actionButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.actionLabel, {color: colors.light}]}>{t('notRegistered.cta')}</Text>
				</Pressable>
			</View>
		);
	}

	const fullName = `${draft.firstName} ${draft.lastName}`.trim();
	const validThrough = computeValidThrough(registeredAt);

	return (
		<View>
			<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
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
					{t('registered.heading')}
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
					{t('registered.body')}
				</Text>
				<Text
					testID="registration-card-identity-line"
					style={[
						styles.identityLine,
						{
							color: colors.text,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{t('registered.identityLine', {fullName, party: draft.party, dob: draft.dob})}
				</Text>
				<View
					style={[
						styles.validThroughBadge,
						{backgroundColor: colors.secondaryButtonSurface, borderRadius: radii.pill},
					]}>
					<Text
						testID="registration-card-valid-through"
						style={[
							styles.validThroughText,
							{
								color: colors.textSecondary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.caption.fontSize,
								lineHeight: typeScale.caption.lineHeight,
							},
						]}>
						{t('registered.validThrough', {validThrough})}
					</Text>
				</View>
			</View>

			<View style={[globalStyles.cardSurface, styles.updateBlock, {backgroundColor: colors.card}]}>
				<Pressable testID="registration-card-help" onPress={onHelp} style={styles.helpIcon}>
					<FontAwesome6 name="circle-question" size={16} color={colors.muted} />
				</Pressable>
				<Text
					style={[
						styles.body,
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
				<Pressable
					testID="registration-card-update"
					onPress={onUpdateRegistration}
					style={[
						styles.actionButton,
						styles.actionButtonOutline,
						{
							backgroundColor: colors.secondaryButtonSurface,
							borderColor: colors.primary,
							borderRadius: radii.pill,
						},
					]}>
					<Text style={[styles.actionLabel, {color: colors.primary}]}>{t('registered.updateCta')}</Text>
				</Pressable>
			</View>
		</View>
	);
}

export default RegistrationCard;

const styles = StyleSheet.create({
	heading: {
		marginBottom: 8, // sm spacing token
	},
	body: {
		marginTop: 16, // md spacing token
	},
	identityLine: {
		marginTop: 24, // lg spacing token
	},
	validThroughBadge: {
		marginTop: 8, // sm spacing token
		alignSelf: 'flex-start',
		paddingVertical: 4,
		paddingHorizontal: 12,
	},
	validThroughText: {},
	updateBlock: {
		marginTop: 24, // lg spacing token
	},
	helpIcon: {
		position: 'absolute',
		top: 16,
		right: 16,
		zIndex: 1,
	},
	actionButton: {
		marginTop: 24, // lg spacing token
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	actionButtonOutline: {
		borderWidth: 1,
		marginTop: 16, // md spacing token (per UI-SPEC block 2)
	},
	actionLabel: {
		fontWeight: '600',
	},
});
