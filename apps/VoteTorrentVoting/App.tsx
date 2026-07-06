/**
 * VoteTorrent Voting app — entry component.
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {
	SafeAreaView,
	StyleSheet,
	Text,
	TouchableOpacity,
	useColorScheme,
	View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useTranslation} from 'react-i18next';
import i18n from './src/i18n';

type LanguageCode = 'en' | 'es';

const LANGUAGES: {code: LanguageCode; labelKey: 'english' | 'spanish'}[] = [
	{code: 'en', labelKey: 'english'},
	{code: 'es', labelKey: 'spanish'},
];

function App(): React.JSX.Element {
	const isDarkMode = useColorScheme() === 'dark';
	const {t} = useTranslation();
	const [currentLang, setCurrentLang] = useState<LanguageCode>(
		i18n.language?.startsWith('es') ? 'es' : 'en',
	);

	// Restore the persisted language selection on boot, mirroring the Authority
	// app's App.tsx behavior.
	useEffect(() => {
		AsyncStorage.getItem('appLanguage').then(lang => {
			if (lang && lang !== i18n.language) {
				i18n.changeLanguage(lang);
			}
		});
	}, []);

	// Keep the local selection in sync if the language changes anywhere.
	useEffect(() => {
		const handler = (lang: string) =>
			setCurrentLang(lang.startsWith('es') ? 'es' : 'en');
		i18n.on('languageChanged', handler);
		return () => i18n.off('languageChanged', handler);
	}, []);

	const handleLanguageChange = async (lang: LanguageCode) => {
		await i18n.changeLanguage(lang);
		await AsyncStorage.setItem('appLanguage', lang);
		setCurrentLang(lang);
	};

	return (
		<SafeAreaView
			style={[styles.container, isDarkMode ? styles.dark : styles.light]}>
			<View style={styles.content}>
				<Text
					style={[
						styles.title,
						isDarkMode ? styles.textDark : styles.textLight,
					]}>
					{t('appTitle')}
				</Text>
				<Text
					style={[
						styles.subtitle,
						isDarkMode ? styles.textDark : styles.textLight,
					]}>
					{t('appSubtitle')}
				</Text>

				<View style={styles.pickerSection}>
					<Text
						style={[
							styles.pickerLabel,
							isDarkMode ? styles.textDark : styles.textLight,
						]}>
						{t('language')}
					</Text>
					<View style={styles.pickerRow}>
						{LANGUAGES.map(lang => {
							const selected = currentLang === lang.code;
							return (
								<TouchableOpacity
									key={lang.code}
									accessibilityRole="button"
									accessibilityState={{selected}}
									onPress={() => handleLanguageChange(lang.code)}
									style={[
										styles.langButton,
										selected
											? styles.langButtonSelected
											: styles.langButtonUnselected,
									]}>
									<Text
										style={[
											styles.langButtonText,
											selected
												? styles.langButtonTextSelected
												: isDarkMode
												? styles.textDark
												: styles.textLight,
										]}>
										{t(lang.labelKey)}
									</Text>
								</TouchableOpacity>
							);
						})}
					</View>
					<Text
						style={[
							styles.hint,
							isDarkMode ? styles.textDark : styles.textLight,
						]}>
						{t('languageHint')}
					</Text>
				</View>
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	light: {
		backgroundColor: '#ffffff',
	},
	dark: {
		backgroundColor: '#000000',
	},
	content: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
	title: {
		fontSize: 24,
		fontWeight: '700',
		textAlign: 'center',
	},
	subtitle: {
		marginTop: 12,
		fontSize: 16,
		textAlign: 'center',
	},
	pickerSection: {
		marginTop: 40,
		alignItems: 'center',
	},
	pickerLabel: {
		fontSize: 14,
		fontWeight: '600',
		textTransform: 'uppercase',
		letterSpacing: 1,
		marginBottom: 12,
	},
	pickerRow: {
		flexDirection: 'row',
		gap: 12,
	},
	langButton: {
		paddingVertical: 10,
		paddingHorizontal: 20,
		borderRadius: 8,
		borderWidth: 1,
	},
	langButtonSelected: {
		backgroundColor: '#2563eb',
		borderColor: '#2563eb',
	},
	langButtonUnselected: {
		backgroundColor: 'transparent',
		borderColor: '#888888',
	},
	langButtonText: {
		fontSize: 16,
		fontWeight: '600',
	},
	langButtonTextSelected: {
		color: '#ffffff',
	},
	hint: {
		marginTop: 16,
		fontSize: 13,
		textAlign: 'center',
		opacity: 0.7,
		maxWidth: 260,
	},
	textLight: {
		color: '#111111',
	},
	textDark: {
		color: '#f5f5f5',
	},
});

export default App;
