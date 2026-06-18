import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'react-native-localize';

const resources = {
	en: {
		translation: {
			elections: 'Elections',
			tasks: 'Tasks',
			authorities: 'Authorities',
			signers: 'Signers',
			settings: 'Settings',
			account: 'Account',
			appearance: 'Appearance',
			language: 'Language',
			about: 'About',
			dark: 'Dark',
			light: 'Light',
			english: 'English',
			recentNetworks: 'Recent Networks',
			connectedNetworks: 'Connected Networks',
			directAdvanced: 'Direct (advanced)',
			or: 'OR',
			// Phase 8 plan 08-05 (NETUI-01): empty-state hint when no recents.
			noRecentNetworks: 'No recent networks yet. Find one below to get started.',
			find: 'Find',
			scanQrCode: 'Scan QR Code',
			enterBootstrap: 'Enter Bootstrap (advanced)',
			useLocation: 'Use Location',
			scan: 'Scan',
			useBootstrap: 'Use Bootstrap',
			enterAddressOrLocation: 'Enter address or location...',
			enterBootstrapPlaceholder: 'Enter bootstrap...',
			syncConnected: 'Connected',
			syncSyncing: 'Syncing',
			syncOffline: 'Offline',
			invalidBootstrapAddress: 'Invalid bootstrap address',
			joinFailed: 'Could not join network',
			qrScanUnavailable: 'QR scanning is not available yet',
			cameraPermissionMessage: 'We need your permission to show the camera',
			grantPermission: 'Grant Permission',
			close: 'Close',
			addAuthority: 'Add Authority',
			noPinnedAuthorities: 'No pinned authorities yet',
			noAuthoritiesFound: 'No authorities found',
			filterAuthorities: 'Filter authorities...',
			authority: 'Authority',
			administration: 'Administration',
			pin: 'Pin',
			unpin: 'Unpin',
			handoff: 'Hand-off',
			name: 'Name',
			domainName: 'Domain Name',
			domain: 'Domain',
			sid: 'SID',
			cid: 'CID',
			address: 'Address',
			signature: 'Signature',
			coreSignature: 'Core Signature',
			revisionSignature: 'Revision Signature',
			priorCid: 'Prior CID',
			handoffSignature: 'Hand-Off Signature',
			handoffSignatures: 'Hand-off Signatures',
			invitedAuthorities: 'Invited Authorities',
			inviteAuthority: 'Invite Authority',
			valid: 'valid',
			of: 'of',
			createUser: 'Create User',
			invitingAuthority: 'Inviting Authority',
			invitingAdministrator: 'Inviting Administrator',
			newAuthority: 'New Authority',
			invitationName: 'Invitation Name',
			invitationKey: 'Invitation Key',
			soleInitialAdministratorNote: 'Please create a user on this network. Your user will be the sole initial administrator.',
			userIsSoleAdministratorNote: 'Your following user profile will be the sole initial administrator for the new authority.',
			expires: 'Expires',
			position: 'Position',
			switchingNetworks: 'Switching networks...',
			officer: 'Officer',
			nameOnInvitation: "Name on invitation (replaced with user's name)",
			officialTitle: 'Official title',
			key: 'Key',
			scopes: 'Scopes',
			signatures: 'Signatures',
			proposeReplacement: 'Propose Replacement',
			id: 'ID',
			title: 'Title',
			useOneOfTheFollowingToGetConnected: 'Use one of the following to get connected:',
			addNetwork: 'Add Network',
			createNewNetwork: 'Create a new network:',
			electionCharacteristics: 'Election Characteristics',
			useKeyholders: 'Use keyholders',
			noKeyholders: 'No keyholders',
			singleAuthority: 'Single authority',
			multiple: 'Multiple',
			multipleAuthorityNotYetSupported: 'Multiple (not yet supported)',
			mustSignBeforeCreating: 'You must sign before creating the network.',
			atLeastOneKeyholderRequired: 'At least one keyholder is required.',
			invalidDate: 'Please enter a valid date.',
			errTitleRequired: 'Please enter an election title.',
			errElectionDateRequired: 'Please choose an election date.',
			errRevisionDeadlineRequired: 'Please choose a revision deadline.',
			errElectionDateInvalid: 'Please enter a valid election date.',
			errRevisionDeadlineInvalid: 'Please enter a valid revision deadline.',
			errRevisionDeadlineAfterDate: 'The revision deadline must be on or before the election date.',
			errElectionDateTooSoon: 'The election date is too soon — choose a date on or after {{date}} so the ballot deadline can fall before it.',
			errBallotDeadlineAfterDate: 'The election date is too soon for the ballot deadline. Please choose a later election date.',
			errTimelineOrder: 'Please order the timeline so voting starts before tallying, and tallying before certification.',
			errThresholdExceedsKeyholders: 'The signing threshold cannot be more than the number of key holders.',
			errCouldNotSaveElection: 'Could not save the election. Please review the dates and try again.',
			initialAdministrator: 'Initial Administrator',
			imageUrl: 'Image URL',
			makePermanent: 'Make Permanent',
			optionalImageAddress: 'Optional image address',
			primaryAuthority: 'Primary Authority',
			authorityName: 'Authority name',
			authorityImageUrl: 'Authority image URL',
			domainNameOptional: 'Domain Name (optional)',
			initialOfficer: 'Initial Officer',
			yourNameOnPermanentRecord: 'Your name (on permanent record)',
			yourTitleOnPermanentRecord: 'Your title (on permanent record)',
			sign: 'SIGN',
			createNetwork: 'Create Network',
			relays: 'Relays',
			multiaddress: 'Multiaddress',
			advanced: 'Advanced',
			import: 'Import',
			addRelay: 'Add Relay',
			addTsa: 'Add TSA',
			statistics: 'Statistics',
			estimatedNodes: 'Estimated Nodes:',
			estimatedServers: 'Estimated Servers:',
			hostMyOwn: 'Host my own',
			configuration: 'Configuration',
			seeInstructions: 'See',
			votetorrentInstructions: 'VoteTorrent Instructions',
			forConfiguringAServer: 'for configuring a server.',
			useHostingProvider: 'Use Hosting Provider',
			addProvider: 'Add provider',
			hosting: 'Hosting',
			addServers: 'Add Servers',
			addServersToThisNetwork: 'Add servers to this network:',
			createProposedReplacement: 'Create a proposed replacement administration:',
			addOfficer: 'Add officer',
			createProposal: 'Create Proposal',
			noNetwork: 'No network selected. Please join a network or create your own.',
			selectNetwork: 'Select Network',
			remove: 'Remove',
			permissions: 'Permissions',
			publicKey: 'Public Key',
			proposedAdministration: 'Proposed Administration',
			share: 'Share',
			reviseAdministration: 'Revise Administration',
			authorization: 'Authorization',
			adjustProposal: 'Adjust Proposal',
			serverConfigurationPlaceholder: '{"network": { "name": ...',
			inviteId: 'Invite ID',
			showHelpIcons: 'Show help icons',
			defaultUser: 'Default User',
			connectDevice: 'Connect this device\nto existing user',
			connect: 'Connect',
			enterName: 'Enter name',
			enterImageUrl: 'Enter image URL',
			unknownUser: 'Unknown user',
			noUserFound: 'No user found for this network',
			user: 'User',
			noDefaultUserFound: 'No default user found',
			activeKeys: 'Active Keys',
			type: 'Type',
			expiration: 'Expiration',
			reviseUser: 'Revise User',
			addKey: 'Add Key',
			revokeKey: 'Revoke Key',
			history: 'History',
			mobile: 'Mobile',
			yubico: 'Yubico',
			addAnotherDeviceQrCode:
				'To add another device using a QR code, install the Authority App on that device, go to settings, press "Add this device to existing user", create a key using your biometrics, then scan the resulting QR code using the below button.',
			scanDevice: 'Scan Device',
			addYubicoDongleKey: 'Add Yubico (dongle) key',
			detailedInstructions: 'Detailed instructions',
			addYubicoInstructions: 'Insert or hold next to a Yubico dongle, then press this button:',
			generateExternalKey: 'Generate External Key',
			successfullyScannedKey: 'Successfully scanned key',
			signed: 'Signed',
			unchanged: 'Unchanged',
			revoke: 'Revoke',
			warningIrrevocableAction: 'WARNING: This is an irrevocable action; proceed with caution.',
			typeIConfirm: 'Type "I confirm" to continue',
			confirmIfSure: '"I confirm" if you are sure',
			iConfirm: 'I confirm',
			addDevice: 'Add Device',
			qrInformation: 'QR Information',
			token: 'Token',
			fromOtherDevice:
				'From the other device, select the user, press Add Key, the Scan, using the following QR code:',
			select: 'Select',
			hash: 'Hash',
			requiredTimestampAuthorities: 'Required Timestamp Authorities',
			timestampAuthorities: 'Timestamp Authorities',
			// Phase 8 plan 08-05 (NETUI-02): label used in the Proposed Changes diff row.
			electionType: 'Election Type',
			reviseNetwork: 'Revise Network',
			servers: 'Server(s)',
			proposedChanges: 'Proposed Changes',
			network: 'Network',
			onboardingTasks: 'Onboarding Tasks',
			keysToRelease: 'Keys to Release',
			requestedSignatures: 'Requested Signatures',
			date: 'Date',
			revisionDeadline: 'Revision Deadline',
			registrationEnds: 'Registration Ends',
			ballotsFinal: 'Ballots Final',
			votingStarts: 'Voting Starts',
			tallyingStarts: 'Tallying Starts',
			validation: 'Validation',
			certificationStarts: 'Certification Starts',
			closed: 'Closed',
			revision: 'Revision',
			tags: 'Tags',
			timeline: 'Timeline',
			keyholderThreshold: 'Keyholder Threshold',
			keyholderPolicy: 'Keyholder Policy',
			official: 'Official',
			adhoc: 'Ad-hoc',
			dateTime: 'Date/time',
			sent: 'Sent',
			unsent: 'Unsent',
			accepted: 'Accepted',
			invite: 'Invite',
			administrators: 'Administrators',
			pending: 'Pending',
			accept: 'Accept',
			reject: 'Reject',
			networkRevision: 'Network Revision',
			proposalTimestamp: 'Proposal timestamp',
			informational: 'informational',
			noProposedElectionsCurrently: 'No proposed elections currently',
			ready: 'Ready',
			remaining: 'remaining',
			keyholderRelease: 'Keyholder Release',
			release: 'Release',
			createElection: 'Create Election',
			proposedElections: 'Proposed Elections',
			noCurrentElections: 'No current elections',
			noProposedElections: 'No proposed elections',
			electionHistory: 'Election History',
			// Phase 9 plan 09-01 (ELECUI-01/02/05) — D-17: en-only, Spanish deferred to Phase 11.
			noHistoryFound: 'No history found.',
			noBallotYet: 'No ballot has been created for this election yet.',
			createBallot: 'Create Ballot',
			viewBallot: 'View Ballot',
			registrationOpens: 'Registration Opens',
			registrationCloses: 'Registration Closes',
			votingOpens: 'Voting Opens',
			votingCloses: 'Voting Closes',
			// Phase 9 plan 09-02 (ELECUI-03) — Create Election wizard keys.
			// D-17: en-only; Spanish backfill deferred to Phase 11 COMUI-02.
			basics: 'Basics',
			review: 'Review',
			next: 'Next',
			back: 'Back',
			edit: 'Edit',
			step: 'Step',
			addTag: 'Add a tag (comma-separated)',
			registrationDeadline: 'Registration Deadline',
			selectKeyholders: 'Select keyholders for this election:',
			noKeyholdersSelected: 'No keyholders selected yet.',
			preview: 'Preview',
			election: 'Election',
			keyholders: 'Keyholders',
			cloneElection: 'Clone Election',
			reviseElection: 'Revise Election',
			ballotTemplates: 'Ballot Templates',
			pendingBallotTemplates: 'Pending Ballot Templates',
			noAssociatedAuthoritiesHaveTemplates:
				'No authorities you are associated with have submitted ballot templates for this election.',
			noBallotTemplates: 'No ballot templates have been submitted for this election.',
			createBallotTemplate: 'Create Ballot Template',
			more: 'More',
			reviseAuthority: 'Revise Authority',
			ballotTemplate: 'Ballot Template',
			description: 'Description',
			addQuestion: 'Add Question',
			districtsGroups: 'Districts / Groups',
			clearAll: 'Clear All',
			addRange: 'Add Range',
			propose: 'Propose',
			// Phase 9 plan 09-08 — Ballot Template parity (BALUI-01/02).
			// D-17: en-only; Spanish deferred to Phase 11.
			authorityPlaceholder: 'Select authority',
			addDistrictCode: 'Add district code',
			itemsRangeCount: '{{from}}–{{to}} of {{total}} items',
			// Phase 7 foundation keys (07-01)
			adminRevision: 'Admin Revision',
			authorityRevision: 'Authority Revision',
			electionRevision: 'Election Revision',
			ballotRevision: 'Ballot Revision',
			allNetworks: 'All Networks',
			noTasks: 'No tasks',
			noTasksHelper: 'You have no pending tasks.',
			chipSignature: 'Signature',
			chipRelease: 'Release',
			chipOnboarding: 'Onboarding',
			closeScreen: 'Close screen',
			proposal: 'Proposal',
			details: 'Details',
			policies: 'Policies',
			admin: 'Admin',
			image: 'Image',
			electionTitle: 'Election Title',
			// Phase 7 onboarding keys (07-05) — flat camelCase per D-13; dotted forms PROHIBITED
			// Slug fallback: FrameN per plan contingency (semantic rename deferred — see 07-05-SUMMARY)
			screenScaffoldsDebugTitle: 'Onboarding Debug',
			screenScaffoldsDebugIntro: 'Direct entry points for the six onboarding screens. Temporary dev route per D-12; replaced by real callers in phases 8–10.',
			// Phase 8 gap-closure 08-07 — interim accept/send-mode invitation entries
			debugAdministratorInvitationAccept: 'Administrator Invitation (Accept)',
			debugAuthorityInvitationSend: 'Authority Invitation (Send)',
			debugAuthorityInvitationAccept: 'Authority Invitation (Accept)',
			// Frame 2 — Invitation sent (initial confirmation)
			editElectionTitle: 'Invitation Sent',
			editElectionBodyPrimary: 'Your invitation has been sent. You will be notified when the recipient responds.',
			editElectionBodySecondary: 'If no response is received soon, you can resend the invitation.',
			editElectionResend: 'Resend Invitation',
			editElectionBackToTasks: 'Back to Tasks',
			// Frame 7 — Awaiting response
			authorityDetailTitle: 'Awaiting Response',
			authorityDetailBodyPrimary: 'Waiting for the recipient to respond to your invitation.',
			authorityDetailBodySecondary: 'You can resend the invitation or cancel it if no longer needed.',
			authorityDetailResend: 'Resend Invitation',
			authorityDetailCancelInvitation: 'Cancel Invitation',
			// Frame 18 — Sent confirmation
			editElectionWithFilterTitle: 'Request Sent',
			editElectionWithFilterBodyPrimary: 'Your request has been submitted successfully.',
			editElectionWithFilterGotIt: 'Got It',
			// Frame 19 — Awaiting (variant)
			editRevisionFormTitle: 'Awaiting Approval',
			editRevisionFormBodyPrimary: 'Your submission is pending approval from the authority.',
			editRevisionFormBodySecondary: 'You will receive a notification once it is reviewed.',
			editRevisionFormResend: 'Resend Request',
			editRevisionFormDismissRequest: 'Dismiss Request',
			// Frame 20 — Release request sent
			proposedElectionTitle: 'Release Request Sent',
			proposedElectionBodyPrimary: 'Your key release request has been delivered to the keyholders.',
			proposedElectionBackToTasks: 'Back to Tasks',
			// Frame 21 — Release awaiting
			proposedRevisionTitle: 'Awaiting Release',
			proposedRevisionBodyPrimary: 'Waiting for keyholders to complete the release.',
			proposedRevisionBodySecondary: 'You can resend the release request or cancel it.',
			proposedRevisionResendRequest: 'Resend Request',
			proposedRevisionCancelRequest: 'Cancel Request',
			// Phase 8 plan 08-01 — Authorities polish + OfficerCard extraction
			noAuthorities: 'No authorities',
			noAuthoritiesHelper: 'Authorities you join or pin will appear here',
			manageProposal: 'Manage Proposal',
			// Phase 8 plan 08-02 — Proposed Administration screen (AUTHUI-03)
			thresholdPolicies: 'Threshold Policies',
			addAdministrator: 'Add Administrator',
			// Fallback for missing scopeDescriptions[rnp] (vote-core defines 8/9 — D-03)
			scope_rnp: 'Revise Network Policies',
			loading: 'Loading...',
			// Phase 8 plan 08-03 — OfficerDetails + Invitation screens (AUTHUI-04, 05, 06)
			administrator: 'Administrator',
			administratorInvitation: 'Administrator Invitation',
			authorityInvitation: 'Authority Invitation',
			sendInvitation: 'Send Invitation',
			invitation: 'Invitation',
			send: 'Send',
			decline: 'Decline',
			userId: 'User ID',
			// Phase 9 plan 09-04 — Ballot flow polish + Create Ballot (BALUI-01..04)
			save: 'Save',
			code: 'Code',
			question: 'Question',
			option: 'Option',
			addOption: 'Add Option',
			rank: 'Rank',
			score: 'Score',
			text: 'Text',
			additionalInstructions: 'Additional Instructions',
			dependsOn: 'Depends On',
			addDependency: 'Add Dependency',
			additionalDetails: 'Additional Details',
			informationUrl: 'Information URL',
			videoUrl: 'Video URL',
			optionalVideoAddress: 'Optional video address',
			// Phase 9 plan 09-07 — Ballot Question + Question Option parity (BALUI-03/04).
			// D-17: en-only; Spanish deferred to Phase 11.
			ballotQuestion: 'Ballot Question',
			questionOption: 'Question Option',
			selectionLimits: 'Selection Limits',
			min: 'Min',
			max: 'Max',
			forceOrder: 'Force Order',
			required: 'Required',
			group: 'Group',
			sequence: 'Sequence',
			groupPlaceholder: 'county/seats',
			// Phase 9 plan 09-10 — mock authority dropdown options (G6). EN only; es deferred per D-17.
			mockAuthorityA: 'Mock Authority A',
			mockAuthorityB: 'Mock Authority B',
			// Phase 9 plan 09-11 (ELECUI-03/04) — Election-flow form keys. EN only; es deferred per D-17.
			newElection: 'New Election',
			electionRevisionTitle: 'Election Revision',
			coreSectionHeader: 'Core (cannot change once approved)',
			initialRevisionHeader: 'Initial Revision (can change)',
			proposedRevisionHeader: 'Proposed Revision',
			coreDateHelp: 'The core date of the election',
			revisionDeadlineHelp: 'Last date/time changes are allowed',
			releasingKeys: 'Releasing Keys',
			selectDate: 'Select date',
			keyHolders: 'Key holders',
			addKeyHolder: 'Add Key Holder',
			thresholdPolicy: 'Threshold Policy',
			thresholdValue: '{{n}} of {{m}}',
			instructions: 'Instructions',
			instructionsOptional: 'Instructions (optional)',
			keyholderName: 'Key holder name',
			adjustRevision: 'Adjust Revision',
			signRevision: 'Sign',
			shareRevision: 'Share',
			previewBallots: 'Preview…',
			questionsLabel: 'Questions',
			validForAuthority: '[valid for {{authority}}]',
			filterAuthoritiesField: 'Filter authorities...',
			// Phase 21 plan 21-07 (UKEY-03) — D-15 copy: external-key honest-state strings with no phase numbers
			scanDeviceNotAvailable: 'Requires a paired device',
			generateExternalKeyNotAvailable: 'Requires a hardware key device',
			// Phase 10 plan 10-01 (USRUI-05/09; USRUI-01 polish) — D-17: en-only; Spanish deferred to Phase 11
			addedKey: 'Added Key',
			noActiveKeysFound: 'No active keys found.',
			addedDevice: 'Added Device',
			deviceAdded: 'Device Added',
			done: 'Done',
			// Phase 10 plan 10-02 (KHUI-01/02) — D-17: en-only; Spanish deferred to Phase 11
			keyholder: 'Keyholder',
			keyholderInvitation: 'Keyholder Invitation',
			debugKeyholderInvitationSend: 'Keyholder Invitation (Send)',
			debugKeyholderInvitationAccept: 'Keyholder Invitation (Accept)',
			// Phase 11 plan 11-01 (D-11) — en mirrors added for es orphan keys (create/revise)
			create: 'Create', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			revise: 'Revise', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Debug seed keys — debug-only affordance; never appears in release UI
			debugSeedTasksTitle: 'Seed Pending Tasks (Debug)',
			debugSeedTasksSuccess: 'Pending tasks seeded — check Tasks tab',
			debugSeedTasksError: 'Seed failed: ',
		},
	},
	es: {
		translation: {
			elections: 'Elecciones',
			tasks: 'Tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorities: 'Autoridades',
			signers: 'Firmantes',
			settings: 'Ajustes',
			account: 'Cuenta',
			appearance: 'Apariencia',
			language: 'Idioma',
			about: 'Acerca de',
			dark: 'Oscuro',
			light: 'Claro',
			english: 'Inglés',
			recentNetworks: 'Redes Recientes',
			connectedNetworks: 'Redes Conectadas',
			directAdvanced: 'Directo (avanzado)',
			or: 'O',
			// Phase 8 plan 08-05 (NETUI-01): empty-state hint when no recents.
			noRecentNetworks: 'Aún no hay redes recientes. Encuentra una abajo para comenzar.',
			find: 'Buscar',
			scanQrCode: 'Escanear Código QR',
			enterBootstrap: 'Ingresar Bootstrap (avanzado)',
			useLocation: 'Usar Ubicación',
			scan: 'Escanear',
			useBootstrap: 'Usar Bootstrap',
			enterAddressOrLocation: 'Ingresar dirección o ubicación...',
			enterBootstrapPlaceholder: 'Ingresar bootstrap...',
			syncConnected: 'Conectado',
			syncSyncing: 'Sincronizando',
			syncOffline: 'Sin conexión',
			invalidBootstrapAddress: 'Dirección de bootstrap no válida',
			joinFailed: 'No se pudo unir a la red',
			qrScanUnavailable: 'El escaneo de QR aún no está disponible',
			cameraPermissionMessage: 'Necesitamos tu permiso para mostrar la cámara',
			grantPermission: 'Permitir',
			close: 'Cerrar',
			addAuthority: 'Agregar Autoridad',
			noPinnedAuthorities: 'No hay autoridades marcadas',
			noAuthoritiesFound: 'No se encontraron autoridades',
			filterAuthorities: 'Filtrar autoridades...',
			authority: 'Autoridad',
			administration: 'Administración',
			pin: 'Marcar',
			unpin: 'Desmarcar',
			handoff: 'Pasar',
			name: 'Nombre',
			domainName: 'Nombre de Dominio',
			domain: 'Dominio',
			sid: 'SID',
			cid: 'CID',
			address: 'Dirección',
			signature: 'Firma',
			coreSignature: 'Firma Principal',
			revisionSignature: 'Firma de Revisión',
			priorCid: 'CID Anterior',
			handoffSignature: 'Firma de Transferencia',
			handoffSignatures: 'Firmas de Transferencia',
			invitedAuthorities: 'Autoridades Invitadas',
			inviteAuthority: 'Invitar Autoridad',
			valid: 'válida',
			of: 'de',
			createUser: 'Crear Usuario',
			invitingAuthority: 'Autoridad Invitante',
			invitingAdministrator: 'Administrador Invitante',
			newAuthority: 'Nueva Autoridad',
			invitationName: 'Nombre de Invitación',
			invitationKey: 'Clave de Invitación',
			soleInitialAdministratorNote: 'Cree un usuario en esta red. Su usuario será el único administrador inicial.',
			userIsSoleAdministratorNote: 'El siguiente perfil de usuario será el único administrador inicial de la nueva autoridad.',
			expires: 'Expira',
			position: 'Cargo',
			switchingNetworks: 'Cambiando redes...',
			officer: 'Oficial',
			nameOnInvitation: 'Nombre en la invitación (reemplazado con el nombre del usuario)',
			officialTitle: 'Título oficial',
			key: 'Clave',
			scopes: 'Alcances',
			signatures: 'Firmas',
			proposeReplacement: 'Proponer Reemplazo',
			id: 'ID',
			title: 'Título',
			useOneOfTheFollowingToGetConnected: 'Usa una de las siguientes para conectarte:',
			addNetwork: 'Agregar Red',
			createNewNetwork: 'Crear una nueva red:',
			electionCharacteristics: 'Características de la Elección',
			useKeyholders: 'Usar custodios',
			noKeyholders: 'Sin custodios',
			singleAuthority: 'Autoridad única',
			multiple: 'Múltiple',
			multipleAuthorityNotYetSupported: 'Múltiple (aún no soportado)',
			mustSignBeforeCreating: 'Debe firmar antes de crear la red.',
			atLeastOneKeyholderRequired: 'Se requiere al menos un custodio.',
			invalidDate: 'Ingrese una fecha válida.',
			errTitleRequired: 'Ingrese un título para la elección.',
			errElectionDateRequired: 'Elija una fecha para la elección.',
			errRevisionDeadlineRequired: 'Elija una fecha límite de revisión.',
			errElectionDateInvalid: 'Ingrese una fecha de elección válida.',
			errRevisionDeadlineInvalid: 'Ingrese una fecha límite de revisión válida.',
			errRevisionDeadlineAfterDate: 'La fecha límite de revisión debe ser igual o anterior a la fecha de la elección.',
			errElectionDateTooSoon: 'La fecha de la elección es demasiado pronto: elija una fecha igual o posterior al {{date}} para que la fecha límite de boletas quede antes.',
			errBallotDeadlineAfterDate: 'La fecha de la elección es demasiado pronto para la fecha límite de boletas. Elija una fecha de elección posterior.',
			errTimelineOrder: 'Ordene el cronograma para que la votación comience antes del recuento, y el recuento antes de la certificación.',
			errThresholdExceedsKeyholders: 'El umbral de firmas no puede ser mayor que el número de custodios.',
			errCouldNotSaveElection: 'No se pudo guardar la elección. Revise las fechas e intente de nuevo.',
			initialAdministrator: 'Administrador Inicial',
			imageUrl: 'URL de Imagen',
			makePermanent: 'Hacer Permanente',
			optionalImageAddress: 'Dirección de imagen opcional',
			primaryAuthority: 'Autoridad Primaria',
			authorityName: 'Nombre de la autoridad',
			authorityImageUrl: 'URL de la imagen de la autoridad',
			domainNameOptional: 'Nombre de Dominio (opcional)',
			initialOfficer: 'Oficial Inicial',
			yourNameOnPermanentRecord: 'Tu nombre (en registro permanente)',
			yourTitleOnPermanentRecord: 'Tu título (en registro permanente)',
			sign: 'FIRMAR',
			createNetwork: 'Crear Red',
			relays: 'Relays',
			multiaddress: 'Multiaddress',
			advanced: 'Avanzado',
			import: 'Importar',
			addRelay: 'Agregar Relay',
			addTsa: 'Agregar TSA',
			statistics: 'Estadísticas',
			estimatedNodes: 'Nodos Estimados:',
			estimatedServers: 'Servidores Estimados:',
			hostMyOwn: 'Hostear mi propio',
			configuration: 'Configuración',
			seeInstructions: 'Ver',
			votetorrentInstructions: 'Instrucciones de VoteTorrent',
			forConfiguringAServer: 'para configurar un servidor.',
			useHostingProvider: 'Usar Proveedor de Hosting',
			addProvider: 'Agregar proveedor',
			hosting: 'Hosting',
			addServers: 'Agregar Servidores',
			addServersToThisNetwork: 'Agregar servidores a esta red:',
			createProposedReplacement: 'Crear una propuesta de reemplazo de administración:',
			addOfficer: 'Agregar Oficial',
			createProposal: 'Crear Propuesta',
			noNetwork: 'No hay red seleccionada. Por favor, únete a una red o crea la tuya propia.',
			selectNetwork: 'Seleccionar Red',
			remove: 'Eliminar',
			permissions: 'Permisos',
			publicKey: 'Clave Pública',
			proposedAdministration: 'Administración Propuesta',
			share: 'Compartir',
			reviseAdministration: 'Revisar Administración',
			authorization: 'Autorización',
			adjustProposal: 'Ajustar Propuesta',
			serverConfigurationPlaceholder: '{"red": { "nombre": ...',
			inviteId: 'ID de Invitación',
			showHelpIcons: 'Mostrar iconos de ayuda',
			defaultUser: 'Usuario predeterminado',
			connectDevice: 'Conectar este dispositivo\na usuario existente', // Phase 11 plan 11-03 (D-10) — line-break for ES overflow.
			connect: 'Conectar',
			enterName: 'Ingrese el nombre',
			enterImageUrl: 'Ingrese la URL de la imagen',
			unknownUser: 'Usuario desconocido',
			noUserFound: 'No se encontró usuario para esta red',
			user: 'Usuario',
			noDefaultUserFound: 'No se encontró usuario predeterminado',
			activeKeys: 'Claves Activas',
			type: 'Tipo',
			expiration: 'Expiración',
			reviseUser: 'Revisar Usuario',
			addKey: 'Agregar Clave',
			revokeKey: 'Revocar Clave',
			history: 'Historial',
			create: 'Crear',
			revise: 'Revisar',
			mobile: 'Móvil',
			yubico: 'Yubico',
			addAnotherDeviceQrCode:
				'Para agregar otro dispositivo usando un código QR, instala la aplicación de Autoridad en ese dispositivo, ve a ajustes, presiona "Agregar este dispositivo a usuario existente", crea una clave usando tus biometrías, luego escanea el código QR resultante usando el botón de abajo.',
			scanDevice: 'Escanear Dispositivo',
			addYubicoDongleKey: 'Agregar Clave Yubico (dongle)',
			detailedInstructions: 'Instrucciones detalladas',
			addYubicoInstructions:
				'Inserta o sostén junto a un dongle Yubico, luego presiona este botón:',
			generateExternalKey: 'Generar Clave Externa',
			successfullyScannedKey: 'Clave escaneada exitosamente',
			signed: 'Firmada',
			unchanged: 'Sin cambios',
			revoke: 'Revocar',
			warningIrrevocableAction:
				'¡ATENCIÓN: Esta es una acción irrevocable; proceda con precaución.',
			typeIConfirm: 'Escribe "Confirmo" para continuar',
			confirmIfSure: '"Confirmo" si estás seguro',
			iConfirm: 'Confirmo',
			addDevice: 'Agregar Dispositivo',
			qrInformation: 'Información del Código QR',
			token: 'Token',
			fromOtherDevice:
				'Desde el otro dispositivo, selecciona el usuario, presiona Agregar Clave, escanea, usando el siguiente código QR:',
			select: 'Seleccionar',
			hash: 'Hash',
			requiredTimestampAuthorities: 'Autoridades de Temporizador Requeridas',
			timestampAuthorities: 'Autoridades de Temporizador',
			// Phase 8 plan 08-05 (NETUI-02): label used in the Proposed Changes diff row.
			electionType: 'Tipo de Elección',
			reviseNetwork: 'Revisar Red',
			servers: 'Servidor(es)',
			proposedChanges: 'Cambios Propuestos',
			network: 'Red',
			onboardingTasks: 'Tareas de Inscripción',
			keysToRelease: 'Claves a Liberar',
			requestedSignatures: 'Firmas Requeridas',
			date: 'Fecha',
			revisionDeadline: 'Fecha de Revisión',
			registrationEnds: 'Finaliza Registro',
			ballotsFinal: 'Boletas Finales',
			votingStarts: 'Inicia Votación',
			tallyingStarts: 'Inicia el Recuento', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			validation: 'Validación',
			certificationStarts: 'Inicia Certificación',
			closed: 'Cerrado',
			revision: 'Revisión',
			tags: 'Etiquetas',
			timeline: 'Cronograma',
			keyholderThreshold: 'Umbral de Custodios', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholderPolicy: 'Política de Custodios', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			official: 'Oficial',
			adhoc: 'Ad-hoc',
			dateTime: 'Fecha/hora',
			sent: 'Enviada',
			unsent: 'No enviada',
			accepted: 'Aceptado',
			invite: 'Invitar',
			administrators: 'Administradores',
			pending: 'Pendiente',
			accept: 'Aceptar',
			reject: 'Rechazar',
			networkRevision: 'Revisión de Red',
			proposalTimestamp: 'Marca de tiempo de la propuesta',
			informational: 'informativo',
			noProposedElectionsCurrently: 'No hay elecciones propuestas actualmente',
			ready: 'Listo',
			remaining: 'restante',
			keyholderRelease: 'Liberación de Custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			release: 'Liberar',
			createElection: 'Crear Elecciones',
			proposedElections: 'Elecciones Propuestas',
			noCurrentElections: 'No hay elecciones actuales',
			noProposedElections: 'No hay elecciones propuestas',
			electionHistory: 'Historial de Elecciones',
			preview: 'Vista Previa',
			election: 'Elección',
			keyholders: 'Custodios', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			cloneElection: 'Clonar Elecciones',
			reviseElection: 'Revisar Elecciones',
			ballotTemplates: 'Plantillas de Boletas',
			pendingBallotTemplates: 'Plantillas de Boletas Pendientes',
			noAssociatedAuthoritiesHaveTemplates:
				'No hay autoridades con las que estés asociado que hayan enviado plantillas de boletas para esta elección.',
			noBallotTemplates: 'No hay plantillas de boletas enviadas para esta elección.',
			createBallotTemplate: 'Crear Plantilla de Boletas',
			more: 'Más',
			reviseAuthority: 'Revisar Autoridad',
			ballotTemplate: 'Plantilla de Boletas',
			description: 'Descripción',
			addQuestion: 'Agregar Pregunta',
			districtsGroups: 'Distritos / Grupos',
			clearAll: 'Limpiar Todo',
			addRange: 'Agregar Rango',
			propose: 'Proponer',
			// Phase 7 foundation keys (07-01) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			adminRevision: 'Revisión de Admin', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityRevision: 'Revisión de Autoridad', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			electionRevision: 'Revisión de Elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			ballotRevision: 'Revisión de Boleta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			allNetworks: 'Todas las Redes', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noTasks: 'Sin tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noTasksHelper: 'No tienes tareas pendientes.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			chipSignature: 'Firma', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			chipRelease: 'Liberar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			chipOnboarding: 'Incorporación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			closeScreen: 'Cerrar pantalla', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposal: 'Propuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			details: 'Detalles', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			policies: 'Políticas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			admin: 'Administrador', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			image: 'Imagen', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			electionTitle: 'Título de la Elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 7 onboarding keys (07-05) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			screenScaffoldsDebugTitle: 'Depuración de Incorporación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			screenScaffoldsDebugIntro: 'Puntos de entrada directos a las seis pantallas de incorporación. Ruta temporal de desarrollo; reemplazada por llamadas reales en las fases 8–10.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 gap-closure 08-07 — interim accept/send-mode invitation entries
			debugAdministratorInvitationAccept: 'Invitación de administrador (aceptar)',
			debugAuthorityInvitationSend: 'Invitación de autoridad (enviar)',
			debugAuthorityInvitationAccept: 'Invitación de autoridad (aceptar)',
			editElectionTitle: 'Invitación Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBodyPrimary: 'Tu invitación ha sido enviada. Se te notificará cuando el destinatario responda.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBodySecondary: 'Si no se recibe respuesta pronto, puedes reenviar la invitación.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionResend: 'Reenviar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBackToTasks: 'Volver a Tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailTitle: 'Esperando Respuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailBodyPrimary: 'Esperando que el destinatario responda tu invitación.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailBodySecondary: 'Puedes reenviar la invitación o cancelarla si ya no es necesaria.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailResend: 'Reenviar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailCancelInvitation: 'Cancelar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionWithFilterTitle: 'Solicitud Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionWithFilterBodyPrimary: 'Tu solicitud ha sido enviada exitosamente.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionWithFilterGotIt: 'Entendido', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormTitle: 'Esperando Aprobación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormBodyPrimary: 'Tu envío está pendiente de aprobación por parte de la autoridad.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormBodySecondary: 'Recibirás una notificación una vez que sea revisado.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormResend: 'Reenviar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormDismissRequest: 'Descartar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedElectionTitle: 'Solicitud de Liberación Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedElectionBodyPrimary: 'Tu solicitud de liberación de clave ha sido entregada a los custodios.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedElectionBackToTasks: 'Volver a Tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionTitle: 'Esperando Liberación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionBodyPrimary: 'Esperando que los custodios completen la liberación.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionBodySecondary: 'Puedes reenviar la solicitud de liberación o cancelarla.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionResendRequest: 'Reenviar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionCancelRequest: 'Cancelar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 plan 08-01 — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noAuthorities: 'Sin autoridades', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noAuthoritiesHelper: 'Las autoridades a las que te unes o marcas aparecerán aquí.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			manageProposal: 'Gestionar Propuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 plan 08-02 — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			thresholdPolicies: 'Políticas de Umbral', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addAdministrator: 'Agregar Administrador', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			scope_rnp: 'Revisar Políticas de Red', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			loading: 'Cargando...', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 plan 08-03 — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			administrator: 'Administrador', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			administratorInvitation: 'Invitación de Administrador', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityInvitation: 'Invitación de Autoridad', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			sendInvitation: 'Enviar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			invitation: 'Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			send: 'Enviar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			decline: 'Rechazar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			userId: 'ID de Usuario', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-01 (ELECUI-01/02/05) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noHistoryFound: 'No se encontró historial.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noBallotYet: 'Aún no se ha creado una boleta para esta elección.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			createBallot: 'Crear Boleta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			viewBallot: 'Ver Boleta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			registrationOpens: 'Abre el Registro', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			registrationCloses: 'Cierra el Registro', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			votingOpens: 'Inicia la Votación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			votingCloses: 'Cierra la Votación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-02 (ELECUI-03) — Create Election wizard — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			basics: 'Básico', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			review: 'Revisar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			next: 'Siguiente', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			back: 'Atrás', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			edit: 'Editar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			step: 'Paso', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addTag: 'Agregar etiqueta (separadas por coma)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			registrationDeadline: 'Fecha Límite de Registro', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			selectKeyholders: 'Selecciona custodios para esta elección:', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noKeyholdersSelected: 'No se han seleccionado custodios.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityPlaceholder: 'Seleccionar autoridad', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addDistrictCode: 'Agregar código de distrito', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			itemsRangeCount: '{{from}}–{{to}} de {{total}} elementos', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-04 (BALUI-01..04) — Ballot Question/Option — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			save: 'Guardar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			code: 'Código', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			question: 'Pregunta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			option: 'Opción', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addOption: 'Agregar Opción', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			rank: 'Rango', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			score: 'Puntuación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			text: 'Texto', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			additionalInstructions: 'Instrucciones Adicionales', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			dependsOn: 'Depende de', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addDependency: 'Agregar Dependencia', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			additionalDetails: 'Detalles Adicionales', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			informationUrl: 'URL de Información', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			videoUrl: 'URL de Video', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			optionalVideoAddress: 'Dirección de video opcional', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-07 (BALUI-03/04) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			ballotQuestion: 'Pregunta de Boleta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			questionOption: 'Opción de Pregunta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			selectionLimits: 'Límites de Selección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			min: 'Mín', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			max: 'Máx', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			forceOrder: 'Orden Obligatorio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			required: 'Obligatorio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			group: 'Grupo', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			sequence: 'Secuencia', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			groupPlaceholder: 'condado/escaños', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-10 — mock authority dropdown — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			mockAuthorityA: 'Autoridad Mock A', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			mockAuthorityB: 'Autoridad Mock B', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-11 (ELECUI-03/04) — election form — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			newElection: 'Nueva Elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			electionRevisionTitle: 'Revisión de Elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			coreSectionHeader: 'Principal (no se puede cambiar una vez aprobado)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			initialRevisionHeader: 'Revisión Inicial (puede cambiar)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionHeader: 'Revisión Propuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			coreDateHelp: 'La fecha principal de la elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			revisionDeadlineHelp: 'Última fecha/hora en que se permiten cambios', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			releasingKeys: 'Liberando Claves', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			selectDate: 'Seleccionar fecha', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyHolders: 'Custodios de Clave', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addKeyHolder: 'Agregar Custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			thresholdPolicy: 'Política de Umbral', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			thresholdValue: '{{n}} de {{m}}', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			instructions: 'Instrucciones', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			instructionsOptional: 'Instrucciones (opcional)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholderName: 'Nombre del custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			adjustRevision: 'Ajustar Revisión', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			signRevision: 'Firmar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			shareRevision: 'Compartir', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			previewBallots: 'Previsualizar…', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			questionsLabel: 'Preguntas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			validForAuthority: '[válido para {{authority}}]', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			filterAuthoritiesField: 'Filtrar autoridades...', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 21 plan 21-07 (UKEY-03) — D-15 copy: external-key honest-state strings
			scanDeviceNotAvailable: 'Requiere un dispositivo emparejado',
			generateExternalKeyNotAvailable: 'Requiere un dispositivo con clave de hardware',
			// Phase 10 plan 10-01 (USRUI-05/09) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addedKey: 'Clave Agregada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noActiveKeysFound: 'No se encontraron claves activas.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addedDevice: 'Dispositivo Agregado', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			deviceAdded: 'Dispositivo Añadido', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			done: 'Listo', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 10 plan 10-02 (KHUI-01/02) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholder: 'Custodio de Clave', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholderInvitation: 'Invitación de Custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			debugKeyholderInvitationSend: 'Invitación de Custodio (Enviar)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			debugKeyholderInvitationAccept: 'Invitación de Custodio (Aceptar)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Debug seed keys — Spanish mirrors
			debugSeedTasksTitle: 'Sembrar Tareas Pendientes (Debug)',
			debugSeedTasksSuccess: 'Tareas pendientes sembradas — ver pestaña Tareas',
			debugSeedTasksError: 'Error al sembrar: ',
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

export { resources };
export default i18n;
