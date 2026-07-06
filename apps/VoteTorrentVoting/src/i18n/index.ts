import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {getLocales} from 'react-native-localize';

// Mirrors the Authority app's i18n setup (apps/VoteTorrentAuthority/src/i18n).
// Keys are a small starter set the Voting app can grow — the language picker
// on the home screen exists so this wiring can be verified end-to-end.
const resources = {
	en: {
		translation: {
			appTitle: 'Hello, VoteTorrent Voting!',
			appSubtitle: 'The voting app is up and running.',
			language: 'Language',
			english: 'English',
			spanish: 'Spanish',
			languageHint: 'Pick a language to confirm translations switch live.',
		},
	},
	es: {
		translation: {
			appTitle: '¡Hola, VoteTorrent Voting!',
			appSubtitle: 'La aplicación de votación está funcionando.',
			language: 'Idioma',
			english: 'Inglés',
			spanish: 'Español',
			languageHint: 'Elige un idioma para confirmar que las traducciones cambian al instante.',
		},
	},
};

const deviceLanguage = getLocales()[0]?.languageCode ?? 'en';

i18n.use(initReactI18next).init({
	resources: resources,
	lng: deviceLanguage,
	fallbackLng: 'en',
	interpolation: {
		escapeValue: false,
	},
});

export {resources};
export default i18n;
