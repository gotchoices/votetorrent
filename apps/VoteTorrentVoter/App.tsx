/**
 * VoteTorrent Voting app — entry component.
 *
 * Bootstrap (39-09/44-07, D-17/D-04): SafeAreaProvider → CadreNodeProvider → VoterAppProvider →
 * NavigationContainer (Phase 38 light/dark ExtendedTheme) → RootNavigator. Phase 44-07 mounts
 * `CadreNodeProvider` as the parent of `VoterAppProvider` (mirroring the authority app's
 * `App.tsx`) — the rewritten `VoterAppProvider` now calls `useCadreNode()` in its body and
 * throws "must be used within a CadreNodeProvider" without this wrapper, so the real composition
 * root could never boot. The scratch inline language-picker demo that lived here through 39-08 is
 * retired — language selection now lives in 39-06's SettingsScreen. The boot-restore effect (read
 * persisted `appLanguage` on launch) is retained verbatim; mirrors the Authority app's App.tsx
 * pattern (39-RESEARCH.md Pattern 4).
 *
 * @format
 */

import React, {useEffect} from 'react';
import {useColorScheme} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18n from './src/i18n';
import {RootNavigator} from './src/navigation';
import {VoterAppProvider} from './src/providers/VoterAppProvider';
import {CadreNodeProvider} from './src/providers/CadreNodeProvider';
import {darkTheme, lightTheme} from './src/theme/themes';

function App(): React.JSX.Element {
	const isDarkMode = useColorScheme() === 'dark';

	// Restore the persisted language selection on boot, mirroring the Authority
	// app's App.tsx behavior. The write half (AsyncStorage.setItem + i18n.changeLanguage)
	// now lives in 39-06's SettingsScreen.
	useEffect(() => {
		AsyncStorage.getItem('appLanguage').then(lang => {
			if (lang && lang !== i18n.language) {
				i18n.changeLanguage(lang);
			}
		});
	}, []);

	return (
		<SafeAreaProvider>
			<CadreNodeProvider>
				<VoterAppProvider>
					<NavigationContainer theme={isDarkMode ? darkTheme : lightTheme}>
						<RootNavigator />
					</NavigationContainer>
				</VoterAppProvider>
			</CadreNodeProvider>
		</SafeAreaProvider>
	);
}

export default App;
