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
			// Phase 40 (HOME-01/02/03) — flat dotted keys (property names literally contain
			// dots), required by `keySeparator: false` below. See i18n-parity.test.ts (D-14):
			// walking Object.keys(namespace) shallowly gives full per-key EN/ES coverage only
			// when keys stay flat — a nested { states: { open: {...} } } object would leave
			// sub-keys unchecked and silently break lockstep.
			voteNowCta: 'Vote now',
			learnAboutElection: 'Learn about this election',
			'progressLabel': '{{percent}}% complete',
			'countdown.hours': 'hours',
			'countdown.minutes': 'minutes',
			'countdown.seconds': 'seconds',
			validationDetailsTitle: 'Validation Details',
			'states.upcoming.summary':
				"Voting hasn't opened yet — check back when the polls open.",
			'states.open.summary': 'Cast your vote before the polls close.',
			// [ASSUMED] RESEARCH Pitfall 4/A1 — no dedicated Home-card Figma frame for
			// ReviewSelections; non-canonical placeholder copy, safe to revise later.
			'states.reviewSelections.summary': 'Continue reviewing your ballot selections.',
			'states.releasingKeys.summary': '{{released}}/{{total}} election keys released.',
			'states.validation.summary':
				'Validation status {{checksComplete}}/{{checksTotal}} checks.',
			'states.validationDetails.summary':
				'Validation status {{checksComplete}}/{{checksTotal}} checks — view the full evidence.',
			// [ASSUMED] RESEARCH A2 — no exact compact-card CTA string documented in the
			// extract; authored to match the drill-in screen's own title 1:1.
			'states.validationDetails.cta': 'View Validation Details',
			'states.complete.summary': 'Certified ✓',
			'validationDetails.columnCheck': 'Check',
			'validationDetails.columnResult': 'Result',
			'validationDetails.columnTime': 'Time',
			'validationDetails.columnStatus': 'Status',
			'validationDetails.overallCount': '{{verified}}/{{total}} checks verified',
			'validationDetails.fingerprintLabel': 'Fingerprint',
			'validationDetails.recordedInBlockchain':
				'Validation report recorded in blockchain',
			'validationDetails.verified': 'Verified',
			'validationDetails.pending': 'Pending',
			'validationDetails.check1.name': 'Search for voter record',
			'validationDetails.check1.result': 'Voter record found',
			'validationDetails.check2.name': 'Verify voter record',
			'validationDetails.check2.result': 'IDs match',
			'validationDetails.check3.name': 'Check election integrity',
			'validationDetails.check3.result': 'Adjacent blocks and tree path verified',
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
			voteNowCta: 'Votar ahora',
			learnAboutElection: 'Conoce más sobre esta elección',
			'progressLabel': '{{percent}}% completado',
			'countdown.hours': 'horas',
			'countdown.minutes': 'minutos',
			'countdown.seconds': 'segundos',
			validationDetailsTitle: 'Detalles de Validación',
			'states.upcoming.summary':
				'La votación aún no ha comenzado — vuelve cuando se abran las urnas.',
			'states.open.summary': 'Emite tu voto antes de que cierren las urnas.',
			// [ASSUMED] RESEARCH Pitfall 4/A1 — see EN comment above.
			'states.reviewSelections.summary':
				'Continúa revisando tus selecciones de la boleta.',
			'states.releasingKeys.summary': '{{released}}/{{total}} claves de elección liberadas.',
			'states.validation.summary':
				'Estado de validación {{checksComplete}}/{{checksTotal}} verificaciones.',
			'states.validationDetails.summary':
				'Estado de validación {{checksComplete}}/{{checksTotal}} verificaciones — ver toda la evidencia.',
			// [ASSUMED] RESEARCH A2 — see EN comment above.
			'states.validationDetails.cta': 'Ver Detalles de Validación',
			'states.complete.summary': 'Certificada ✓',
			'validationDetails.columnCheck': 'Verificación',
			'validationDetails.columnResult': 'Resultado',
			'validationDetails.columnTime': 'Tiempo',
			'validationDetails.columnStatus': 'Estado',
			'validationDetails.overallCount': '{{verified}}/{{total}} verificaciones completadas',
			'validationDetails.fingerprintLabel': 'Huella digital',
			'validationDetails.recordedInBlockchain':
				'Informe de validación registrado en la cadena de bloques',
			'validationDetails.verified': 'Verificado',
			'validationDetails.pending': 'Pendiente',
			'validationDetails.check1.name': 'Buscar registro de votante',
			'validationDetails.check1.result': 'Registro de votante encontrado',
			'validationDetails.check2.name': 'Verificar registro de votante',
			'validationDetails.check2.result': 'Las identificaciones coinciden',
			'validationDetails.check3.name': 'Verificar la integridad de la elección',
			'validationDetails.check3.result':
				'Bloques adyacentes y ruta del árbol verificados',
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
	// Phase 40 (D-12 lockstep / D-14 parity coverage) — `home.*` keys are authored as FLAT
	// dotted-string property names (e.g. 'states.open.summary'), not nested objects. With the
	// i18next default '.' keySeparator, a flat key like 'states.open.summary' would be
	// misinterpreted as a nested path ({ states: { open: { summary } } }) and fail to resolve at
	// runtime. Existing single-segment keys (headerTitle, tabVote, etc.) are unaffected.
	keySeparator: false,
	interpolation: {
		escapeValue: false,
	},
});

export {resources};
export default i18n;
