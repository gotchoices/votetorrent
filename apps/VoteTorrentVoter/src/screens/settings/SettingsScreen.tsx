/**
 * SettingsScreen — Settings tab root (D-07 per-domain screen file). The one real interactive
 * control this phase ships: a 2-segment language toggle (English/Español endonyms) that
 * switches EN/ES live and persists the choice to AsyncStorage('appLanguage') (I18N-02, D-13).
 *
 * The on-change handler is RELOCATED verbatim from Voting's scratch `App.tsx` (RESEARCH Pattern
 * 4) — direct AsyncStorage, literal key 'appLanguage' (no rename), NOT routed through a
 * SettingsProvider (Authority's SettingsProvider only manages a `showHelpIcons` boolean). The
 * boot-restore half of the handler (AsyncStorage.getItem on mount) stays in App.tsx, kept as-is
 * through 39-09.
 *
 * `handleLanguageChange` is exported (in addition to the default component export) so the
 * round-trip AsyncStorage/i18n test (`__tests__/language-toggle.test.ts`) can drive it directly
 * without rendering the full screen tree.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {globalStyles} from '../../theme/styles';
import i18n from '../../i18n';

type LanguageCode = 'en' | 'es';

/**
 * Relocated verbatim from App.tsx's `handleLanguageChange` (D-13 / RESEARCH Pattern 4
 * correction): direct AsyncStorage persistence under the literal key 'appLanguage' — NOT
 * routed through a SettingsProvider.
 */
export async function handleLanguageChange(lng: LanguageCode): Promise<void> {
	await i18n.changeLanguage(lng);
	await AsyncStorage.setItem('appLanguage', lng);
}

export default function SettingsScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline mockData import.
	useVoterApp();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('settings');

	// react-i18next's useTranslation() re-renders this component on i18n's 'languageChanged'
	// event by default, so reading i18n.language directly here (no local state) stays in sync.
	const activeLang: LanguageCode = i18n.language?.startsWith('es') ? 'es' : 'en';

	const segments: {code: LanguageCode; label: string}[] = [
		{code: 'en', label: t('languageEnglish')},
		{code: 'es', label: t('languageSpanish')},
	];

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<Text
				style={[
					styles.fieldLabel,
					{
						color: colors.text,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					},
				]}>
				{t('language')}
			</Text>
			<View style={[styles.toggleRow, {borderRadius: radii.pill}]}>
				{segments.map(segment => {
					const selected = segment.code === activeLang;
					return (
						<Pressable
							key={segment.code}
							accessibilityRole="button"
							accessibilityState={{selected}}
							hitSlop={4}
							onPress={() => {
								// Non-destructive, instantly reversible — no confirmation dialog
								// (39-UI-SPEC.md § Settings Language Toggle).
								if (!selected) {
									handleLanguageChange(segment.code);
								}
							}}
							style={[
								styles.segment,
								{
									borderRadius: radii.pill,
									backgroundColor: selected ? colors.primary : colors.secondaryButtonSurface,
								},
							]}>
							<Text
								style={{
									color: selected ? colors.light : colors.textSecondary,
									fontFamily: selected ? fonts.bold.fontFamily : fonts.regular.fontFamily,
									fontWeight: selected ? fonts.bold.fontWeight : fonts.regular.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
								}}>
								{segment.label}
							</Text>
						</Pressable>
					);
				})}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	fieldLabel: {
		marginBottom: 12,
	},
	toggleRow: {
		flexDirection: 'row',
		alignSelf: 'flex-start',
		gap: 8, // separate the two segment pills so they don't read as one merged control
	},
	segment: {
		minHeight: 44,
		paddingHorizontal: 20,
		justifyContent: 'center',
		alignItems: 'center',
	},
});
