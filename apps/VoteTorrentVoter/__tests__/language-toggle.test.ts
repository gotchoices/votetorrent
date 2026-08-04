/**
 * Language-toggle AsyncStorage/i18n round-trip test (I18N-02 automatable half, D-13).
 *
 * Drives the relocated `handleLanguageChange` handler (src/screens/settings/SettingsScreen.tsx)
 * directly against the async-storage jest mock (wired in jest.config.js, 39-01) and the real
 * i18next instance, proving the toggle persists under the literal 'appLanguage' key (no rename)
 * and switches the active language. The full relaunch-persistence check (App.tsx's boot-restore
 * effect reading the same key on a fresh process) remains a device checkpoint in 39-09 — a single
 * Jest process cannot restart the app.
 *
 * Written as .ts (not .tsx) — no JSX needed; the handler is exercised directly rather than via
 * a rendered component tree.
 *
 * `@react-navigation/native` is mocked (mirrors Authority's screen-test pattern, e.g.
 * NetworksScreen.bootstrap.test.tsx) purely so importing SettingsScreen.tsx doesn't pull in the
 * package's real `lib/module` ESM build, which the RN Jest preset's transformIgnorePatterns
 * doesn't allow-list. `useTheme` is never invoked here — this test drives `handleLanguageChange`
 * directly, not the rendered component.
 *
 * Phase 44-07 (D-02/D-04): `providers/VoterAppProvider` is also mocked (manual Jest mock at
 * `src/providers/__mocks__/VoterAppProvider.tsx`) so importing `SettingsScreen.tsx` (which calls
 * `useVoterApp()`) doesn't transitively pull in the real `CadreNodeProvider` (real
 * `@serfab/cadre-core` + `@optimystic/db-p2p-storage-rn`, ESM-only native deps this Jest RN
 * environment cannot resolve).
 */
jest.mock('@react-navigation/native', () => ({
	useTheme: () => ({colors: {}, fonts: {}, type: {}, radii: {}}),
}));
jest.mock('../src/providers/VoterAppProvider');

import AsyncStorage from '@react-native-async-storage/async-storage';
import i18n from '../src/i18n';
import {handleLanguageChange} from '../src/screens/settings/SettingsScreen';

describe('language-toggle AsyncStorage round-trip (I18N-02, D-13)', () => {
	afterEach(async () => {
		jest.clearAllMocks();
		// Reset shared i18n/AsyncStorage singletons so test order can't leak state.
		await i18n.changeLanguage('en');
		await AsyncStorage.removeItem('appLanguage');
	});

	it('AsyncStorage.setItem is called with the literal "appLanguage" key and the chosen language code', async () => {
		await handleLanguageChange('es');

		expect(AsyncStorage.setItem).toHaveBeenCalledWith('appLanguage', 'es');
	});

	it('i18n.changeLanguage is called with the chosen language code, and i18n.language reflects it', async () => {
		const changeLanguageSpy = jest.spyOn(i18n, 'changeLanguage');

		await handleLanguageChange('es');

		expect(changeLanguageSpy).toHaveBeenCalledWith('es');
		expect(i18n.language).toBe('es');
	});

	it('round-trips through AsyncStorage — a subsequent getItem resolves to the persisted value', async () => {
		await handleLanguageChange('es');

		const stored = await AsyncStorage.getItem('appLanguage');
		expect(stored).toBe('es');
	});
});
