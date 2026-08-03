import React, { useEffect } from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18n from './src/i18n';
import {RootNavigator} from './src/navigation';
import {BallotDraftProvider} from './src/screens/ballots/providers/BallotDraftProvider';
import {darkTheme, lightTheme} from './src/theme/themes';
import {useColorScheme} from 'react-native';
import {AppProvider} from './src/providers/AppProvider';
import {CadreNodeProvider} from './src/providers/CadreNodeProvider';
import {SettingsProvider} from './src/providers/SettingsProvider';

export default function App() {
	const colorScheme = useColorScheme();

	// Phase 11 plan 11-02 (D-02) — restore persisted language on boot
	useEffect(() => {
		AsyncStorage.getItem('appLanguage').then((lang) => {
			if (lang && lang !== i18n.language) {
				i18n.changeLanguage(lang as string);
			}
		});
	}, []);

	return (
		<SafeAreaProvider>
			<SettingsProvider>
			<CadreNodeProvider>
			<AppProvider>
				<NavigationContainer
					theme={colorScheme === 'dark' ? darkTheme : lightTheme}>
					{/* BallotDraftProvider hoisted above the navigator so the ballot
					    draft is genuinely shared across CreateBallot/EditBallot/
					    EditQuestion/EditQuestionOption. Per-flow reset happens on
					    CreateBallot mount (fresh) and EditBallot load (from engine). */}
					<BallotDraftProvider>
						<RootNavigator />
					</BallotDraftProvider>
				</NavigationContainer>
			</AppProvider>
			</CadreNodeProvider>
			</SettingsProvider>
		</SafeAreaProvider>
	);
}
