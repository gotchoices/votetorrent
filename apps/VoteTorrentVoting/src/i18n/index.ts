import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {getLocales} from 'react-native-localize';

// Feature-namespaced resource tree (D-11) — a deliberate, documented improvement over
// Authority's single flat ~48KB `translation` namespace. Each namespace stays co-located
// with the flow that owns it, so later phases only touch the namespace they're building.
// Shell-only starter key set (D-12) seeded EN+ES in lockstep (I18N-01) from the
// 39-UI-SPEC.md Copywriting Contract — this `resources` export is the source of truth the
// 39-08 namespace-aware parity test walks.
const resources = {
	en: {
		common: {
			tabVote: 'Vote',
			tabRegistration: 'Registration',
			tabScan: 'Scan',
			tabSettings: 'Settings',
			placeholderBody: "This screen isn't built yet — check back in a future update.",
			close: 'Close',
		},
		home: {
			headerTitle: 'Vote',
			electionInfoTitle: 'About This Election',
		},
		ballot: {
			headerTitle: 'Ballot',
			individualQuestionTitle: 'Individual Question',
			officeInfoTitle: 'About This Office',
			candidateInfoTitle: 'About This Candidate',
		},
		registration: {
			headerTitle: 'Registration',
			deviceAttestationTitle: 'Verifying Your Device',
			confirmationTitle: "You're All Set",
		},
		scan: {
			headerTitle: 'Scan',
		},
		settings: {
			headerTitle: 'Settings',
			language: 'Language',
			// Endonyms in both locales (mobile-locale-picker convention) — a user who can't
			// read the current UI language can still recognize their own language's name.
			languageEnglish: 'English',
			languageSpanish: 'Español',
		},
	},
	es: {
		common: {
			tabVote: 'Votar',
			tabRegistration: 'Registro',
			tabScan: 'Escanear',
			tabSettings: 'Ajustes',
			placeholderBody: 'Esta pantalla aún no está lista — vuelve a consultar más adelante.',
			close: 'Cerrar',
		},
		home: {
			headerTitle: 'Votar',
			electionInfoTitle: 'Sobre Esta Elección',
		},
		ballot: {
			headerTitle: 'Boleta',
			individualQuestionTitle: 'Pregunta Individual',
			officeInfoTitle: 'Sobre Este Cargo',
			candidateInfoTitle: 'Sobre Este Candidato',
		},
		registration: {
			headerTitle: 'Registro',
			deviceAttestationTitle: 'Verificando Tu Dispositivo',
			confirmationTitle: 'Todo Listo',
		},
		scan: {
			headerTitle: 'Escanear',
		},
		settings: {
			headerTitle: 'Ajustes',
			language: 'Idioma',
			// Endonyms in both locales (mobile-locale-picker convention).
			languageEnglish: 'English',
			languageSpanish: 'Español',
		},
	},
};

const deviceLanguage = getLocales()[0]?.languageCode ?? 'en';

i18n.use(initReactI18next).init({
	resources: resources,
	ns: Object.keys(resources.en),
	defaultNS: 'common',
	lng: deviceLanguage,
	fallbackLng: 'en',
	interpolation: {
		escapeValue: false,
	},
});

export {resources};
export default i18n;
