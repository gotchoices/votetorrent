/**
 * RegisterFormHeader (REG-03) — the full-bleed in-content chrome shared by the 3 register form
 * steps. The native stack header (title + shadow) is removed (headerShown:false in the navigator);
 * this renders the Figma register header instead: a large centered title + subtitle + StepDots.
 *
 * Control placement per user direction (post-QA): a back-arrow icon TOP-LEFT (goes back one step)
 * and the close (X) icon TOP-RIGHT (exits the whole registration flow). Presentational-only — the
 * caller supplies onBack/onClose; no useNavigation() here.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {StepDots} from './StepDots';

export interface RegisterFormHeaderProps {
	title: string;
	subtitle: string;
	step: 1 | 2 | 3;
	onBack: () => void;
	onClose: () => void;
}

export function RegisterFormHeader({title, subtitle, step, onBack, onClose}: RegisterFormHeaderProps) {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');
	const {t: tCommon} = useTranslation('common');

	return (
		<View>
			<View style={styles.bar}>
				<Pressable
					testID="register-back"
					onPress={onBack}
					hitSlop={8}
					style={styles.iconButton}
					accessibilityRole="button"
					accessibilityLabel={t('form.backCta')}>
					<FontAwesome6 name="arrow-left" size={22} color={colors.text} />
				</Pressable>
				<Pressable
					testID="register-close"
					onPress={onClose}
					hitSlop={8}
					style={styles.iconButton}
					accessibilityRole="button"
					accessibilityLabel={tCommon('close')}>
					<FontAwesome6 name="xmark" size={22} color={colors.text} />
				</Pressable>
			</View>

			<Text
				style={[
					styles.title,
					{
						color: colors.text,
						fontFamily: fonts.bold.fontFamily,
						fontWeight: fonts.bold.fontWeight,
						fontSize: typeScale.h2.fontSize,
						lineHeight: typeScale.h2.lineHeight,
					},
				]}>
				{title}
			</Text>
			<Text
				style={[
					styles.subtitle,
					{
						color: colors.textSecondary,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					},
				]}>
				{subtitle}
			</Text>

			<View style={styles.dots}>
				<StepDots step={step} />
			</View>
		</View>
	);
}

export default RegisterFormHeader;

const styles = StyleSheet.create({
	bar: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		minHeight: 44,
	},
	iconButton: {
		padding: 8,
		marginHorizontal: -8, // optically align the glyph to the screen edge padding
	},
	title: {
		textAlign: 'center',
		marginTop: 8,
	},
	subtitle: {
		textAlign: 'center',
		marginTop: 4,
	},
	dots: {
		marginTop: 16,
	},
});
