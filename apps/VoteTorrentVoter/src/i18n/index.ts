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
			networkName: 'Utah Network',
			notifications: 'Notifications',
			'breadcrumb.home': 'Home',
			'breadcrumb.ballot': 'Ballot',
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
			// "Learn about this election" info dialog (Figma Candidate Info frame, election variant).
			'electionInfo.title': 'Election Info',
			'electionInfo.subtitle': 'Informational Page about this election',
			'electionInfo.body': '"The following information has been provided by the election authority"',
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
			// Phase 42 (VOTE-04/D-08) — the Open card's minimal voted-state reflection: once
			// hasVoted flips true, the "Vote now" CTA becomes this disabled pill instead.
			votedCta: 'You voted',
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
			// Phase 42 (VOTE-01/02/04) — Ballot Page / Individual Question / Review & Submit UI copy.
			'progressLabel': '{{completed}}/{{total}} questions completed',
			'voteForN': 'Vote for {{n}}',
			'saveExitCta': 'Save & Exit',
			'reviewCta': 'Review & Submit Ballot',
			'continueVotingCta': 'Continue Voting',
			'nextCta': 'Next Question',
			'previousCta': 'Previous Question',
			'submitCta': 'Submit',
			'submittedConfirmation': 'Your ballot was submitted',
			'notYetAnswered': 'Not yet answered',
			'learnAboutOffice': 'Learn about this office',
			'learnAboutCandidate': 'Learn about this candidate',
			// "Learn about this …" info dialogs (Figma Candidate Info frame).
			'candidateInfo.title': 'Candidate Info',
			'candidateInfo.subtitle': 'Informational Page about your selected candidate',
			'candidateInfo.body': '"The following information has been provided by the candidate"',
			'officeInfo.title': 'Office Info',
			'officeInfo.subtitle': 'Informational Page about this office',
			'officeInfo.body': '"The following information has been provided by the office"',
			'federalSection': 'Federal',
			'stateSection': 'State (UT)',
			'reviewSubmitTitle': 'Review & Submit',
			// Party labels (D-02/D-03) — own ballot-namespace keys, not a cross-namespace reuse of
			// registration.form.party.* (RESEARCH Pattern 3 — each namespace stays independently
			// ownable, 39 D-11).
			'candidateParty.democratic': 'Democratic Party',
			'candidateParty.republican': 'Republican Party',
			'candidateParty.independent': 'Independent',
			'candidateParty.nonpartisan': 'Nonpartisan',
			// [ASSUMED] mockBallot office titles (mockData.ts) — no fresh Figma pull captured a
			// literal office list this session (42-FIGMA-EXTRACT "What was NOT captured" item 1).
			'office.usSenate': 'U.S. Senate',
			'office.usHouse': 'U.S. House of Representatives, District 2',
			'office.governor': 'Governor',
			'office.stateBoardEducation': 'State Board of Education',
			'office.stateSenate': 'State Senate, District 8',
			// [ASSUMED] mockBallot candidate names (mockData.ts) — proper names, not translated in es.
			'candidate.usSenate.diana': 'Diana Foster',
			'candidate.usSenate.marcus': 'Marcus Whitfield',
			'candidate.usSenate.elena': 'Elena Vasquez',
			'candidate.usHouse.james': 'James Okafor',
			'candidate.usHouse.laura': 'Laura Bennett',
			'candidate.governor.priya': 'Priya Nandan',
			'candidate.governor.robert': 'Robert Kessler',
			'candidate.stateBoardEducation.angela': 'Angela Torres',
			'candidate.stateBoardEducation.brian': 'Brian Michaels',
			'candidate.stateBoardEducation.cynthia': 'Cynthia Park',
			'candidate.stateBoardEducation.david': 'David Nguyen',
			'candidate.stateSenate.maria': 'Maria Gutierrez',
			'candidate.stateSenate.thomas': 'Thomas Reyes',
		},
		registration: {
			headerTitle: 'Registration',
			deviceAttestationTitle: 'Verifying Your Device',
			confirmationTitle: "You're All Set",
			// Phase 41 (REG-01..05) — flat dotted keys, transcribed verbatim from
			// 41-UI-SPEC.md's Copywriting Contract. `[AUTHORED]` strings noted in the
			// contract are marked below for traceability.
			'notRegistered.heading': 'You are not registered',
			'notRegistered.body':
				'To participate in the Utah Network you will need to register',
			'notRegistered.cta': 'Register now',
			'registered.heading': "You're registered to vote",
			'registered.body': 'You have successfully registered for the Utah Network',
			'registered.identityLine': '{{fullName}}: {{party}} {{dob}}',
			'registered.validThrough': 'Valid through {{validThrough}}',
			'registered.updatePrompt':
				'Have you recently made any changes to your personal info?',
			'registered.updateCta': 'Update registration',
			'deviceAttestation.heading': 'Verifying your device...',
			// [AUTHORED]
			'deviceAttestation.caption': 'Confirming your device is secure',
			// [AUTHORED] — Phase 45-06 (D-09) terminal capability-probe wall.
			'deviceAttestation.terminalHeading': "This device can't be used to vote",
			// [AUTHORED]
			'deviceAttestation.terminalBody':
				'This device lacks the secure hardware required to protect a vote, so it cannot be used to register.',
			'form.sectionTitle': 'Register for the Utah Network',
			'form.firstName': 'First Name',
			'form.lastName': 'Last Name',
			'form.dob': 'Date of Birth',
			'form.email': 'Email',
			'form.phone': 'Phone Number',
			// [AUTHORED]
			'form.dobPlaceholder': 'MM/DD/YYYY',
			// [AUTHORED]
			'form.continueCta': 'Continue',
			// [AUTHORED]
			'form.backCta': 'Back',
			// [AUTHORED]
			'form.submitCta': 'Submit',
			// [AUTHORED] — inline field-validation messages (REG-03 validation, added post-QA)
			'form.errors.required': 'This field is required',
			'form.errors.email': 'Enter a valid email address',
			'form.errors.phone': 'Enter a valid phone number',
			'form.errors.dob': 'Enter your date of birth as MM/DD/YYYY',
			'form.errors.party': 'Select your party',
			// [AUTHORED]
			'form.stepLabel': 'Step {{step}} of 3',
			'form.addressLine1': 'Address line 1',
			'form.addressLine2': 'Address line 2 (optional)',
			'form.addressLine3': 'Address line 3 (optional)',
			'form.selectParty': 'Select Your Party',
			// [AUTHORED]
			'form.party.democratic': 'Democratic Party',
			// [AUTHORED]
			'form.party.republican': 'Republican Party',
			// [AUTHORED]
			'form.party.independent': 'Independent',
			// [AUTHORED]
			'form.party.other': 'Other',
			'form.confirmInstruction': 'Check to ensure all information is correct',
			'form.review.fullName': 'Full Name',
			'form.review.dob': 'Date of Birth',
			'form.review.email': 'Email',
			'form.review.phone': 'Phone Number',
			'form.review.party': 'Registered Party',
			'form.review.address': 'Address',
			'confirmation.heading': "You're all set!",
			'confirmation.body': 'Confirm your registration with Face ID',
			// [AUTHORED]
			'confirmation.cta': 'Confirm with Face ID',
			// [AUTHORED]
			'confirmation.caption': 'Look at your device to confirm',
			// [AUTHORED] — Phase 45-06 (D-09) three-way attestation failure UX.
			'confirmation.error.biometricNotEnrolled': 'Set up fingerprint or face unlock to continue',
			// [AUTHORED]
			'confirmation.error.setupCta': 'Set up device unlock',
			// [AUTHORED]
			'confirmation.error.transient': 'Something went wrong verifying your device. Try again.',
			// [AUTHORED]
			'confirmation.error.terminal': "This device can't be used to vote",
			// [AUTHORED] — native-stack header titles for the form-step routes (41-08).
			formHeaderTitle: 'Register',
			confirmHeaderTitle: 'Confirm',
		},
		scan: {
			headerTitle: 'Scan',
			// [AUTHORED] — branded "not available yet" placeholder copy (43-01, SCAN-01/I18N-01).
			notAvailableTitle: 'QR scanning coming soon',
			notAvailableBody: "QR code scanning isn't available yet — it's coming in a future update.",
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
			networkName: 'Utah Network',
			notifications: 'Notificaciones',
			'breadcrumb.home': 'Inicio',
			'breadcrumb.ballot': 'Papeleta',
		},
		home: {
			headerTitle: 'Votar',
			electionInfoTitle: 'Sobre Esta Elección',
			voteNowCta: 'Votar ahora',
			learnAboutElection: 'Conoce más sobre esta elección',
			// "Learn about this election" info dialog (Figma Candidate Info frame, election variant).
			'electionInfo.title': 'Información de la elección',
			'electionInfo.subtitle': 'Página informativa sobre esta elección',
			'electionInfo.body': '"La siguiente información ha sido proporcionada por la autoridad electoral"',
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
			votedCta: 'Ya votaste',
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
			'progressLabel': '{{completed}}/{{total}} preguntas completadas',
			'voteForN': 'Vote por {{n}}',
			'saveExitCta': 'Guardar y salir',
			'reviewCta': 'Revisar y enviar boleta',
			'continueVotingCta': 'Continuar votando',
			'nextCta': 'Siguiente pregunta',
			'previousCta': 'Pregunta anterior',
			'submitCta': 'Enviar',
			'submittedConfirmation': 'Tu boleta fue enviada',
			'notYetAnswered': 'Aún no respondido',
			'learnAboutOffice': 'Conoce más sobre este cargo',
			'learnAboutCandidate': 'Conoce más sobre este candidato',
			// "Learn about this …" info dialogs (Figma Candidate Info frame).
			'candidateInfo.title': 'Información del candidato',
			'candidateInfo.subtitle': 'Página informativa sobre el candidato seleccionado',
			'candidateInfo.body': '"La siguiente información ha sido proporcionada por el candidato"',
			'officeInfo.title': 'Información del cargo',
			'officeInfo.subtitle': 'Página informativa sobre este cargo',
			'officeInfo.body': '"La siguiente información ha sido proporcionada por el cargo"',
			'federalSection': 'Federal',
			'stateSection': 'Estatal (UT)',
			'reviewSubmitTitle': 'Revisar y enviar',
			'candidateParty.democratic': 'Partido Demócrata',
			'candidateParty.republican': 'Partido Republicano',
			'candidateParty.independent': 'Independiente',
			'candidateParty.nonpartisan': 'No partidista',
			'office.usSenate': 'Senado de EE. UU.',
			'office.usHouse': 'Cámara de Representantes de EE. UU., Distrito 2',
			'office.governor': 'Gobernador/a',
			'office.stateBoardEducation': 'Junta Estatal de Educación',
			'office.stateSenate': 'Senado Estatal, Distrito 8',
			'candidate.usSenate.diana': 'Diana Foster',
			'candidate.usSenate.marcus': 'Marcus Whitfield',
			'candidate.usSenate.elena': 'Elena Vasquez',
			'candidate.usHouse.james': 'James Okafor',
			'candidate.usHouse.laura': 'Laura Bennett',
			'candidate.governor.priya': 'Priya Nandan',
			'candidate.governor.robert': 'Robert Kessler',
			'candidate.stateBoardEducation.angela': 'Angela Torres',
			'candidate.stateBoardEducation.brian': 'Brian Michaels',
			'candidate.stateBoardEducation.cynthia': 'Cynthia Park',
			'candidate.stateBoardEducation.david': 'David Nguyen',
			'candidate.stateSenate.maria': 'Maria Gutierrez',
			'candidate.stateSenate.thomas': 'Thomas Reyes',
		},
		registration: {
			headerTitle: 'Registro',
			deviceAttestationTitle: 'Verificando Tu Dispositivo',
			confirmationTitle: 'Todo Listo',
			'notRegistered.heading': 'No estás registrado',
			'notRegistered.body':
				'Para participar en la Red de Utah necesitarás registrarte',
			'notRegistered.cta': 'Regístrate ahora',
			'registered.heading': 'Estás registrado para votar',
			'registered.body': 'Te has registrado exitosamente en la Red de Utah',
			'registered.identityLine': '{{fullName}}: {{party}} {{dob}}',
			'registered.validThrough': 'Válido hasta {{validThrough}}',
			'registered.updatePrompt':
				'¿Has hecho cambios recientes en tu información personal?',
			'registered.updateCta': 'Actualizar registro',
			'deviceAttestation.heading': 'Verificando tu dispositivo...',
			'deviceAttestation.caption': 'Confirmando que tu dispositivo es seguro',
			'deviceAttestation.terminalHeading': 'Este dispositivo no se puede usar para votar',
			'deviceAttestation.terminalBody':
				'Este dispositivo no cuenta con el hardware seguro necesario para proteger un voto, por lo que no se puede usar para registrarte.',
			'form.sectionTitle': 'Regístrate en la Red de Utah',
			'form.firstName': 'Nombre',
			'form.lastName': 'Apellido',
			'form.dob': 'Fecha de Nacimiento',
			'form.email': 'Correo Electrónico',
			'form.phone': 'Número de Teléfono',
			'form.dobPlaceholder': 'MM/DD/AAAA',
			'form.continueCta': 'Continuar',
			'form.backCta': 'Atrás',
			'form.submitCta': 'Enviar',
			'form.errors.required': 'Este campo es obligatorio',
			'form.errors.email': 'Introduce un correo electrónico válido',
			'form.errors.phone': 'Introduce un número de teléfono válido',
			'form.errors.dob': 'Introduce tu fecha de nacimiento como MM/DD/AAAA',
			'form.errors.party': 'Selecciona tu partido',
			'form.stepLabel': 'Paso {{step}} de 3',
			'form.addressLine1': 'Dirección línea 1',
			'form.addressLine2': 'Dirección línea 2 (opcional)',
			'form.addressLine3': 'Dirección línea 3 (opcional)',
			'form.selectParty': 'Selecciona Tu Partido',
			'form.party.democratic': 'Partido Demócrata',
			'form.party.republican': 'Partido Republicano',
			'form.party.independent': 'Independiente',
			'form.party.other': 'Otro',
			'form.confirmInstruction': 'Verifica que toda la información sea correcta',
			'form.review.fullName': 'Nombre Completo',
			'form.review.dob': 'Fecha de Nacimiento',
			'form.review.email': 'Correo Electrónico',
			'form.review.phone': 'Número de Teléfono',
			'form.review.party': 'Partido Registrado',
			'form.review.address': 'Dirección',
			'confirmation.heading': '¡Todo listo!',
			'confirmation.body': 'Confirma tu registro con Face ID',
			'confirmation.cta': 'Confirmar con Face ID',
			'confirmation.caption': 'Mira tu dispositivo para confirmar',
			'confirmation.error.biometricNotEnrolled': 'Configura el desbloqueo por huella o rostro para continuar',
			'confirmation.error.setupCta': 'Configurar desbloqueo del dispositivo',
			'confirmation.error.transient': 'Algo salió mal al verificar tu dispositivo. Inténtalo de nuevo.',
			'confirmation.error.terminal': 'Este dispositivo no se puede usar para votar',
			formHeaderTitle: 'Registrarse',
			confirmHeaderTitle: 'Confirmar',
		},
		scan: {
			headerTitle: 'Escanear',
			notAvailableTitle: 'Escaneo QR próximamente',
			notAvailableBody:
				'El escaneo de códigos QR aún no está disponible — llegará en una próxima actualización.',
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
