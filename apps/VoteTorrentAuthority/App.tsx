import React, { useEffect } from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18n from './src/i18n';
import {RootNavigator} from './src/navigation';
import {BallotDraftProvider} from './src/screens/ballots/providers/BallotDraftProvider';
import {darkTheme, lightTheme} from './src/theme/themes';
import {StatusBar, useColorScheme} from 'react-native';
import {AppProvider} from './src/providers/AppProvider';
import {CadreNodeProvider} from './src/providers/CadreNodeProvider';
import {SettingsProvider} from './src/providers/SettingsProvider';
import {ToastProvider} from './src/components/Toast';

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
			{/* Edge-to-edge (targetSdk 35) draws the status bar over the app header, and the
			    AppCompat theme never requests dark icons — so without this the clock and
			    battery are white-on-white on every light screen. */}
			<StatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />
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
						{/* Inside NavigationContainer: the toast reads the theme. */}
						<ToastProvider>
							<RootNavigator />
						</ToastProvider>
					</BallotDraftProvider>
				</NavigationContainer>
			</AppProvider>
			</CadreNodeProvider>
			</SettingsProvider>
		</SafeAreaProvider>
	);
}
