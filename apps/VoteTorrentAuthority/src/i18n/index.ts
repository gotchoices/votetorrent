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
			useLocationComingSoon: 'Use Location (coming soon)',
			scan: 'Scan',
			useBootstrap: 'Use Bootstrap',
			enterAddressOrLocation: 'Enter address or location...',
			enterBootstrapPlaceholder: 'Enter bootstrap...',
			syncConnected: 'Connected',
			syncSyncing: 'Syncing',
			syncOffline: 'Offline',
			syncNotConfigured: 'Not configured',
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
			invitationAcceptTitle: 'Accept an Invitation',
			invitationAcceptBody: "Paste the invitation someone shared with you. You'll see who it's from before you accept.",
			invitationAcceptContinue: 'Continue',
			invitationAcceptPasteHint: 'Paste the invitation text you received.',
			invitationAcceptPastePlaceholder: 'Paste the invitation here',
			invitationAcceptMalformed: "This doesn't look like a complete invitation. Copy it again and paste all of it.",
			invitationAcceptWrongType: 'This invitation is for a different role. Open it from Accept an Invitation in Settings.',
			invitationAcceptNotFound: "This invitation hasn't reached this device yet, or it is no longer valid.",
			invitationAcceptAlreadyAnswered: 'This invitation has already been answered. It cannot be accepted or declined again.',
			invitationAcceptNoLongerValid: 'This invitation was withdrawn or has expired. Ask the sender for a new one.',
			invitationAcceptExpired: 'This invitation expired on {{when}}. Ask the sender for a new one.',
			invitationAcceptFailed: 'Could not respond to the invitation. Try again.',
			soleInitialAdministratorNote:
				'Please create a user on this network. Your user will be the sole initial administrator.',
			userIsSoleAdministratorNote:
				'Your following user profile will be the sole initial administrator for the new authority.',
			expires: 'Expires',
			// UAT 62: an administration's EffectiveAt is when it STARTS — labelled Expires before.
			effective: 'Effective',
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
			multipleAuthorityNotYetSupportedNote: 'Multiple authorities are not yet supported.',
			mustSignBeforeCreating: 'You must sign before creating the network.',
			atLeastOneKeyholderRequired: 'At least one keyholder is required.',
			invalidDate: 'Please enter a valid date.',
			errAuthorityNameRequired: 'Please enter an authority name.',
			creating: 'Creating…',
			networkCreateTimeout:
				'The network did not finish the {{step}} step in time. It may still complete — check your networks list before creating it again.',
			networkCreateStillFinishing:
				'Still creating the network on this phone. Keep this screen open; on some phones this takes a few minutes.',
			networkCreateUnconfirmed:
				'Could not confirm whether the network was created. It may still be finishing — check your networks list before creating it again, so you do not create it twice.',
			errRelayRequired:
				'Add at least one relay address under Relays before creating the network.',
			errRelayInvalid:
				'A relay address under Relays is not a valid multiaddress. Check it and try again — for example /dns4/relay.example.com/tcp/443/wss/p2p/<peer id>.',
			validationFailed: 'Validation failed.',
			errTitleRequired: 'Please enter an election title.',
			errElectionDateRequired: 'Please choose an election date.',
			errRevisionDeadlineRequired: 'Please choose a revision deadline.',
			errElectionDateInvalid: 'Please enter a valid election date.',
			errRevisionDeadlineInvalid: 'Please enter a valid revision deadline.',
			errRevisionDeadlineAfterDate: 'The revision deadline must be on or before the election date.',
			errElectionDateTooSoon:
				'The election date is too soon — choose a date on or after {{date}} so the ballot deadline can fall before it.',
			errBallotDeadlineAfterDate:
				'The election date is too soon for the ballot deadline. Please choose a later election date.',
			errTimelineOrder:
				'Please order the timeline so voting starts before tallying, and tallying before certification.',
			errThresholdExceedsKeyholders:
				'The signing threshold cannot be more than the number of key holders.',
			errCouldNotSaveElection:
				'Could not save the election. Please review the dates and try again.',
			// A-9: SignerKeyValid / OfficerValid — the signing key is not an officer key on this network.
			errElectionSignerNotOfficer:
				'This device does not hold an officer seat on this network, so it cannot save elections here.',
			initialAdministrator: 'Initial Administrator',
			imageUrl: 'Image URL',
			makePermanent: 'Make Permanent',
			// Media pinning ("Make Permanent" on image/video URL fields): the status line under the field.
			mediaPinning: 'Making permanent…',
			mediaPinned: 'Permanent · {{cid}}',
			mediaPinInvalidUrl: 'Enter a full http(s) link first',
			mediaPinNetwork: "Couldn't download this file — check the link and your connection",
			mediaPinHttp: 'The server refused the download (HTTP error)',
			mediaPinTooLarge: 'This file is too large to make permanent (25 MB limit)',
			mediaPinEmpty: 'The link returned an empty file',
			optionalImageAddress: 'Optional image address',
			primaryAuthority: 'Primary Authority',
			authorityName: 'Authority name',
			authorityImageUrl: 'Authority image URL',
			domainNameOptional: 'Domain Name (optional)',
			initialOfficer: 'Initial Officer',
			yourNameOnPermanentRecord: 'Your name (on permanent record)',
			yourTitleOnPermanentRecord: 'Your title (on permanent record)',
			sign: 'SIGN',
			applyRevisionNeedsCoSigners: 'This network needs more than one officer to approve a revision, which is not supported yet.',
			createNetwork: 'Create Network',
			relays: 'Relays',
			relaysRequiredHint: 'At least one relay is required so other devices can reach this network.',
			createMissingFields: 'Before creating the network: {{fields}}.',
			missingNetworkName: 'enter a network name',
			missingAuthorityName: 'enter the primary authority name',
			missingYourName: 'enter your name',
			missingYourTitle: 'enter your title',
			missingSignature: 'sign',
			missingRelay: 'add a relay address',
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
			noNetworkTitle: 'Choose a network to get started',
			noNetwork:
				'Tap “Select Network” at the top to join an existing network — or create your own.',
			selectNetwork: 'Select Network',
			networkSelectFailed: "Couldn't open this network. Try again.",
			networkDetailsLoadFailed: "Could not load this network's details. Try again.",
			applyRevisionFailed: "Couldn't apply this revision. Try again.",
			remove: 'Remove',
			permissions: 'Permissions',
			publicKey: 'Public Key',
			proposedAdministration: 'Proposed Administration',
			share: 'Share',
			// Invitation send screens: the after-send share block (InviteShareBlock).
			// BIO-4: the invite material is never shown on screen; it leaves only through Share or Copy.
			invitationShareReady: 'The invitation is ready. Its key stays hidden here: send it with Share or Copy.',
			invitationShareCopy: 'Copy',
			invitationShareCopied: 'Copied to clipboard',
			inviteLeaveUnsharedTitle: 'Leave without sharing?',
			inviteLeaveUnsharedMessage: "This invitation hasn't been shared or copied yet. If you leave now it can't be shown again, and you'll need to send a new invitation.",
			inviteLeaveUnsharedStay: 'Stay',
			inviteLeaveUnsharedLeave: 'Leave without sharing',
			invitationShareCopyFailed: "Couldn't copy to the clipboard. Use Share instead.",
			invitationShareSheetFailed: "Couldn't open the share options. Try Copy instead.",
			reviseAdministration: 'Revise Administration',
			authorization: 'Authorization',
			adjustProposal: 'Adjust Proposal',
			serverConfigurationPlaceholder: '{"network": { "name": ...',
			inviteId: 'Invite ID',
			showHelpIcons: 'Show help icons',
			defaultUser: 'Default User',
			connectDevice: 'Connect to existing user',
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
			// D-20 / 49-05: rendered when the engine/schema rejects a revokeKey signature
			// (UserKey.DeleteValid CHECK) — see RevokeKeyScreen.tsx's constraint-name match.
			revokeKeySignatureInvalid: 'This revocation could not be verified and was not applied.',
			// D-13/D-14/D-16: native BiometricPrompt string contract + the signingKeyProvisioning*
			// screen copy (ProvisionSigningKeyScreen) + settingsSigningKeyRow. See
			// 49-UI-SPEC.md's Copywriting Contract for the full table this mirrors verbatim.
			deviceSigningPromptTitle: 'Confirm your identity',
			deviceSigningPromptSubtitle: 'Verify to sign this action',
			deviceSigningPromptNegativeButton: 'Cancel',
			signingKeyProvisioningPromptSubtitle: 'Verify to set up secure signing',
			signingKeyRecoveryPromptSubtitle:
				'Verify with your device PIN, pattern, or password to replace your signing key',
			deviceSigningErrorNoBiometricsEnrolled:
				'This device has no biometrics enrolled. Enroll a fingerprint or face in your device settings, then try again.',
			deviceSigningErrorLockout: 'Too many attempts. Wait a moment and try again.',
			deviceSigningErrorLockoutPermanent:
				'Biometric verification is locked. Unlock your device with your PIN, pattern, or password to reset it, then try again.',
			deviceSigningErrorGeneric: "Couldn't verify your biometrics. Try again.",
			// 49-14 follow-up (D-16 observability defect + DeleteValid precondition) — distinct from
			// deviceSigningErrorGeneric on purpose: neither of these is "couldn't verify your
			// biometrics," and rendering them that way hides the real, structural fault.
			deviceSigningErrorRecoveryKeyInvalidated:
				"This device's recovery key can no longer be used — it was invalidated along with your signing key. Contact an administrator to re-invite this device.",
			deviceSigningErrorRecoveryKeyNotRegistered:
				'Your recovery key was never registered on this network. Go to Settings and tap "Set Up Secure Signing" while connected to your network, then try recovery again.',
			signingKeyProvisioningScreenTitle: 'Secure Signing Setup',
			signingKeyProvisioningFirstRunHeading: 'Set up hardware-backed signing',
			signingKeyProvisioningFirstRunBody:
				"Your officer signature will be produced by a key stored in this device's secure hardware and protected by your biometrics. The key never leaves the device.",
			signingKeyProvisioningSetupButton: 'Set Up Secure Signing',
			signingKeyProvisioningPending: 'Setting up your signing key…',
			signingKeyProvisioningSuccessHeading: 'Signing key ready',
			signingKeyProvisioningSuccessBody: 'You can now sign officer actions with your biometrics.',
			signingKeyProvisioningAwaitingNetworkHeading: 'Secure signing is set up on this device',
			signingKeyProvisioningAwaitingNetworkBody:
				'Your signing key is protected by your biometrics. Select or create a network to finish registering it.',
			signingKeyProvisioningContinueButton: 'Continue',
			// 49-14 follow-up: distinct from awaiting-network — the network resolved, but this
			// device's account on it did not (see ProvisionSigningKeyScreen.tsx's
			// tryResolveNetworkUserEngine doc comment).
			signingKeyProvisioningNetworkUserUnresolvedHeading: "We couldn't find your account on this network",
			// Two causes look identical from this device (getCurrentUser finds no User row either way):
			// the officer account has not synced here yet, or this device has no account on the network.
			signingKeyProvisioningNetworkUserUnresolvedBody:
				"This device is connected to the network, but your officer account isn't on it here. If it is still syncing, wait a moment and try again. If waiting doesn't help, this device has no officer account on this network: ask an officer to send it an administrator invitation, then accept it in Settings > Accept an Invitation.",
			signingKeyProvisioningNetworkUserUnresolvedRetryButton: 'Try Again',
			signingKeyProvisioningNetworkUserUnresolvedInviteButton: 'Accept an Invitation',
			signingKeyProvisioningRecoveryHeading: 'Your signing key needs to be replaced',
			signingKeyProvisioningRecoveryBody:
				"Your device's biometrics changed, which invalidated your previous signing key for security. Verify with your device PIN, pattern, or password to sign in a replacement key.",
			signingKeyProvisioningRecoveryButton: 'Replace Signing Key',
			signingKeyProvisioningRecoveryPending: 'Replacing your signing key…',
			signingKeyProvisioningNoRecoveryHeading: 'This device no longer has a screen lock',
			signingKeyProvisioningNoRecoveryBody:
				'Both your signing key and its recovery key were protected by your device\'s screen lock, which has been removed. They cannot be recovered on this device — ask an officer to invite this device again.',
			signingKeyProvisioningRecoveryUnsupportedOsHeading: "Recovery isn't available on this Android version",
			signingKeyProvisioningRecoveryUnsupportedOsBody:
				"Replacing a signing key requires Android 11 or newer. This device runs an older version, so its signing key can't be replaced here — ask an officer to invite this device again.",
			settingsSigningKeyRow: 'Secure Signing',
			warningIrrevocableAction: 'WARNING: This is an irrevocable action; proceed with caution.',
			typeIConfirm: 'Type "I confirm" to continue',
			confirmIfSure: '"I confirm" if you are sure',
			iConfirm: 'I confirm',
			addDevice: 'Add Device',
			qrInformation: 'QR Information',
			token: 'Token',
			fromOtherDevice:
				'From the other device, select the user, press Add Key, the Scan, using the following QR code:',
			// AddDeviceScreen: IUserEngine.connectDevice() is phase-gated (same-user device pairing).
			connectDeviceUnavailable:
				"Connecting another device to this user isn't available yet. This version of the app can't pair devices.",
			connectDeviceFailed:
				"Couldn't prepare the connection details. Make sure a network is selected, then try again.",
			// AddDeviceScreen: getEngine("user") resolved no engine — no user is bound on this network.
			connectDeviceNoUser:
				"Your user isn't set up on this network yet, so this device can't share connection details.",
			select: 'Select',
			hash: 'Hash',
			requiredTimestampAuthorities: 'Required Timestamp Authorities',
			timestampAuthorities: 'Timestamp Authorities',
			// Phase 8 plan 08-05 (NETUI-02): label used in the Proposed Changes diff row.
			electionType: 'Election Type',
			reviseNetwork: 'Revise Network',
			// PR-1: officer permission names, through utils/scopeLabel (vote-core's scope descriptions are English only).
			scope_rn: 'Revise Network',
			scope_rad: 'Revise or replace the Administration',
			scope_vrg: 'Validate registrations',
			scope_iad: 'Invite other Authorities',
			scope_uai: 'Update Authority Information',
			scope_ceb: 'Create/Edit ballot templates',
			scope_mel: 'Manage Elections',
			scope_cap: 'Configure Authority Peers',
			scope_ik: 'Invite Keyholders',
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
			accruingVotes: 'Accruing Votes',
			hashingVotes: 'Hashing Votes',
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
			// Keyholder card / KeyholderScreen: the invite-status line (accepted / declined / pending).
			keyholderStatusLabel: 'Status',
			keyholderStatusDeclined: 'Declined',
			keyholderStatusSent: 'Sent',
			keyholderStatusNoLongerValid: 'No longer valid - send again',
			keyholderStatusUnknown: 'Status unavailable',
			keyholderStatusNotSent: 'Not sent',
			// A read that could not reach the other devices (Authority / Election details): shown instead
			// of rendering the failure as missing data.
			peerReadUnavailableTitle: "Can't reach other devices right now",
			peerReadUnavailableBody: "This device couldn't read this information from the network. Nothing has been deleted. Try again in a moment.",
			peerReadUnavailableStaleBody: "Showing what this device last read. It couldn't refresh from the network just now.",
			peerReadUnavailableRetry: 'Try Again',
			bootNetworkLoadFailed: "We couldn't open this network on this device.",
			bootTryAgain: "Try Again",
			bootStartFresh: "Start Fresh",
			authorityNotOnNetworkTitle: "This authority isn't on this network",
			authorityNotOnNetworkBody: "This device couldn't find it in the network that's open now. Go back and choose it from the Authorities list.",
			authorityDetailsLoadFailed: "Couldn't open this authority. Try again.",
			authoritiesLoadFailed: "Couldn't load authorities. Try again.",
			authorityPinFailed: "Couldn't update pinned authorities. Try again.",
			officersLoadFailed: "Couldn't load this administration's officers. Try again.",
			invitedAuthoritiesLoadFailed: "Couldn't load invited authorities. Try again.",
			peerWriteUnavailable: "Couldn't reach other devices to save this. Try again in a moment.",
			electionsLoadFailed: "Couldn't load elections. Try again.",
			tasksLoadFailed: "Couldn't load tasks. Try again.",
			settingsLoadFailed: "Couldn't load some settings. Try again.",
			keyholderPolicyTooFewKeyholders: 'Add at least two keyholders, so no single person can unlock the results early.',
			keyholderPolicyThresholdTooLow: 'At least two keyholders must be needed to unlock the results.',
			keyholderPolicyThresholdAboveCount: 'The number of keyholders needed cannot be more than the number of keyholders.',
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
			screenScaffoldsDebugIntro:
				'Direct entry points for the six onboarding screens. Temporary dev route per D-12; replaced by real callers in phases 8–10.',
			// Phase 8 gap-closure 08-07 — interim accept/send-mode invitation entries
			debugAdministratorInvitationAccept: 'Administrator Invitation (Accept)',
			debugAuthorityInvitationSend: 'Authority Invitation (Send)',
			debugAuthorityInvitationAccept: 'Authority Invitation (Accept)',
			// Frame 2 — Invitation sent (initial confirmation)
			editElectionTitle: 'Invitation Sent',
			editElectionBodyPrimary:
				'Your invitation has been sent. You will be notified when the recipient responds.',
			editElectionBodySecondary: 'If no response is received soon, you can resend the invitation.',
			editElectionResend: 'Resend',
			editElectionBackToTasks: 'Back to Tasks',
			// Frame 7 — Awaiting response
			authorityDetailTitle: 'Awaiting Response',
			authorityDetailBodyPrimary: 'Waiting for the recipient to respond to your invitation.',
			authorityDetailBodySecondary:
				'You can resend the invitation or cancel it if no longer needed.',
			authorityDetailResend: 'Resend Invitation',
			authorityDetailCancelInvitation: 'Cancel Invitation',
			authorityDetailAlreadyAnswered: "This invitation has already been answered, so it can't be withdrawn or sent again.",
			authorityDetailActionFailed: "Couldn't update this invitation. Try again.",
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
			loading: 'Loading...',
			invitationNeedsNetwork: 'Select a network first, then open this invitation again.',
			invitationLoadFailed: "This invitation couldn't be loaded. Go back and try again.",
			keyholderDkgLoadError: 'Could not check key generation. Leave this screen and open it again to retry.',
			keyholderDkgError: 'Key generation could not continue on this device. Open this screen again to retry.',
			keyholderUnnamed: '(no name)',
			officerIntakeKeyContestedWarning: 'Another officer has published the same encryption key as you. Requests are still sealed to you, but tell your administrators: someone may have copied your key.',
			pendingInvitationsHeading: 'Pending invitations',
			pendingInvitationsEmpty: 'No pending invitations.',
			pendingInvitationsLoadError: 'Could not load pending invitations.',
			pendingInvitationsRetry: 'Try again',
			authorityDetailInviteeLabel: 'Invited',
			authorityDetailNotAuthorized: 'Only the officer who sent this invitation, or an administrator of this authority, can withdraw or re-send it.',
			authorityDetailMissingInvitation: 'This invitation could not be opened. Go back and choose it from the list.',
			invitationPastedSummary: 'Invitation pasted ({{role}})',
			invitationPastedClear: 'Clear',
			invitationRoleAdministrator: 'administrator',
			invitationRoleAuthority: 'authority',
			invitationRoleKeyholder: 'keyholder',
			invitationAcceptSuperseded: 'A newer copy of this invitation was sent. Ask the sender for the latest one.',
			networkFoundingExportFingerprintLabel: 'Network fingerprint',
			networkFoundingExportFingerprintHelp: 'Read this fingerprint to the person importing the file, by phone or in person. They must see the same value before they join.',
			networkFoundingImportFingerprintHeading: 'Check the network fingerprint',
			networkFoundingImportFingerprintBody: 'Ask the officer who sent this file to read the network fingerprint shown on their screen, then type it below.',
			networkFoundingImportFingerprintConfirmed: 'Fingerprint confirmed',
			networkFoundingImportFingerprintInputLabel: 'Fingerprint read by the sender',
			networkFoundingImportFingerprintMismatch: 'That fingerprint does not match this file. Check it again with the officer who sent it; if it still does not match, do not join and ask for the file again.',
			networkFoundingImportJoinButton: 'Join network',
			networkFoundingImportAnchorRequired: 'This file was not checked against a fingerprint, so it was not imported.',
			networkFoundingExportShareFailed: 'Could not share the file. It is still ready; try again.',
			networkFoundingExportSaveFailed: 'Could not save the file. It is still ready; try again.',
			// Spike 100 — "Invite voters": a join code for the Voter app.
			voterInviteButton: 'Invite voters',
			voterInviteGenerating: 'Preparing a join code…',
			voterInviteOwnerTitle: 'Manage who can join this network',
			voterInviteOwnerBody:
				'This phone will manage who can join this network: it will sign the join codes voters use. Keep this phone safe. Continue?',
			voterInviteOwnerConfirm: 'Continue',
			voterInviteCancel: 'Cancel',
			voterInviteNotOwner:
				'This phone cannot invite voters to this network. Ask the officer whose device manages this network to create the join code.',
			voterInviteFailed: 'Could not create a join code. Try again.',
			voterInviteFailedNoRelay:
				'Could not create a join code: this app has no relay set up, so other phones cannot reach this one. Install an app build that includes a relay address.',
			voterInviteFailedNotReachable:
				'Could not create a join code: this phone is not connected to its relay yet. Check Wi-Fi or mobile data, then try again.',
			voterInviteFailedNotFounder: 'Could not create a join code: only the officer who created this network can make join codes for it.',
			voterInviteFailedOpenTimeout: 'Could not create a join code: the network took too long to open. Try again.',
			voterInviteRetry: 'Try again',
			voterInviteReadyBody:
				'Voters can scan the QR code in the VoteTorrent Voter app under Settings, Join a network, or paste the join code there. Publish the network fingerprint below through an official channel so voters can check it.',
			voterInviteFingerprintHelp: "Voters see this fingerprint before they join. If it doesn't match the one you published, they should not join.",
			voterInviteExpires: 'Valid until {{when}}',
			voterInviteCopy: 'Copy join code',
			voterInviteShare: 'Share join code',
			voterInviteCopied: 'Join code copied',
			voterInviteCopyFailed: 'Could not copy the join code. Try Share instead.',
			voterInviteDone: 'Done',
			voterInviteShareMessage:
				'Join {{name}} in the VoteTorrent Voter app: Settings, Join a network, then paste this code. Network fingerprint: {{fingerprint}}\n\n{{code}}',
			// Invite voters QR, owner-trust notices and setting, and the Join a network screen.
			voterInviteQrOpen: 'Show QR code',
			voterInviteQrHint: 'Tap the QR code to show it full screen.',
			voterInviteQrThumbA11y: 'QR code for the join code. Double tap to show it full screen.',
			voterInviteQrClose: 'Close',
			voterInviteQrWarning: 'Anyone who scans this code can join this network until it expires. Show it only to the voters you want to invite.',
			voterInviteQrShareImage: 'Share QR image',
			voterInviteQrShareFailed: 'Could not share the QR image. Try Share join code instead.',
			voterInviteQrRenderFailed: 'This join code is too long to show as a QR code. Use Copy or Share instead.',
			ownerTrustReinviteTitle: 'Invite this phone again',
			ownerTrustReinviteBody: 'This phone does not remember which owners to trust on its network, so ask the election office for a new join code and join with it on the Join a network screen.',
			ownerTrustReinviteAction: 'Join a network',
			ownerTrustMemoryTitle: 'Owner trust is not being saved',
			ownerTrustMemoryBody: 'This phone could not open its saved list of trusted owners, so it will forget them when the app closes and you may need to be invited again. To stop the app from connecting this way, turn on Require saved owner trust in Settings, then reopen the app.',
			ownerTrustBlockedTitle: 'The network connection did not start',
			ownerTrustBlockedBody: 'This phone could not open its saved list of trusted owners, and Require saved owner trust is on, so it did not connect. Reopen the app to try again, or turn the setting off in Settings and then reopen the app to connect without saved trust.',
			ownerTrustOpenSettings: 'Open Settings',
			settingsRequireOwnerTrust: 'Require saved owner trust',
			settingsRequireOwnerTrustHelp: 'When on, this phone will not connect to the network if it cannot load its saved trusted owners. When off, it connects and shows a warning. Takes effect the next time the app starts.',
			joinNetworkButton: 'Join a network',
			joinNetworkTitle: 'Join a network',
			joinNetworkIntro: "Paste the join code the election office gave you. It connects this phone to that network and lets it trust the network's owners.",
			joinNetworkCodeLabel: 'Join code',
			joinNetworkCodePlaceholder: 'Paste the join code',
			joinNetworkPaste: 'Paste',
			joinNetworkPreviewCheck: 'Before you join, check that this fingerprint matches the one the election office published.',
			joinNetworkSubmit: 'Join network',
			joinNetworkStepAdmitting: 'Joining the network…',
			joinNetworkStepSyncing: 'Downloading the network…',
			joinNetworkStepVerifying: 'Checking the network matches the code…',
			joinNetworkJoinedTitle: 'You joined {{name}}',
			joinNetworkTrustNotSaved: 'You joined the network, but this phone could not save which owners to trust, so join again with a new code from the election office.',
			joinNetworkDone: 'Done',
			joinNetworkErrorInvalidCode: "This isn't a valid join code, so check that you copied all of it or ask the election office for a new one.",
			joinNetworkErrorNewerCode: 'This join code needs a newer version of the app, so update the app and try again.',
			joinNetworkErrorOlderCode: 'This join code was made by an older version of VoteTorrent, so ask the election office for a new one.',
			joinNetworkErrorNotJoinCode: "This isn't a VoteTorrent join code, so paste the one from the election office.",
			joinNetworkErrorExpired: 'This join code has expired, so ask the election office for a new one.',
			joinNetworkErrorUsedUp: 'This join code can no longer be used, so ask the election office for a new one.',
			joinNetworkErrorNotAdmitted: 'The network did not accept this code, so ask the election office for a new one.',
			joinNetworkErrorNoPeers: "We couldn't reach the network, so check your connection and try again.",
			joinNetworkErrorNotSynced: 'The network is taking too long to download, so check your connection and try again.',
			joinNetworkErrorDigestMismatch: "This network doesn't match the join code, so this phone did not join it; ask the election office for a new code.",
			joinNetworkErrorOpenFailed: "We couldn't open the network on this phone, so try again.",
			joinNetworkErrorGeneric: 'Something went wrong while joining, so try again.',
			joinNetworkErrorFounderCannotJoin: "This phone founded its own network, so it can't join a different network with a code.",
			keyholderAcceptSelfInvite: 'You sent this keyholder invitation, so you cannot accept it. Each keyholder must be a different person on their own device.',
			keyholderAcceptSeatHeld: 'This device already holds a keyholder seat for this election. Each keyholder needs their own device.',
			keyholderInviteExpiryLabel: 'Invitation valid for',
			keyholderInviteExpiryHour: '{{n}} hour',
			keyholderInviteExpiryHours: '{{n}} hours',
			keyholderInviteExpiryDays: '{{n}} days',
			keyholderInviteExpiresAt: 'Expires {{when}}',
			keyholderInviteExpiryOutOfRange: 'Choose one of the offered validity periods and send again.',
			keyholderInviteSendFailed: 'Could not send the invitation. Try again.',
			keyholderPolicyDuplicateName: 'Two keyholders have the same name. Give each keyholder a different name.',
			keyholderInvitePickInvitee: 'Choose who to invite',
			keyholderInviteNoPendingInvitees: 'Every keyholder on this election has already accepted.',
			a11yChooseNetwork: 'Choose network',
			a11yOpenSettings: 'Open settings',
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
			questionNeedsTwoOptions: 'Choice questions need at least two options.',
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
			done: 'Done',
			// Phase 10 plan 10-02 (KHUI-01/02) — D-17: en-only; Spanish deferred to Phase 11
			keyholder: 'Keyholder',
			keyholderInvitation: 'Keyholder Invitation',
			debugKeyholderInvitationSend: 'Keyholder Invitation (Send)',
			debugKeyholderInvitationAccept: 'Keyholder Invitation (Accept)',
			// Phase 11 plan 11-01 (D-11) — en mirrors added for es orphan keys (create/revise)
			create: 'Create', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			revise: 'Revise', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// D-03/D-05/D-09 ballot confirmation actions (31-05)
			submitForConfirmation: 'Submit for confirmation',
			withdrawConfirmation: 'Withdraw',
			statusProposed: 'Proposed',
			statusConfirmed: 'Confirmed',
			statusAwaitingConfirmation: 'Awaiting Confirmation',
			ballotSubmitFailed: 'Could not submit the ballot for confirmation. Try again.',
			ballotWithdrawFailed: 'Could not withdraw the ballot from confirmation. Try again.',
			ballotProposeFailed: 'Could not save the ballot. Try again.',
			ballotStateLoadFailed: "Couldn't check whether this ballot is out for confirmation, so editing is paused.",
			ballotStateRetry: 'Try Again',
			// Review round 2 (chunk B): ballot confirmation, request approval, invitation send, network/election load copy
			ballotProposeRefusedLocked: 'Another officer submitted this ballot for confirmation, so your changes were not saved. The submitted version is shown.',
			ballotProposeRefusedConfirmed: 'This ballot is already confirmed, so your changes were not saved. The confirmed version is shown.',
			ballotSubmitRefusedLocked: 'This ballot is already out for confirmation.',
			ballotSubmitRefusedConfirmed: 'This ballot is already confirmed.',
			ballotSubmitNeedsPropose: 'You have unsaved changes. Tap Propose to save them before you submit.',
			ballotSubmittedOwnTaskHint: 'Submitted. Confirm it from your Tasks.',
			ballotSubmittedOthersHint: 'Submitted. The other officers confirm it from their Tasks.',
			ballotOpenTasksLink: 'Open Tasks',
			ballotOutForConfirmationNote: 'Out for confirmation. Only the officer who submitted it can withdraw it.',
			ballotLoadFailed: 'Could not load this ballot. Try again.',
			registrationRequestNotFound: "This request isn't on this device yet. It may still be syncing.",
			registrationRequestLoadFailed: 'Could not load this request. Try again.',
			priorRejectionsUnavailable: "Could not check this requester's earlier rejections, so approval is paused. You can still reject.",
			registrationRequestChecklistIncomplete: 'Complete the verification checklist before approving.',
			registrationRequestNoTask: 'There is no approval task for this request on this device yet. Sync, then open the request again.',
			registrationRequestApproveFailed: 'Could not record the approval. Try again.',
			registrationRequestVoteFailed: 'Could not record your vote on this request. Try again.',
			invitationSendFailed: 'Could not create the invitation. Try again.',
			invitationNeedsAuthority: 'Open this screen from an authority to send an invitation.',
			invitationNeedsElection: 'Open this screen from an election to invite a keyholder.',
			invitationNetworkStarting: 'The network is still starting. Wait a moment and try again.',
			invitationNoNetwork: 'Create or select a network first.',
			invitationAuthorityUnresolved: "Could not find this network's authority, so no invitation was created.",
			networkCreateFailed: 'Could not create the network. Try again.',
			electionDetailsLoadFailed: 'Could not load this election. Try again.',
			electionBallotsLoadFailed: "Could not load this election's ballots. Try again.",
			electionShareFailed: 'Could not open the share options.',
			loadRetryButton: 'Try Again',
			// Debug seed keys — debug-only affordance; never appears in release UI
			debugSeedTasksTitle: 'Seed Pending Tasks (Debug)',
			debugSeedTasksSuccess: 'Pending tasks seeded — check Tasks tab',
			debugSeedTasksError: 'Seed failed: ',
			// Phase 39 plan 39-04 (DEBT-09 app-Jest gate) — DistrictsGroupsEditor range fields.
			from: 'From',
			to: 'To',
			add: 'Add',
			cancel: 'Cancel',
			// Phase 46 (D-11) — registrationPolicy* group; copy verbatim from 46-UI-SPEC.md § Copywriting Contract.
			// Navigation entry
			registrationPolicyEntryTitle: 'Registration Policy',
			// Screen header / section titles
			registrationPolicyFieldsSectionTitle: 'Fields',
			registrationPolicyDisclosureSectionTitle: 'Disclosure',
			registrationPolicyAttestationSectionTitle: 'Attestation',
			registrationPolicyIssuesSectionTitle: 'Policy Issues',
			// Scope gate (D-10)
			registrationPolicyReadOnlyBanner:
				'Viewing only. You need the {{scope}} permission to change this policy.',
			registrationPolicyReadOnlyNoOfficerBanner:
				'Viewing only. You are not a registered officer of this authority, so changes are disabled.',
			// Field editor (D-02)
			registrationPolicyKnownFieldLastName: 'Last Name',
			registrationPolicyKnownFieldFirstName: 'First Name',
			registrationPolicyDistrictFieldLabel: 'District',
			registrationPolicyDistrictFieldHint: 'Only if this election uses districts',
			registrationPolicyCustomFieldOption: 'Custom…',
			registrationPolicyCustomFieldPlaceholder: 'Field name',
			registrationPolicyExtraFieldBadge: 'Extra Field',
			registrationPolicyExtraFieldHint: 'Stored in Extra Fields, not a dedicated column',
			registrationPolicyTierLabel: 'Visibility',
			registrationPolicyTierPublic: 'Public',
			registrationPolicyTierSelective: 'Selective',
			registrationPolicyTierPrivate: 'Private',
			registrationPolicyRequirementRequired: 'Required',
			registrationPolicyRequirementOptional: 'Optional',
			registrationPolicyAddFieldButton: 'Add Field',
			registrationPolicyNoFieldsHeading: 'No fields configured yet',
			registrationPolicyNoFieldsBody: 'Add a field above to define what registrants must provide.',
			// Disclosure editor (D-03/D-04/D-05)
			registrationPolicyAudienceLabel: 'Audience',
			registrationPolicyAudienceEveryone: 'Everyone',
			registrationPolicyAudienceDistrict: 'Same district (neighboring voters)',
			registrationPolicyAudienceNotSet: 'Not set',
			registrationPolicyAudienceDistrictUnavailableHint:
				"Same-district disclosure isn't available yet — it needs BOTH a District field declared above AND a ballot template for this election that declares districts.",
			registrationPolicyNoDisclosureHeading: 'No selective fields yet',
			registrationPolicyNoDisclosureBody:
				"Selective-tier fields you add in Fields above will appear here so you can set who they're disclosed to.",
			registrationPolicyOrphanDisclosureFlag: 'Orphan disclosure:',
			registrationPolicyOrphanDisclosureBody: 'This audience rule has no matching selective field.',
			registrationPolicyMissingAudienceFlag: 'No audience set:',
			registrationPolicyMissingAudienceBody:
				"This selective field can't be disclosed to anyone until an audience is set.",
			registrationPolicySetAudienceButton: 'Set Audience',
			registrationPolicyRemoveButton: 'Remove',
			// Attestation editor — tri-state (D-07)
			registrationPolicyAttestationNotConfiguredLabel: 'Not configured — required by default',
			registrationPolicyAttestationNotConfiguredBody:
				'No policy has been set, so device attestation is REQUIRED for this election (the fail-closed default).',
			registrationPolicyAttestationRequiredLabel: 'Required',
			registrationPolicyAttestationRequiredBody:
				'Device attestation is explicitly required for this election.',
			registrationPolicyAttestationNotRequiredLabel: 'Not required',
			registrationPolicyAttestationNotRequiredBody:
				'Device attestation is explicitly turned off for this election.',
			registrationPolicyAttestationRequireButton: 'Require Attestation',
			registrationPolicyAttestationDontRequireButton: "Don't Require Attestation",
			registrationPolicyAttestationRevertButton: 'Revert to Default',
			// Policy editability window (D-13)
			registrationPolicyConfirmTitle: 'Change registration policy?',
			registrationPolicyConfirmRosterBody:
				'This election already has registrants. They were validated against the previous policy and will not be re-validated.',
			registrationPolicyConfirmWindowOpenBody:
				'Registration is already open for this election. Registrants who already signed up were validated against the previous policy and will not be re-validated.',
			registrationPolicyConfirmProceedButton: 'Proceed Anyway',
			registrationPolicyConfirmCancelButton: 'Keep Current Policy',
			// Per-row immediate-apply affordance (D-14)
			registrationPolicyRowSaving: 'Saving…',
			registrationPolicyRowSaved: 'Saved',
			registrationPolicyRowError: "Couldn't save",
			registrationPolicyRetryButton: 'Retry',
			// Phase 47 (D-04/D-05/D-07) — registrantList* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantListScreenTitle: 'Registrants',
			registrantListRosterScreenTitle: '{{electionTitle}} Registrants',
			registrantListSearchPlaceholder: 'Search by name',
			registrantListFilterStatusAll: 'All Statuses',
			registrantListFilterExpirationLabel: 'Expiration',
			registrantListFilterDistrictLabel: 'District',
			registrantListCountLabel: 'Showing {{shown}} of {{total}}',
			registrantListCountUnknown: 'Showing {{shown}}',
			registrantListLoadMoreButton: 'Load More',
			registrantListLoadingMore: 'Loading more…',
			registrantListEndOfList: 'End of list',
			registrantListEmptyHeading: 'No registrants match these filters',
			registrantListEmptyBody: 'Try a different status, district, or search term.',
			registrantListEmptyHeadingNoFilters: 'No registrants yet',
			registrantListEmptyBodyNoFilters:
				'Registrants will appear here once people register for this authority.',
			// Phase 47 (D-10) — registrantStatus* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantStatusActive: 'Active',
			registrantStatusSuspended: 'Suspended',
			registrantStatusRevoked: 'Revoked',
			// Phase 47 (D-12/D-13/D-14) — registrantDetail* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantDetailScreenTitle: 'Registrant',
			registrantDetailPublicTierTitle: 'Public',
			registrantDetailSelectiveTierTitle: 'Selective',
			registrantDetailPrivateTierTitle: 'Private',
			registrantDetailNoPublicTier: 'No public details recorded',
			registrantDetailNoSelectiveTier: 'No selective details recorded',
			registrantDetailNoPrivateTier: 'No private details recorded',
			registrantDetailSignorKeyLabel: 'Signed by',
			registrantDetailExpirationLabel: 'Expires',
			registrantDetailSelectiveAudiencePreviewTitle: 'Audience Preview',
			registrantDetailSelectiveAudiencePreviewHint:
				'Shows what each audience would receive if this election discloses selective details.',
			registrantDetailSelectiveDisclosedLabel: 'Disclosed',
			registrantDetailSelectiveNotDisclosedLabel: 'Not disclosed to this audience',
			registrantDetailPrivateMaskedValue: '••••••',
			registrantDetailPrivateRevealHint: 'Tap to reveal',
			registrantDetailPrivateHideHint: 'Tap to hide',
			registrantDetailPrivateGateHeading: 'Private details require the {{scope}} permission',
			// Phase 47 (D-10) — registrantLifecycle* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantLifecycleRenewButton: 'Renew Registration',
			registrantLifecycleReinstateButton: 'Reinstate to Active',
			registrantLifecycleSuspendButton: 'Suspend Registrant',
			registrantLifecycleRevokeButton: 'Revoke Registration',
			registrantLifecycleRenewTitle: 'Renew registration?',
			registrantLifecycleRenewBody: "Extends {{name}}'s registration to {{newExpiration}}.",
			registrantLifecycleReinstateTitle: 'Reinstate to active?',
			registrantLifecycleReinstateBody: "Changes {{name}}'s status from {{oldStatus}} to Active.",
			registrantLifecycleSuspendTitle: 'Suspend {{name}}?',
			registrantLifecycleSuspendBody:
				"This immediately changes {{name}}'s status to Suspended. There is no automatic undo — reinstating requires a separate signed action. Type {{name}}'s name to confirm.",
			registrantLifecycleRevokeTitle: "Revoke {{name}}'s registration?",
			registrantLifecycleRevokeBody:
				"This immediately and permanently revokes {{name}}'s voter registration. There is no undo. Type {{name}}'s name to confirm.",
			registrantLifecycleTypedConfirmPlaceholder: 'Type {{name}} to confirm',
			registrantLifecycleKeepCurrentStatus: 'Keep Current Status',
			registrantLifecycleKeepCurrentExpiration: 'Keep Current Expiration',
			registrantLifecycleConfirmRenewal: 'Confirm Renewal',
			registrantLifecycleConfirmReinstatement: 'Confirm Reinstatement',
			// Browser pairing (Pair a browser screen, Paired browsers list, owner pairing log and switch).
			// No phase number or decision id may appear in these strings.
			dashboardPairingTitle: 'Pair a browser',
			dashboardPairingChecking: 'Checking whether this phone can pair a browser…',
			dashboardPairingIdleBody:
				"Pair a computer's browser so it follows this network live. The browser can read what you can see and can't change anything.",
			dashboardPairingRequestButton: 'Request pairing code',
			dashboardPairingConfirmHeading: 'Request a pairing code?',
			dashboardPairingConfirmBody:
				'The code lets one browser follow this network as you and read everything you can see. Anyone who has it can use it once until it expires.',
			dashboardPairingWaitingHeading: 'Asking the network owner…',
			dashboardPairingWaitingBody: "An owner's Authority app must be open and online to make the code. Keep it open.",
			dashboardPairingCancelButton: 'Cancel pairing request',
			dashboardPairingReadyHeading: 'Pairing code ready',
			dashboardPairingReadyBody:
				"Scan this QR code with the browser's camera, or copy the code and paste it there. It works once and expires in {{minutes}} minutes.",
			dashboardPairingCountdown: 'Expires in {{remaining}}',
			dashboardPairingQrHint: 'Tap the QR code to enlarge it',
			dashboardPairingQrTileLabel: 'Pairing QR code, tap to enlarge',
			dashboardPairingShowQrButton: 'Show QR code',
			dashboardPairingCopyButton: 'Copy code',
			dashboardPairingShareButton: 'Share code',
			dashboardPairingFinishButton: 'Finish pairing',
			dashboardPairingCopied: 'Code copied',
			dashboardPairingCopyFailed: "Couldn't copy the code. Share it instead.",
			dashboardPairingShareFailed: "Couldn't open the share sheet. Copy the code instead.",
			dashboardPairingQrWarning:
				'Anyone with this code can pair a browser as you until it expires. Show it only to your own computer.',
			dashboardPairingQrTooLarge: 'This code is too large to show as a QR code. Copy or share it instead.',
			dashboardPairingQrClose: 'Close',
			dashboardPairingQrShareImage: 'Share QR image',
			dashboardPairingQrShareFailed: "Couldn't share the image. Copy or share the code instead.",
			dashboardPairingQrRenderFailed: "Couldn't draw the QR code. Copy or share the code instead.",
			dashboardPairingUsed: 'This code has been used.',
			dashboardPairingPairAnotherButton: 'Pair another browser',
			dashboardPairingExpired: 'This code has expired. Request a new one.',
			dashboardPairingOwnerUnreachableHeading: 'No owner is reachable.',
			dashboardPairingOwnerUnreachableBody: "Keep the owner's Authority app open on their phone and try again.",
			dashboardPairingRetryButton: 'Retry request',
			dashboardPairingSwitchedOff: 'The owner has turned browser pairing off. Ask them to turn it on.',
			dashboardPairingNotAllowed: "The owner didn't accept this request. Make sure your officer key is current.",
			dashboardPairingUnavailable: "Pairing isn't available right now.",
			dashboardPairingUnavailableNoNetwork: 'Join a network first.',
			dashboardPairingUnavailableNotOfficer: 'Only officers can pair a browser.',
			dashboardPairingUnavailableNoKey: 'Set up your signing key first.',
			dashboardPairingBuildFailed: "Couldn't make a pairing code. Try again.",
			pairedBrowsersTitle: 'Paired browsers',
			pairedBrowsersIntro: 'Browsers that follow this network as you. Each can read what you can see; none can change anything.',
			pairedBrowsersDefaultLabel: 'Browser paired {{date}}',
			pairedBrowsersPairedAt: 'Paired {{date}}',
			pairedBrowsersLastSeenFewMinutes: 'Last seen a few minutes ago',
			pairedBrowsersLastSeenMinutes: 'Last seen {{n}} min ago',
			pairedBrowsersLastSeenHours: 'Last seen {{n}} h ago',
			pairedBrowsersLastSeenDays: 'Last seen {{n}} days ago',
			pairedBrowsersNotSeenYet: 'Not seen yet',
			pairedBrowsersLastSeenFootnote: 'Last seen updates about every 8 minutes.',
			pairedBrowsersStateWaiting: 'Waiting to pair',
			pairedBrowsersStatePaired: 'Paired',
			pairedBrowsersStateRemovalPending: 'Removal pending',
			pairedBrowsersStateRemoved: 'Removed',
			pairedBrowsersRemoveButton: 'Remove',
			pairedBrowsersRemoveConfirmHeading: 'Remove this browser?',
			pairedBrowsersRemoveConfirmBody:
				"The browser will delete its local copy and go back to the pairing screen. It will also lose its way into the network. Data it has already received can't be taken back, so remove a browser as soon as you stop trusting it.",
			pairedBrowsersRemoveConfirmButton: 'Remove browser',
			pairedBrowsersKeepButton: 'Keep browser',
			pairedBrowsersRemovalPendingLine:
				'Removed here. Waiting for an owner to finish removing it from the network. This will retry automatically.',
			pairedBrowsersEmptyHeading: 'No paired browsers',
			pairedBrowsersEmptyBody: 'Pair a computer to follow this network live.',
			pairedBrowsersPairButton: 'Pair a browser',
			pairedBrowsersLocalLabelsNote: 'Names and pairing times are kept on this phone only.',
			pairedBrowsersLoadError: "Couldn't load paired browsers. Pull to retry.",
			pairedBrowsersRemoveFailed: "Couldn't remove this browser. Try again.",
			pairedBrowsersRemoveKeyNotCurrent: "Your signing key isn't current. Set it up again, then try removing this browser.",
			pairingMintLogSectionTitle: 'Browser pairing',
			pairingMintLogSwitchLabel: 'Allow officers to pair browsers',
			pairingMintLogSwitchHelpOn:
				'When an officer asks to pair a browser, this phone approves it automatically if their key checks out. Keep this app open for it to work.',
			pairingMintLogSwitchHelpOff: "Officers can't pair browsers until you turn this back on. Browsers already paired keep working.",
			pairingMintLogSwitchSaveFailed: "Couldn't save this setting. Try again.",
			pairingMintLogTitle: 'Pairing requests',
			pairingMintLogRow: '{{officerName}} · {{date}}',
			pairingMintLogUnknownOfficer: 'Unknown officer',
			pairingMintLogOutcomeApproved: 'Approved',
			pairingMintLogOutcomeKeyNotValid: 'Refused: key not valid',
			pairingMintLogOutcomeSwitchOff: 'Refused: switch off',
			pairingMintLogOutcomeNotOfficer: 'Refused: not an officer',
			pairingMintLogOutcomeRefused: 'Refused',
			pairingMintLogOutcomeUnreachable: 'Unreachable',
			pairingMintLogEmpty: 'No pairing requests yet.',
			pairingMintLogFootnote: 'Showing the last {{n}} requests on this phone.',
			pairingMintLogUnreadable: "Couldn't read the pairing requests on this phone.",
			// Phase 47 (D-01/D-02/D-14) — registrantAccessTrail* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantAccessTrailSectionTitle: 'Access History',
			// D-01: load-bearing framing — accountability/transparency, NOT a security control. Do not paraphrase.
			registrantAccessTrailDisclaimer:
				'Records when an officer viewed private details for this registrant through this app, and which fields were revealed — for accountability and transparency, not as a security control. It only captures access made through this app; direct database access is not recorded here.',
			registrantAccessTrailEmptyHeading: 'No recorded access yet',
			registrantAccessTrailEmptyBody:
				"Private details haven't been revealed for this registrant through this app.",
			registrantAccessTrailRow: '{{viewer}} revealed {{fields}} — {{timestamp}}',
			// Phase 47 (D-03) — associationList* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			associationListSectionTitle: 'Associated Devices',
			associationListEmptyHeading: 'No devices associated',
			associationListEmptyBody: 'This registrant has not associated a device yet.',
			associationListDeviceKeyLabel: 'Device Key',
			associationListExpirationLabel: 'Expires',
			associationListRemoveButton: 'Remove Association',
			associationListRemoveTitle: 'Remove this device association?',
			associationListRemoveBody:
				'{{name}} will need to associate a device again before voting. This does not change their registration status.',
			associationListRemoveConfirm: 'Remove Association',
			associationListKeepAssociation: 'Keep Association',
			// Phase 47 (D-11) — attestationChallenge* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationChallengeSectionTitle: 'Attestation Challenges',
			attestationChallengeEmptyHeading: 'No outstanding challenges',
			attestationChallengeEmptyBody:
				'No attestation challenges are currently outstanding for this registrant.',
			attestationChallengeDeviceKeyLabel: 'Device Key',
			attestationChallengeElectionLabel: 'Election',
			attestationChallengeExpiryLabel: 'Expires',
			attestationChallengeExpireButton: 'Expire Challenge',
			attestationChallengeExpireTitle: 'Expire this challenge?',
			attestationChallengeExpireBody:
				"The device holding this challenge will no longer be able to complete attestation with it. A new challenge can only be issued by the device's own registration/association attempt.",
			attestationChallengeExpireConfirm: 'Expire Challenge',
			attestationChallengeKeepChallenge: 'Keep Challenge',
			// Phase 47 (D-03) — attestationVerdict* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationVerdictPass: 'Pass',
			attestationVerdictFail: 'Fail',
			attestationVerdictNone: 'No verdict yet',
			attestationVerdictReasonLabel: 'Reason',
			attestationVerdictVerifiedAtLabel: 'Verified',
			// Phase 47 (D-09) — attestationProvisioning* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationProvisioningScreenTitle: 'Device Attestation Setup',
			attestationProvisioningProvisionedHeading: 'Play Console keys are configured',
			attestationProvisioningProvisionedBody:
				'Device attestation is fully operational — new device associations can be verified.',
			attestationProvisioningNotProvisionedHeading: 'Play Console keys are not configured',
			attestationProvisioningNotProvisionedBody:
				'Device association will fail until Play Console key material is provisioned. Registrant and association data can still be viewed and managed normally.',
			attestationProvisioningSetupLink: 'These keys are set up by whoever builds and distributes this app. Contact them if this stays unconfigured.',
			attestationProvisioningInlineBannerBody:
				"Device attestation isn't configured. Associate ceremonies will fail closed until this is fixed.",
			attestationProvisioningInlineBannerLink: 'View setup status',
			// Phase 47 (D-08/D-13) — pollingDevice* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			pollingDeviceScreenTitle: 'Polling Devices',
			pollingDeviceAddButton: 'Add Polling Device',
			pollingDeviceLabelField: 'Label',
			pollingDeviceLabelPlaceholder: 'e.g. Precinct 4 tablet',
			pollingDeviceHashLabel: 'Device Hash',
			pollingDeviceRemoveButton: 'Remove',
			pollingDeviceRemoveTitle: 'Remove this polling device?',
			pollingDeviceRemoveBody:
				'{{label}} will no longer be able to operate as an in-person polling device for this authority. It can be added back at any time.',
			pollingDeviceRemoveConfirm: 'Remove Device',
			pollingDeviceKeepDevice: 'Keep Device',
			pollingDeviceEmptyHeading: 'No polling devices whitelisted',
			pollingDeviceEmptyBody:
				'Add a device to allow it to operate as an in-person polling device for this authority.',
			// Phase 47 (D-08/D-13) — authorityPeer* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			authorityPeerScreenTitle: 'Authority Peers',
			authorityPeerAddButton: 'Add Authority Peer',
			authorityPeerIdLabel: 'Peer ID',
			authorityPeerIdPlaceholder: 'Peer ID',
			authorityPeerRemoveButton: 'Remove',
			authorityPeerRemoveTitle: 'Remove this authority peer?',
			authorityPeerRemoveBody:
				"This peer will be dropped from this authority's P2P cluster. It can be added back at any time.",
			authorityPeerRemoveConfirm: 'Remove Peer',
			authorityPeerKeepPeer: 'Keep Peer',
			authorityPeerEmptyHeading: 'No authority peers configured',
			authorityPeerEmptyBody: "Add a peer to expand this authority's P2P cluster.",
			// 47-REVIEW IN-06. Deliberately carries NO {{peerId}} interpolation: the
			// rejected value is operator-supplied text and stays visible in the add
			// form's input, so naming it again in the message buys nothing and would
			// put unvalidated input inside a translated sentence.
			authorityPeerDuplicateError: 'That peer is already configured for this authority.',
			// D-13: UI legibility affordance, NOT the enforcement boundary — the schema's AdminSignature CHECK is the real control.
			authorityPeerScopeReadOnlyBanner:
				'Viewing only. You need the {{scope}} permission to change authority peers.',
			// Phase 47 (D-13) — registrantScope* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantScopeReadOnlyBanner:
				'Viewing only. You need the {{scope}} permission to change registrants, associations, or devices.',
			registrantScopeReadOnlyNoOfficerBanner:
				'Viewing only. You are not a registered officer of this authority, so changes are disabled.',
			// Phase 48 (D-01/D-03/D-09) — registrationRequest* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestScreenTitle: 'Registration Requests',
			registrationRequestSearchPlaceholder: 'Search by name',
			registrationRequestFilterStatusAll: 'All',
			registrationRequestFilterStatusPending: 'Pending',
			registrationRequestFilterStatusApproved: 'Approved',
			registrationRequestFilterStatusRejected: 'Rejected',
			registrationRequestFilterIssuerAll: 'All Sources',
			registrationRequestFilterIssuerRegistrant: 'Registrant-Submitted',
			registrationRequestFilterIssuerBridge: 'Bridge-Imported',
			registrationRequestCountLabel: 'Showing {{shown}} of {{total}}',
			registrationRequestCountUnknown: 'Showing {{shown}}',
			registrationRequestSortedByReceivedLabel: 'Sorted by date received (oldest first)',
			registrationRequestLoadMoreButton: 'Load More',
			registrationRequestLoadingMore: 'Loading more…',
			registrationRequestEndOfList: 'End of list',
			registrationRequestEmptyHeading: 'No requests match these filters',
			registrationRequestEmptyBody: 'Try a different status or source.',
			registrationRequestEmptyHeadingNoFilters: 'No registration requests yet',
			registrationRequestEmptyBodyNoFilters:
				'Requests submitted through any sync method will appear here for review.',
			registrationRequestBulkImportSyncButton: 'Bulk Import / Sync',
			// Phase 51 (D-06/D-19) — associationRequestStatus* group. Genuinely
			// control-free screen copy — no approve/reject/retry/sync strings here.
			associationRequestStatusScreenTitle: 'Association Requests',
			associationRequestStatusEmptyHeading: 'No association requests yet',
			associationRequestStatusEmptyBody:
				'Requests submitted by a device, or picked up by Sync Now, will appear here.',
			associationRequestStatusPendingLabel: 'Pending',
			associationRequestStatusChallengeIssuedLabel: 'Challenge Issued',
			associationRequestStatusAssociatedLabel: 'Associated',
			associationRequestStatusRejectedLabel: 'Rejected',
			associationRequestStatusSubmittedAtLabel: 'Submitted',
			associationRequestStatusReceivedAtLabel: 'Received',
			associationRequestStatusChallengeIssuedNote: 'A challenge has been issued for this request.',
			associationRequestStatusInboxButton: 'Association Requests',
			registrationRequestPreviouslyRejectedFlag: 'Previously rejected',
			registrationRequestReceivedAtLabel: 'Received',
			registrationRequestClaimedSubmittedAtLabel: 'Claimed sent',
			registrationRequestScopeReadOnlyBanner:
				'Viewing only. You need the {{scope}} permission to review registration requests.',
			registrationRequestScopeReadOnlyNoOfficerBanner:
				'Viewing only. You are not a registered officer of this authority, so changes are disabled.',
			registrationRequestStatusPending: 'Pending',
			registrationRequestStatusApproved: 'Approved',
			registrationRequestStatusRejected: 'Rejected',
			registrationRequestStatusClosedDuplicate: 'Closed',
			// Phase 48 (D-06/D-07) — registrationRequestApproval* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestApprovalScreenTitle: 'Request Detail',
			registrationRequestApprovalSummaryTitle: 'Request',
			registrationRequestApprovalReceivedAtLabel: 'Received',
			registrationRequestApprovalSubmittedAtLabel: 'Claimed sent',
			registrationRequestApprovalRequesterKeyLabel: 'Requester Key',
			// Labels for the payload fields the Voter app submits (public name tier, private details,
			// selective party). Any other field name renders as a humanized form of its key.
			registrationRequestFieldFirstName: 'First name',
			registrationRequestFieldLastName: 'Last name',
			registrationRequestFieldDob: 'Date of birth',
			registrationRequestFieldEmail: 'Email',
			registrationRequestFieldPhone: 'Phone number',
			registrationRequestFieldAddressLine1: 'Address line 1',
			registrationRequestFieldAddressLine2: 'Address line 2',
			registrationRequestFieldAddressLine3: 'Address line 3',
			registrationRequestFieldParty: 'Party',
			registrationRequestApprovalApproveButton: 'Approve Registration',
			registrationRequestApprovalRejectButton: 'Reject Request',
			registrationRequestApprovalApprovedByLabel: 'Approved by {{officer}} on {{date}}',
			registrationRequestApprovalViewRegistrantButton: 'View Registrant',
			// Phase 48 (D-06) — registrationRequestReject* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestRejectTitle: 'Reject this request?',
			registrationRequestRejectBody:
				'This will be recorded permanently with your name attached. If {{name}} submits again, this rejection and your reason will be shown to whoever reviews it next.',
			registrationRequestRejectReasonPlaceholder: 'Reason for rejection',
			registrationRequestRejectConfirmButton: 'Confirm Rejection',
			registrationRequestRejectKeepReviewingButton: 'Keep Reviewing',
			registrationRequestRejectChecklistRequired: 'Complete the verification checklist before rejecting.',
			registrationRequestRejectFailed: 'Could not record the rejection. Try again.',
			registrationRequestUnverifiable: "This request's signature can't be verified, so it can't be approved or rejected here. No signature of yours was used.",
			// Phase 48 (D-03) — bridgeSource* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			bridgeSourceBadgeLabel: 'Bridge Import',
			bridgeSourceCalloutHeading: 'Submitted by an import bridge',
			bridgeSourceCalloutBody:
				"This request was signed by {{bridgeLabel}}, an import bridge, on the submitter's behalf. It is the bridge's assertion, not a signature from the registrant themselves. Verify accordingly.",
			// Phase 48 (D-07) — verificationChecklist* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			verificationChecklistSectionTitle: 'Out-of-Band Verification',
			verificationChecklistItemId: 'Verified government-issued photo ID',
			verificationChecklistItemRoll: 'Checked against existing voter roll',
			verificationChecklistItemEligibility:
				'Confirmed eligibility (age, residency, citizenship per policy)',
			verificationChecklistItemNone: 'No additional out-of-band verification performed',
			verificationChecklistBindingNotice:
				'This checklist becomes part of your signed approval and cannot be changed afterward.',
			verificationChecklistDecidedAtLabel: 'Recorded at decision',
			// Phase 48 (D-06) — priorRejections* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			priorRejectionsCalloutHeading: 'This requester was rejected before',
			priorRejectionsCalloutRow: 'Rejected {{date}} by {{officer}} — {{reason}}',
			// Phase 48 (D-09) — transparencyStats* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			transparencyStatsSectionTitle: 'Transparency',
			transparencyStatsPendingLabel: 'Pending',
			transparencyStatsApprovedLabel: 'Approved',
			transparencyStatsRejectedLabel: 'Rejected',
			transparencyStatsMedianTimeLabel: 'Median time to decision',
			transparencyStatsMedianTimeUnknown: 'Not enough data yet',
			// Phase 48 (D-01/D-11) — bulkImportSync* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			bulkImportSyncScreenTitle: 'Bulk Import / Sync',
			bulkImportSyncFilesystemHeading: 'Filesystem',
			bulkImportSyncRestHeading: 'Webhook / REST',
			bulkImportSyncNeverSyncedBody: 'Not synced yet',
			bulkImportSyncSyncedBody: 'Sync completed.',
			bulkImportSyncErrorBody:
				'Sync failed. No sync method is connected, or the connected one could not be reached.',
			// bulkImportSyncLastSyncedLabel is no longer a body key — it is a separate line rendered
			// only when a real timestamp exists (48-UAT.md gap 1).
			bulkImportSyncLastSyncedLabel: 'Last successful sync {{date}}',
			bulkImportSyncImportedCountLabel: '{{count}} imported',
			bulkImportSyncPendingCountLabel: '{{count}} pending review',
			bulkImportSyncErrorCountLabel: '{{count}} errors',
			bulkImportSyncNowButton: 'Sync Now',
			bulkImportSyncErrorsSectionTitle: 'Sync Errors',
			// 62-UI-SPEC Surface 1 — peerSyncCard* group (D-31). Consumer: 62-21.
			peerSyncCardHeading: 'Peer-to-Peer (Unverified on Devices)',
			peerSyncCardCaveat:
				'This sync method is code-complete but peer delivery not yet proven on devices. Use Filesystem or REST sync for dependable results.',
			peerSyncCardPendingLabel: '{{count}} pending',
			peerSyncCardSyncedLabel: '{{count}} synced',
			peerSyncCardFailedLabel: '{{count}} failed',
			peerSyncCardTryButton: 'Try Peer Sync (Unverified)',
			// 62-UI-SPEC Surface 1 — registrationBridgeConfig* group (D-29). Consumer: 62-25.
			registrationBridgeConfigHeading: 'Registration Bridge (REST)',
			registrationBridgeConfigUrlLabel: 'Bridge URL',
			registrationBridgeConfigUrlPlaceholder: 'https://your-bridge.example.org',
			registrationBridgeConfigSaveButton: 'Save Bridge URL',
			registrationBridgeConfigInvalidUrl: 'Enter a valid https URL',
			registrationBridgeConfigSavedConfirm: 'Bridge URL saved',
			registrationBridgeConfigUnsetHint: 'Save a bridge URL above to turn on REST sync.',
			registrationBridgeConfigSaveError: 'Could not save the bridge URL. Try again.',
			registrationBridgeConfigCoSignRequired:
				'This authority requires more than one officer to approve this change. Saving the bridge URL is not supported at that setting, so nothing was saved.',
			// 62-UI-SPEC Surface 2 — networkFounding* group (D-36). Consumer: 62-23.
			networkFoundingExportButton: 'Share Network',
			networkFoundingExportConfirmHeading: 'Share this network with another device?',
			networkFoundingExportConfirmBody:
				"This creates a file containing this network's founding records, signed by its original officers. Anyone who imports it joins the exact same network.",
			networkFoundingExportShareButton: 'Share File',
			networkFoundingExportError: 'Could not create the network file. Try again.',
			networkFoundingImportButton: 'Import Network',
			networkFoundingImportScreenTitle: 'Import Founding Bundle',
			networkFoundingImportChooseFileButton: 'Choose File',
			networkFoundingImportValidating: 'Checking signatures…',
			networkFoundingImportInvalidSignature:
				"This file's signatures don't check out. It may be corrupted or tampered with.",
			networkFoundingImportAlreadyJoined: 'You already have this network.',
			networkFoundingImportSuccess: 'Network joined',
			networkFoundingImportGenericError: 'Could not import this file.',
			networkFoundingExportCancelButton: "Don't Share",
			networkFoundingExportGenerating: 'Preparing the network file…',
			networkFoundingExportSaveButton: 'Save to this phone',
			networkFoundingExportDoneButton: 'Done',
			networkFoundingExportReadyBody:
				'The network file is ready. Share it, or save it to this phone and send it later.',
			networkFoundingExportSaved: 'Saved. You can now send the file from Files.',
			networkFoundingExportTextFallback:
				'This version of the app could not attach a file, so the network was shared as text. Save it as a .json file before importing.',
			networkFoundingImportViewNetworkButton: 'View Network',
			networkFoundingImportChooseAnotherFileButton: 'Choose a Different File',
			// 62-UI-SPEC Surface 3 — possibleDuplicate* group (D-44). Consumer: 62-27.
			possibleDuplicateHeading: 'This may be a duplicate request',
			possibleDuplicateBody:
				'Another pending request from {{name}} looks similar. Deciding this one will close the other as a duplicate.',
			possibleDuplicateViewOtherButton: 'View Other Request',
			possibleDuplicateClosedLabel: 'Closed as a duplicate of another request',
			possibleDuplicateCheckFailed:
				'Could not check for duplicate requests. Approval is paused until this check works.',
			// 62-UI-SPEC Surface 4 — associationApproval* group (D-41, D-45). Consumer: 62-27.
			associationApprovalScreenTitle: 'Device Change Request',
			associationApprovalNewDeviceLabel: 'New device',
			associationApprovalExistingDeviceLabel: 'Current device (will be retired)',
			associationApprovalCodeMatchedBadge: 'Matched by registration code',
			associationApprovalIdentityMatchedBanner:
				"This voter entered their identity details instead of a code. Compare them against the registrant's record below before approving.",
			associationApprovalApproveButton: 'Approve New Device',
			associationApprovalApproveConfirmHeading: 'Retire the current device?',
			// Deliberate deviation from the 62-UI-SPEC row (62-18: retirement follows the new
			// device's attestation, not the approve action, so "immediately" would be false).
			associationApprovalApproveConfirmBody:
				"Approving this request retires {{registrantName}}'s current device as soon as the new device finishes setting up. That device will no longer be able to vote. This cannot be undone.",
			associationApprovalRejectButton: 'Reject Request',
			associationApprovalApproveConfirmButton: 'Approve and Retire Device',
			associationApprovalKeepReviewingButton: 'Keep Reviewing',
			associationApprovalLoadError: 'Could not load this device change request. Try again.',
			associationApprovalDecisionError: 'Could not record your decision. Try again.',
			associationApprovalQueueRowTitle: 'Device change: {{registrantName}}',
			associationApprovalCodeUnmatchedBanner:
				'The registration code this voter entered does not match any registrant. You can only reject this request.',
			associationApprovalCodeUnverifiableBanner:
				"The registration code could not be checked against the registrant's record. You can only reject this request.",
			associationApprovalNoEvidenceBanner:
				'This voter sent neither a registration code nor identity details. You can only reject this request.',
			associationApprovalCandidatesHeading: 'Possible registrants',
			associationApprovalEnteredFieldsHeading: 'Entered by the voter',
			associationApprovalRegistrantRecordHeading: "Registrant's record",
			associationApprovalCoSignRequired:
				'This authority needs more than one officer to approve device changes, and co-signing is not available for them yet.',
			// 62-UI-SPEC Surface 4 settings toggle — registrationPolicyReassociation* group (D-46). Consumer: 62-27.
			registrationPolicyReassociationHeading: 'Device Change Requests',
			registrationPolicyReassociationManual: 'Review each one manually',
			registrationPolicyReassociationAutomatic: 'Process automatically, like a first device',
			registrationPolicyReassociationDefaultNote: 'Manual review is recommended and is the default.',
			registrationPolicyReassociationSaveError: 'Could not save this setting. Try again.',
			registrationPolicyReassociationCoSignRequired:
				'This authority needs more than one officer to change this setting, and co-signing is not available for it yet.',
			registrationPolicyReassociationLoadError: 'Could not read this setting. Try again later.',
			// 62-UI-SPEC Surface 5 — signatureTaskThreshold* group. Consumers: 62-12, 62-27.
			signatureTaskThresholdProgress: '{{signed}} of {{threshold}} signatures',
			signatureTaskThresholdReached: 'Threshold reached — more signatures can still be added',
			signatureTaskThresholdVoteRecorded: 'Your decision is recorded. Waiting for other officers.',
			signatureTaskThresholdUnreachable:
				'Too few officers can still approve this request, so it is refused.',
			// 62-UI-SPEC Surface 6 — keyholderDkg* group. Consumer: 62-26.
			keyholderDkgStatusPending: 'Waiting for other keyholders to join',
			// A threshold below 2 (e.g. a 1-of-1 policy) can never run key generation (the DKG needs
			// 2 <= threshold <= participants), so "waiting" would never end.
			keyholderDkgStatusThresholdTooLow:
				'Key generation needs a keyholder threshold of at least 2. Revise the election to require 2 or more keyholders.',
			keyholderDkgStatusInProgress: 'Generating key material…',
			keyholderDkgStatusComplete: 'Key generation complete',
			keyholderDkgStatusComplaint:
				"A problem was found with another keyholder's data. Generation will restart.",
			keyholderDkgStatusHeading: 'Key Generation',
			// 62-UI-SPEC Surface 6 — keyholderRelease[A-Z]* group (bare `keyholderRelease` above is
			// pre-existing and NOT part of this group). Consumer: 62-29.
			keyholderReleaseScreenTitle: 'Release Your Key Share',
			keyholderReleaseBody:
				'This election has entered the key release period. Releasing your share helps reconstruct the decryption key once enough keyholders have released theirs.',
			keyholderReleaseButton: 'Release My Share',
			keyholderReleaseSuccess: 'Your share has been released',
			// Election results (decrypt + validate + tally after the key release)
			resultsEntryTitle: 'Results',
			resultsScreenTitle: 'Election Results',
			resultsComputing: 'Decrypting and counting the votes on this device…',
			resultsLoadFailed: 'The results could not be read on this device. Tap Refresh to try again.',
			resultsNoElection: 'This election is not on this device yet. Sync, then tap Refresh.',
			resultsLockedTitle: 'Results are locked',
			resultsLockedBody: 'The votes stay encrypted until enough keyholders release their key shares.',
			resultsReleasedCount: 'Key shares released: {{released}} of {{needed}} needed',
			resultsNoElectionKey: 'The keyholders have not finished generating the election key yet.',
			resultsReleaseFrom: 'Keyholders can release their shares from {{date}}.',
			resultsUnavailableTitle: 'The results could not be computed',
			resultsUnavailableReason: 'Reason: {{reason}}',
			resultsValidVotes: 'Valid votes: {{count}}',
			resultsBlocks: 'Vote blocks: {{count}}',
			resultsInvalidVotes: 'Invalid votes (not counted): {{count}}',
			resultsExcludedVotes: 'Votes in rejected blocks (not counted): {{count}}',
			resultsKeyholdersUsed: 'Decrypted with {{count}} released key shares',
			resultsNoBallots: 'No confirmed ballot was found for this election.',
			resultsBallotVotes: 'Valid ballots: {{count}}',
			resultsOptionCount: '{{count}} ({{percent}}%)',
			resultsBlank: 'Left blank: {{count}}',
			resultsNotCounted: 'This question type is not counted yet. Answered: {{count}}',
			resultsTallyRoot: 'Tally root: {{root}}…',
			resultsRefresh: 'Refresh',
			resultsNoBlocksYet: 'No vote blocks have reached this device yet, so nothing is counted. Wait a minute, then tap Refresh.',
			resultsReceivedSoFar: 'Counted from the vote blocks this device has received so far. Tap Refresh to count again.',
			resultsPublishedTitle: 'Published count',
			resultsPublishedMatches: 'An officer published this count on {{date}}. It matches the count on this device.',
			resultsPublishedDiffers: 'An officer published a count from {{published}} vote blocks, and this device counted {{local}}. This device may not have every vote block yet.',
			resultsPublishedInvalid: 'A count was published, but it failed its signature or consistency check. Do not rely on it.',
			resultsNotPublishedTitle: 'Not published yet',
			resultsPublishOfficerOnly: 'An officer of this authority publishes the count. Voters and keyholders then see it next to their own.',
			resultsPublishWaitingForBlocks: 'Some vote blocks on this device are still arriving. Publish becomes available once they have.',
			resultsPublishExplain: 'Publishing signs this count with your key so every device can check it. A published count cannot be changed.',
			resultsPublish: 'Publish results',
			resultsPublishing: 'Publishing…',
			resultsPublishConfirmTitle: 'Publish these results?',
			resultsPublishConfirmBody: 'You are publishing the count of {{blocks}} vote blocks ({{votes}} valid votes) on this device. It cannot be changed afterwards. If you expect more blocks, wait and tap Refresh first.',
			resultsPublishCancel: 'Cancel',
			resultsPublishConfirm: 'Publish',
			resultsPublishNoKey: 'This device has no signing key, so it cannot publish. Set one up in Settings.',
			resultsPublishConflict: 'A different count is already published for this election. Nothing was written.',
			resultsPublishKeyMismatch: "This device's signing key is not one of your registered keys, so nothing was published.",
			resultsPublishInvalid: 'This count failed its own consistency check, so it was not published. Tap Refresh to count again.',
			resultsPublishNotOfficer: 'Only a current officer of this authority can publish the count. Nothing was written.',
			resultsPublishKeysNotReleased: 'The key shares are not all released on this device yet, so nothing was published.',
			resultsPublishFailed: 'The results could not be published. Try again.',
			keyholderReleaseError: 'Could not release your share. Try again.',
			keyholderReleaseInProgress: 'Releasing your share…',
			// officerIntakeKey* group — gap-fill, not in 62-UI-SPEC (D-04 recipient key). Consumer: 62-21.
			officerIntakeKeyHeading: 'Encrypted Intake',
			officerIntakeKeyBody:
				"Register an encryption key so voters' registration details are encrypted to you. The private key stays on this device.",
			officerIntakeKeyEnableButton: 'Enable Encrypted Intake',
			officerIntakeKeyEnabledConfirm: 'Encrypted intake enabled',
			officerIntakeKeyError: 'Could not enable encrypted intake. Try again.',
			// registrationContent* group — gap-fill (D-49 sealed registration content, 62-31). Consumer: 62-27.
			registrationContentNotRecipient:
				'This request was sealed before this device could read it. Another officer can review it.',
			registrationContentNoKey: 'Turn on encrypted intake on this device to read requests.',
			registrationContentUnreadable: 'This request could not be read on this device.',
			registrationContentTampered:
				"This request's contents do not match what the applicant signed. It cannot be approved.",
			// registrantPrivate* group — gap-fill (D-51 late-officer residual). Consumer: 62-32.
			registrantPrivateNotRecipient:
				'These private details were sealed before you became an officer, so they cannot be shown on this device.',
			registrantPrivateUnreadable: 'These private details could not be read on this device.',
			registrantSelectiveNotRecipient:
				'These selective-disclosure details were sealed before you became an officer, so they cannot be shown on this device.',
			registrantSelectiveUnreadable: 'These selective-disclosure details could not be read on this device.',
			registrantSelectiveTampered:
				"These selective-disclosure details do not match the registrant's signed record. Do not rely on them.",
			keyholderDkgStatusFailed: 'Needs attention. An officer should review this key generation.',
			officerIntakeKeySupersededBody:
				'Encrypted intake is turned on for your account on another of your devices. New registrations are sealed to that device.',
			officerIntakeRenewalFailedBody:
				'Your new signing key is ready, but encrypted intake was not renewed. Turn it on again in Bulk Import / Sync.',
			errorLoadFailedGeneric: "This couldn't be loaded. Please try again.",
			errorActionFailedGeneric: "That didn't work. Please try again.",
			validationRequired: 'A required field is empty. Fill it in and try again.',
			validationInvalid: "One of the values isn't valid. Check the form and try again.",
			dkgOverdueNotice: 'No response in about {{hours}} hours from: {{names}}.',
			dkgOverdueHelp:
				"Key generation continues only when every keyholder takes part, and nothing happens automatically. Ask them to open this election's keyholder screen in the app on their own device.",
			dkgOverdueUnnamed: "a keyholder who is not on this election's list",
			keyholderStatusAcceptAgain: 'Must accept again',
			keyholderReacceptOfficerNote:
				'This keyholder accepted an earlier version of this election. The election has changed since then, and keyholders accept each version separately, so the election key is made only by keyholders who agreed to the current version. Send a new invitation and ask them to accept it.',
			keyholderReacceptAcceptNote:
				'Keyholders accept one version of an election. If the election changes after you accept, an officer sends you a new invitation and you accept again, so the election key always matches the version you agreed to.',
			reassociationReviewAuthorityWide: 'This setting applies to every election of this authority.',
			reassociationReviewNoteCurrent: 'Current setting: {{value}}',
			reassociationReviewNoteWhere: 'To change it, open {{screen}} for this authority.',
			sealedBeforeOfficerExplanation:
				"Sealed details can be read only by the officers who could read them when they were sealed. Officers added later, or who turned on encrypted intake later, never get access to them. This is on purpose: no one can widen who reads a voter's details after the fact. An officer who could read them at the time handles this record.",
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
			useLocationComingSoon: 'Usar Ubicación (próximamente)',
			scan: 'Escanear',
			useBootstrap: 'Usar Bootstrap',
			enterAddressOrLocation: 'Ingresar dirección o ubicación...',
			enterBootstrapPlaceholder: 'Ingresar bootstrap...',
			syncConnected: 'Conectado',
			syncSyncing: 'Sincronizando',
			syncOffline: 'Sin conexión',
			syncNotConfigured: 'Sin configurar',
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
			invitationAcceptTitle: 'Aceptar una Invitación',
			invitationAcceptBody: 'Pega la invitación que alguien compartió contigo. Verás de quién es antes de aceptarla.',
			invitationAcceptContinue: 'Continuar',
			invitationAcceptPasteHint: 'Pega el texto de la invitación que recibiste.',
			invitationAcceptPastePlaceholder: 'Pega la invitación aquí',
			invitationAcceptMalformed: 'Esto no parece una invitación completa. Cópiala de nuevo y pégala entera.',
			invitationAcceptWrongType: 'Esta invitación es para otra función. Ábrela desde Aceptar una Invitación en Ajustes.',
			invitationAcceptNotFound: 'Esta invitación aún no ha llegado a este dispositivo o ya no es válida.',
			invitationAcceptAlreadyAnswered: 'Esta invitación ya fue respondida. No se puede aceptar ni rechazar de nuevo.',
			invitationAcceptNoLongerValid: 'Esta invitación fue retirada o ha caducado. Pide una nueva a quien te la envió.',
			invitationAcceptExpired: 'Esta invitación caducó el {{when}}. Pide una nueva a quien te la envió.',
			invitationAcceptFailed: 'No se pudo responder a la invitación. Inténtalo de nuevo.',
			soleInitialAdministratorNote:
				'Cree un usuario en esta red. Su usuario será el único administrador inicial.',
			userIsSoleAdministratorNote:
				'El siguiente perfil de usuario será el único administrador inicial de la nueva autoridad.',
			expires: 'Expira',
			effective: 'Vigente desde',
			position: 'Cargo',
			switchingNetworks: 'Cambiando redes...',
			officer: 'Funcionario',
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
			multipleAuthorityNotYetSupportedNote: 'Múltiples autoridades aún no están soportadas.',
			mustSignBeforeCreating: 'Debe firmar antes de crear la red.',
			atLeastOneKeyholderRequired: 'Se requiere al menos un custodio.',
			invalidDate: 'Ingrese una fecha válida.',
			errAuthorityNameRequired: 'Ingrese un nombre de autoridad.',
			creating: 'Creando…',
			networkCreateTimeout:
				'La red no completó el paso {{step}} a tiempo. Puede que aún se complete: revise su lista de redes antes de volver a crearla.',
			networkCreateStillFinishing:
				'Todavía se está creando la red en este teléfono. Mantenga esta pantalla abierta; en algunos teléfonos tarda unos minutos.',
			networkCreateUnconfirmed:
				'No se pudo confirmar si la red fue creada. Puede que aún se esté completando: revise su lista de redes antes de volver a crearla, para no crearla dos veces.',
			errRelayRequired:
				'Agregue al menos una dirección de relay en Relays antes de crear la red.',
			errRelayInvalid:
				'Una dirección de relay en Relays no es una multidirección válida. Revísela e inténtelo de nuevo — por ejemplo /dns4/relay.example.com/tcp/443/wss/p2p/<id de par>.',
			validationFailed: 'Error de validación.',
			errTitleRequired: 'Ingrese un título para la elección.',
			errElectionDateRequired: 'Elija una fecha para la elección.',
			errRevisionDeadlineRequired: 'Elija una fecha límite de revisión.',
			errElectionDateInvalid: 'Ingrese una fecha de elección válida.',
			errRevisionDeadlineInvalid: 'Ingrese una fecha límite de revisión válida.',
			errRevisionDeadlineAfterDate:
				'La fecha límite de revisión debe ser igual o anterior a la fecha de la elección.',
			errElectionDateTooSoon:
				'La fecha de la elección es demasiado pronto: elija una fecha igual o posterior al {{date}} para que la fecha límite de boletas quede antes.',
			errBallotDeadlineAfterDate:
				'La fecha de la elección es demasiado pronto para la fecha límite de boletas. Elija una fecha de elección posterior.',
			errTimelineOrder:
				'Ordene el cronograma para que la votación comience antes del recuento, y el recuento antes de la certificación.',
			errThresholdExceedsKeyholders:
				'El umbral de firmas no puede ser mayor que el número de custodios.',
			errCouldNotSaveElection:
				'No se pudo guardar la elección. Revise las fechas e intente de nuevo.',
			errElectionSignerNotOfficer:
				'Este dispositivo no tiene un puesto de funcionario en esta red, por lo que no puede guardar elecciones aquí.',
			// PR-1: the founding field AddNetworkScreen renders; officer = funcionario (62-140 ruling).
			initialAdministrator: 'Funcionario Inicial',
			imageUrl: 'URL de Imagen',
			makePermanent: 'Hacer Permanente',
			mediaPinning: 'Haciendo permanente…',
			mediaPinned: 'Permanente · {{cid}}',
			mediaPinInvalidUrl: 'Primero ingresa un enlace http(s) completo',
			mediaPinNetwork: 'No se pudo descargar el archivo — revisa el enlace y tu conexión',
			mediaPinHttp: 'El servidor rechazó la descarga (error HTTP)',
			mediaPinTooLarge: 'El archivo es demasiado grande para hacerlo permanente (límite de 25 MB)',
			mediaPinEmpty: 'El enlace devolvió un archivo vacío',
			optionalImageAddress: 'Dirección de imagen opcional',
			primaryAuthority: 'Autoridad Primaria',
			authorityName: 'Nombre de la autoridad',
			authorityImageUrl: 'URL de la imagen de la autoridad',
			domainNameOptional: 'Nombre de Dominio (opcional)',
			initialOfficer: 'Funcionario Inicial',
			yourNameOnPermanentRecord: 'Tu nombre (en registro permanente)',
			yourTitleOnPermanentRecord: 'Tu título (en registro permanente)',
			sign: 'FIRMAR',
			applyRevisionNeedsCoSigners: 'Esta red requiere la aprobación de más de un funcionario para una revisión, lo cual aún no es compatible.',
			createNetwork: 'Crear Red',
			relays: 'Relays',
			relaysRequiredHint: 'Se requiere al menos un relay para que otros dispositivos puedan llegar a esta red.',
			createMissingFields: 'Antes de crear la red: {{fields}}.',
			missingNetworkName: 'ingrese un nombre de red',
			missingAuthorityName: 'ingrese el nombre de la autoridad principal',
			missingYourName: 'ingrese su nombre',
			missingYourTitle: 'ingrese su título',
			missingSignature: 'firme',
			missingRelay: 'agregue una dirección de relay',
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
			addOfficer: 'Agregar Funcionario',
			createProposal: 'Crear Propuesta',
			noNetworkTitle: 'Elige una red para comenzar',
			noNetwork:
				'Toca «Seleccionar Red» en la parte superior para unirte a una red existente, o crea la tuya propia.',
			selectNetwork: 'Seleccionar Red',
			networkSelectFailed: 'No se pudo abrir esta red. Inténtalo de nuevo.',
			networkDetailsLoadFailed: 'No se pudieron cargar los detalles de esta red. Inténtalo de nuevo.',
			applyRevisionFailed: 'No se pudo aplicar esta revisión. Inténtalo de nuevo.',
			remove: 'Eliminar',
			permissions: 'Permisos',
			publicKey: 'Clave Pública',
			proposedAdministration: 'Administración Propuesta',
			share: 'Compartir',
			invitationShareReady: 'La invitación está lista. Su clave no se muestra aquí: envíala con Compartir o Copiar.',
			invitationShareCopy: 'Copiar',
			invitationShareCopied: 'Copiado al portapapeles',
			inviteLeaveUnsharedTitle: '¿Salir sin compartir?',
			inviteLeaveUnsharedMessage: 'Esta invitación aún no se ha compartido ni copiado. Si sales ahora no se podrá volver a mostrar y tendrás que enviar una invitación nueva.',
			inviteLeaveUnsharedStay: 'Quedarse',
			inviteLeaveUnsharedLeave: 'Salir sin compartir',
			invitationShareCopyFailed: 'No se pudo copiar al portapapeles. Usa Compartir.',
			invitationShareSheetFailed: 'No se pudieron abrir las opciones para compartir. Prueba Copiar.',
			reviseAdministration: 'Revisar Administración',
			authorization: 'Autorización',
			adjustProposal: 'Ajustar Propuesta',
			serverConfigurationPlaceholder: '{"red": { "nombre": ...',
			inviteId: 'ID de Invitación',
			showHelpIcons: 'Mostrar iconos de ayuda',
			defaultUser: 'Usuario predeterminado',
			connectDevice: 'Conectar a usuario existente', // Shortened so it fits on one line; no forced break.
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
			revokeKeySignatureInvalid:
				'Esta revocación no pudo verificarse y no se aplicó.',
			// D-13/D-14/D-16: ver el bloque EN equivalente (mismas claves) para el
			// contexto completo — 49-UI-SPEC.md's Copywriting Contract.
			deviceSigningPromptTitle: 'Confirma tu identidad',
			deviceSigningPromptSubtitle: 'Verifica para firmar esta acción',
			deviceSigningPromptNegativeButton: 'Cancelar',
			signingKeyProvisioningPromptSubtitle: 'Verifica para configurar la firma segura',
			signingKeyRecoveryPromptSubtitle:
				'Verifica con el PIN, patrón o contraseña de tu dispositivo para reemplazar tu clave de firma',
			deviceSigningErrorNoBiometricsEnrolled:
				'Este dispositivo no tiene biometría registrada. Registra una huella o el rostro en la configuración del dispositivo e inténtalo de nuevo.',
			deviceSigningErrorLockout: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
			deviceSigningErrorLockoutPermanent:
				'La verificación biométrica está bloqueada. Desbloquea tu dispositivo con el PIN, patrón o contraseña para restablecerla, luego inténtalo de nuevo.',
			deviceSigningErrorGeneric: 'No se pudo verificar tu biometría. Inténtalo de nuevo.',
			deviceSigningErrorRecoveryKeyInvalidated:
				'La clave de recuperación de este dispositivo ya no se puede usar — se invalidó junto con tu clave de firma. Contacta a un administrador para volver a invitar este dispositivo.',
			deviceSigningErrorRecoveryKeyNotRegistered:
				'Tu clave de recuperación nunca se registró en esta red. Ve a Configuración y toca "Configurar Firma Segura" mientras estás conectado a tu red, luego intenta la recuperación de nuevo.',
			signingKeyProvisioningScreenTitle: 'Configuración de Firma Segura',
			signingKeyProvisioningFirstRunHeading: 'Configura la firma respaldada por hardware',
			signingKeyProvisioningFirstRunBody:
				'Tu firma de funcionario será producida por una clave almacenada en el hardware seguro de este dispositivo y protegida por tu biometría. La clave nunca sale del dispositivo.',
			signingKeyProvisioningSetupButton: 'Configurar Firma Segura',
			signingKeyProvisioningPending: 'Configurando tu clave de firma…',
			signingKeyProvisioningSuccessHeading: 'Clave de firma lista',
			signingKeyProvisioningSuccessBody: 'Ahora puedes firmar acciones de funcionario con tu biometría.',
			signingKeyProvisioningAwaitingNetworkHeading: 'La firma segura está configurada en este dispositivo',
			signingKeyProvisioningAwaitingNetworkBody:
				'Tu clave de firma está protegida por tu biometría. Selecciona o crea una red para terminar de registrarla.',
			signingKeyProvisioningContinueButton: 'Continuar',
			signingKeyProvisioningNetworkUserUnresolvedHeading: 'No pudimos encontrar tu cuenta en esta red',
			signingKeyProvisioningNetworkUserUnresolvedBody:
				'Este dispositivo está conectado a la red, pero tu cuenta de funcionario no aparece aquí. Si aún se está sincronizando, espera un momento e inténtalo de nuevo. Si esperar no ayuda, este dispositivo no tiene una cuenta de funcionario en esta red: pide a un funcionario que le envíe una invitación de administrador y acéptala en Ajustes > Aceptar una Invitación.',
			signingKeyProvisioningNetworkUserUnresolvedRetryButton: 'Intentar de Nuevo',
			signingKeyProvisioningNetworkUserUnresolvedInviteButton: 'Aceptar una Invitación',
			signingKeyProvisioningRecoveryHeading: 'Tu clave de firma debe reemplazarse',
			signingKeyProvisioningRecoveryBody:
				'La biometría de tu dispositivo cambió, lo que invalidó tu clave de firma anterior por seguridad. Verifica con el PIN, patrón o contraseña de tu dispositivo para firmar una clave de reemplazo.',
			signingKeyProvisioningRecoveryButton: 'Reemplazar Clave de Firma',
			signingKeyProvisioningRecoveryPending: 'Reemplazando tu clave de firma…',
			signingKeyProvisioningNoRecoveryHeading: 'Este dispositivo ya no tiene bloqueo de pantalla',
			signingKeyProvisioningNoRecoveryBody:
				'Tanto tu clave de firma como su clave de recuperación estaban protegidas por el bloqueo de pantalla de tu dispositivo, que fue eliminado. No se pueden recuperar en este dispositivo — pídele a un funcionario que invite a este dispositivo nuevamente.',
			signingKeyProvisioningRecoveryUnsupportedOsHeading: 'La recuperación no está disponible en esta versión de Android',
			signingKeyProvisioningRecoveryUnsupportedOsBody:
				'Reemplazar una clave de firma requiere Android 11 o una versión más reciente. Este dispositivo usa una versión anterior, por lo que su clave de firma no se puede reemplazar aquí — pídele a un funcionario que invite a este dispositivo nuevamente.',
			settingsSigningKeyRow: 'Firma Segura',
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
			connectDeviceUnavailable:
				'Conectar otro dispositivo a este usuario aún no está disponible. Esta versión de la aplicación no puede vincular dispositivos.',
			connectDeviceFailed:
				'No se pudieron preparar los datos de conexión. Asegúrate de haber seleccionado una red e inténtalo de nuevo.',
			connectDeviceNoUser:
				'Tu usuario aún no está configurado en esta red, así que este dispositivo no puede compartir los datos de conexión.',
			select: 'Seleccionar',
			hash: 'Hash',
			requiredTimestampAuthorities: 'Autoridades de Temporizador Requeridas',
			timestampAuthorities: 'Autoridades de Temporizador',
			// Phase 8 plan 08-05 (NETUI-02): label used in the Proposed Changes diff row.
			electionType: 'Tipo de Elección',
			reviseNetwork: 'Revisar Red',
			scope_rn: 'Revisar Red',
			scope_rad: 'Revisar o reemplazar la Administración',
			scope_vrg: 'Validar registros',
			scope_iad: 'Invitar a otras Autoridades',
			scope_uai: 'Actualizar la información de la Autoridad',
			scope_ceb: 'Crear/Editar plantillas de boletas',
			scope_mel: 'Gestionar Elecciones',
			scope_cap: 'Configurar los Pares de la Autoridad',
			scope_ik: 'Invitar Custodios de Clave',
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
			accruingVotes: 'Acumulando Votos',
			hashingVotes: 'Verificando Votos',
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
			keyholderStatusLabel: 'Estado',
			keyholderStatusDeclined: 'Rechazado',
			keyholderStatusSent: 'Enviada',
			keyholderStatusNoLongerValid: 'Ya no es válida - enviar de nuevo',
			keyholderStatusUnknown: 'Estado no disponible',
			keyholderStatusNotSent: 'No enviada',
			peerReadUnavailableTitle: 'No se puede conectar con otros dispositivos ahora',
			peerReadUnavailableBody: 'Este dispositivo no pudo leer esta información de la red. No se ha borrado nada. Inténtalo de nuevo en un momento.',
			peerReadUnavailableStaleBody: 'Mostrando lo último que leyó este dispositivo. No pudo actualizarse desde la red hace un momento.',
			peerReadUnavailableRetry: 'Intentar de Nuevo',
			bootNetworkLoadFailed: "No pudimos abrir esta red en este dispositivo.",
			bootTryAgain: "Intentar de Nuevo",
			bootStartFresh: "Empezar de Cero",
			authorityNotOnNetworkTitle: "Esta autoridad no está en esta red",
			authorityNotOnNetworkBody: "Este dispositivo no la encontró en la red abierta ahora. Vuelve atrás y elígela en la lista de autoridades.",
			authorityDetailsLoadFailed: "No se pudo abrir esta autoridad. Inténtalo de nuevo.",
			authoritiesLoadFailed: "No se pudieron cargar las autoridades. Inténtalo de nuevo.",
			authorityPinFailed: "No se pudieron actualizar las autoridades marcadas. Inténtalo de nuevo.",
			officersLoadFailed: "No se pudieron cargar los funcionarios de esta administración. Inténtalo de nuevo.",
			invitedAuthoritiesLoadFailed: "No se pudieron cargar las autoridades invitadas. Inténtalo de nuevo.",
			peerWriteUnavailable: "No se pudo conectar con otros dispositivos para guardar esto. Inténtalo de nuevo en un momento.",
			electionsLoadFailed: "No se pudieron cargar las elecciones. Inténtalo de nuevo.",
			tasksLoadFailed: "No se pudieron cargar las tareas. Inténtalo de nuevo.",
			settingsLoadFailed: "No se pudieron cargar algunos ajustes. Inténtalo de nuevo.",
			keyholderPolicyTooFewKeyholders: 'Agregue al menos dos custodios de clave, para que ninguna persona pueda abrir los resultados antes de tiempo.',
			keyholderPolicyThresholdTooLow: 'Se deben necesitar al menos dos custodios de clave para abrir los resultados.',
			keyholderPolicyThresholdAboveCount: 'La cantidad de custodios necesarios no puede ser mayor que la cantidad de custodios.',
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
			screenScaffoldsDebugIntro:
				'Puntos de entrada directos a las seis pantallas de incorporación. Ruta temporal de desarrollo; reemplazada por llamadas reales en las fases 8–10.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 gap-closure 08-07 — interim accept/send-mode invitation entries
			debugAdministratorInvitationAccept: 'Invitación de administrador (aceptar)',
			debugAuthorityInvitationSend: 'Invitación de autoridad (enviar)',
			debugAuthorityInvitationAccept: 'Invitación de autoridad (aceptar)',
			editElectionTitle: 'Invitación Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBodyPrimary:
				'Tu invitación ha sido enviada. Se te notificará cuando el destinatario responda.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBodySecondary: 'Si no se recibe respuesta pronto, puedes reenviar la invitación.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionResend: 'Reenviar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBackToTasks: 'Volver a Tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailTitle: 'Esperando Respuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailBodyPrimary: 'Esperando que el destinatario responda tu invitación.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailBodySecondary:
				'Puedes reenviar la invitación o cancelarla si ya no es necesaria.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailResend: 'Reenviar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailCancelInvitation: 'Cancelar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailAlreadyAnswered: 'Esta invitación ya fue respondida, así que no se puede retirar ni volver a enviar.',
			authorityDetailActionFailed: 'No se pudo actualizar esta invitación. Inténtalo de nuevo.',
			editElectionWithFilterTitle: 'Solicitud Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionWithFilterBodyPrimary: 'Tu solicitud ha sido enviada exitosamente.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionWithFilterGotIt: 'Entendido', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormTitle: 'Esperando Aprobación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormBodyPrimary:
				'Tu envío está pendiente de aprobación por parte de la autoridad.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormBodySecondary: 'Recibirás una notificación una vez que sea revisado.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormResend: 'Reenviar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormDismissRequest: 'Descartar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedElectionTitle: 'Solicitud de Liberación Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedElectionBodyPrimary:
				'Tu solicitud de liberación de clave ha sido entregada a los custodios.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
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
			addAdministrator: 'Agregar Funcionario', // PR-1: the add button ProposedAdministrationScreen renders (62-140 ruling).
			loading: 'Cargando...', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			invitationNeedsNetwork: 'Seleccione primero una red y luego vuelva a abrir esta invitación.',
			invitationLoadFailed: 'No se pudo cargar esta invitación. Vuelva atrás e inténtelo de nuevo.',
			keyholderDkgLoadError: 'No se pudo comprobar la generación de claves. Sal de esta pantalla y vuelve a abrirla para reintentar.',
			keyholderDkgError: 'La generación de claves no pudo continuar en este dispositivo. Vuelve a abrir esta pantalla para reintentar.',
			keyholderUnnamed: '(sin nombre)',
			officerIntakeKeyContestedWarning: 'Otro funcionario publicó la misma clave de cifrado que tú. Las solicitudes se siguen cifrando para ti, pero avisa a tus administradores: alguien podría haber copiado tu clave.',
			pendingInvitationsHeading: 'Invitaciones pendientes',
			pendingInvitationsEmpty: 'No hay invitaciones pendientes.',
			pendingInvitationsLoadError: 'No se pudieron cargar las invitaciones pendientes.',
			pendingInvitationsRetry: 'Intentar de nuevo',
			authorityDetailInviteeLabel: 'Persona invitada',
			authorityDetailNotAuthorized: 'Solo el funcionario que envió esta invitación, o un administrador de esta autoridad, puede retirarla o reenviarla.',
			authorityDetailMissingInvitation: 'No se pudo abrir esta invitación. Vuelve atrás y elígela de la lista.',
			invitationPastedSummary: 'Invitación pegada ({{role}})',
			invitationPastedClear: 'Borrar',
			invitationRoleAdministrator: 'administrador',
			invitationRoleAuthority: 'autoridad',
			invitationRoleKeyholder: 'custodio de clave',
			invitationAcceptSuperseded: 'Se envió una copia más reciente de esta invitación. Pide la más reciente a quien te la envió.',
			networkFoundingExportFingerprintLabel: 'Huella de la red',
			networkFoundingExportFingerprintHelp: 'Lee esta huella a quien importe el archivo, por teléfono o en persona. Debe ver el mismo valor antes de unirse.',
			networkFoundingImportFingerprintHeading: 'Comprueba la huella de la red',
			networkFoundingImportFingerprintBody: 'Pide al funcionario que envió este archivo que lea la huella de la red que aparece en su pantalla y escríbela abajo.',
			networkFoundingImportFingerprintConfirmed: 'Huella confirmada',
			networkFoundingImportFingerprintInputLabel: 'Huella leída por el remitente',
			networkFoundingImportFingerprintMismatch: 'Esa huella no coincide con este archivo. Compruébala de nuevo con el funcionario que lo envió; si sigue sin coincidir, no te unas y pide el archivo otra vez.',
			networkFoundingImportJoinButton: 'Unirse a la red',
			networkFoundingImportAnchorRequired: 'Este archivo no se comprobó con una huella, así que no se importó.',
			networkFoundingExportShareFailed: 'No se pudo compartir el archivo. Sigue listo; inténtalo de nuevo.',
			networkFoundingExportSaveFailed: 'No se pudo guardar el archivo. Sigue listo; inténtalo de nuevo.',
			// Spike 100 — ver el bloque `en`.
			voterInviteButton: 'Invitar a votantes',
			voterInviteGenerating: 'Preparando un código de acceso…',
			voterInviteOwnerTitle: 'Gestionar quién puede unirse a esta red',
			voterInviteOwnerBody:
				'Este teléfono gestionará quién puede unirse a esta red: firmará los códigos de acceso que usan los votantes. Mantén este teléfono seguro. ¿Continuar?',
			voterInviteOwnerConfirm: 'Continuar',
			voterInviteCancel: 'Cancelar',
			voterInviteNotOwner:
				'Este teléfono no puede invitar a votantes a esta red. Pide al funcionario cuyo dispositivo gestiona esta red que cree el código de acceso.',
			voterInviteFailed: 'No se pudo crear un código de acceso. Inténtalo de nuevo.',
			voterInviteFailedNoRelay:
				'No se pudo crear un código de acceso: esta aplicación no tiene un relé configurado, así que otros teléfonos no pueden llegar a este. Instala una versión de la aplicación que incluya una dirección de relé.',
			voterInviteFailedNotReachable:
				'No se pudo crear un código de acceso: este teléfono todavía no está conectado a su relé. Revisa el Wi-Fi o los datos móviles e inténtalo de nuevo.',
			voterInviteFailedNotFounder: 'No se pudo crear un código de acceso: solo el funcionario que creó esta red puede crear códigos de acceso para ella.',
			voterInviteFailedOpenTimeout: 'No se pudo crear un código de acceso: la red tardó demasiado en abrirse. Inténtalo de nuevo.',
			voterInviteRetry: 'Intentar de nuevo',
			voterInviteReadyBody:
				'Los votantes pueden escanear el código QR en la aplicación VoteTorrent Voter, en Ajustes, Unirse a una red, o pegar allí el código de acceso. Publica la huella de la red que aparece abajo por un canal oficial para que los votantes puedan comprobarla.',
			voterInviteFingerprintHelp: 'Los votantes ven esta huella antes de unirse. Si no coincide con la que publicaste, no deben unirse.',
			voterInviteExpires: 'Válido hasta {{when}}',
			voterInviteCopy: 'Copiar código de acceso',
			voterInviteShare: 'Compartir código de acceso',
			voterInviteCopied: 'Código de acceso copiado',
			voterInviteCopyFailed: 'No se pudo copiar el código de acceso. Prueba a compartirlo.',
			voterInviteDone: 'Listo',
			voterInviteShareMessage:
				'Únete a {{name}} en la aplicación VoteTorrent Voter: Ajustes, Unirse a una red, y pega este código. Huella de la red: {{fingerprint}}\n\n{{code}}',
			// Ver el bloque en.
			voterInviteQrOpen: 'Mostrar código QR',
			voterInviteQrHint: 'Toca el código QR para mostrarlo a pantalla completa.',
			voterInviteQrThumbA11y: 'Código QR del código de acceso. Toca dos veces para mostrarlo a pantalla completa.',
			voterInviteQrClose: 'Cerrar',
			voterInviteQrWarning: 'Cualquiera que escanee este código puede unirse a esta red hasta que caduque. Muéstralo solo a los votantes que quieras invitar.',
			voterInviteQrShareImage: 'Compartir imagen del QR',
			voterInviteQrShareFailed: 'No se pudo compartir la imagen del QR. Prueba a compartir el código de acceso.',
			voterInviteQrRenderFailed: 'Este código de acceso es demasiado largo para mostrarlo como código QR. Usa Copiar o Compartir.',
			ownerTrustReinviteTitle: 'Invita este teléfono de nuevo',
			ownerTrustReinviteBody: 'Este teléfono no recuerda en qué propietarios debe confiar en su red, así que pide un código de acceso nuevo a la oficina electoral y úsalo en la pantalla Unirse a una red.',
			ownerTrustReinviteAction: 'Unirse a una red',
			ownerTrustMemoryTitle: 'La confianza en los propietarios no se está guardando',
			ownerTrustMemoryBody: 'Este teléfono no pudo abrir su lista guardada de propietarios de confianza, así que los olvidará al cerrar la aplicación y quizá debas ser invitado de nuevo. Para evitar que la aplicación se conecte así, activa Exigir confianza de propietarios guardada en Ajustes y vuelve a abrir la aplicación.',
			ownerTrustBlockedTitle: 'La conexión a la red no se inició',
			ownerTrustBlockedBody: 'Este teléfono no pudo abrir su lista guardada de propietarios de confianza y Exigir confianza de propietarios guardada está activado, así que no se conectó. Vuelve a abrir la aplicación para intentarlo de nuevo, o desactiva la opción en Ajustes y luego vuelve a abrir la aplicación para conectarte sin confianza guardada.',
			ownerTrustOpenSettings: 'Abrir Ajustes',
			settingsRequireOwnerTrust: 'Exigir confianza de propietarios guardada',
			settingsRequireOwnerTrustHelp: 'Si está activado, este teléfono no se conectará a la red si no puede cargar sus propietarios de confianza guardados. Si está desactivado, se conecta y muestra una advertencia. Se aplica la próxima vez que se inicie la aplicación.',
			joinNetworkButton: 'Unirse a una red',
			joinNetworkTitle: 'Unirse a una red',
			joinNetworkIntro: 'Pega el código de acceso que te dio la oficina electoral. Conecta este teléfono a esa red y le permite confiar en los propietarios de la red.',
			joinNetworkCodeLabel: 'Código de acceso',
			joinNetworkCodePlaceholder: 'Pega el código de acceso',
			joinNetworkPaste: 'Pegar',
			joinNetworkPreviewCheck: 'Antes de unirte, comprueba que esta huella coincide con la que publicó la oficina electoral.',
			joinNetworkSubmit: 'Unirse a la red',
			joinNetworkStepAdmitting: 'Uniéndote a la red…',
			joinNetworkStepSyncing: 'Descargando la red…',
			joinNetworkStepVerifying: 'Comprobando que la red coincide con el código…',
			joinNetworkJoinedTitle: 'Te uniste a {{name}}',
			joinNetworkTrustNotSaved: 'Te uniste a la red, pero este teléfono no pudo guardar en qué propietarios confiar, así que vuelve a unirte con un código nuevo de la oficina electoral.',
			joinNetworkDone: 'Listo',
			joinNetworkErrorInvalidCode: 'Este no es un código de acceso válido, así que comprueba que lo copiaste completo o pide uno nuevo a la oficina electoral.',
			joinNetworkErrorNewerCode: 'Este código de acceso requiere una versión más reciente de la aplicación, así que actualízala e inténtalo de nuevo.',
			joinNetworkErrorOlderCode: 'Este código de acceso lo creó una versión anterior de VoteTorrent, así que pide uno nuevo a la oficina electoral.',
			joinNetworkErrorNotJoinCode: 'Este no es un código de acceso de VoteTorrent, así que pega el de la oficina electoral.',
			joinNetworkErrorExpired: 'Este código de acceso ha caducado, así que pide uno nuevo a la oficina electoral.',
			joinNetworkErrorUsedUp: 'Este código de acceso ya no se puede usar, así que pide uno nuevo a la oficina electoral.',
			joinNetworkErrorNotAdmitted: 'La red no aceptó este código, así que pide uno nuevo a la oficina electoral.',
			joinNetworkErrorNoPeers: 'No pudimos conectar con la red, así que comprueba tu conexión e inténtalo de nuevo.',
			joinNetworkErrorNotSynced: 'La red tarda demasiado en descargarse, así que comprueba tu conexión e inténtalo de nuevo.',
			joinNetworkErrorDigestMismatch: 'Esta red no coincide con el código de acceso, así que este teléfono no se unió a ella; pide un código nuevo a la oficina electoral.',
			joinNetworkErrorOpenFailed: 'No pudimos abrir la red en este teléfono, así que inténtalo de nuevo.',
			joinNetworkErrorGeneric: 'Algo salió mal al unirte, así que inténtalo de nuevo.',
			joinNetworkErrorFounderCannotJoin: 'Este teléfono creó su propia red, así que no puede unirse a otra red con un código.',
			keyholderAcceptSelfInvite: 'Tú enviaste esta invitación de custodio, así que no puedes aceptarla. Cada custodio debe ser una persona distinta en su propio dispositivo.',
			keyholderAcceptSeatHeld: 'Este dispositivo ya tiene un puesto de custodio en esta elección. Cada custodio necesita su propio dispositivo.',
			keyholderInviteExpiryLabel: 'Invitación válida durante',
			keyholderInviteExpiryHour: '{{n}} hora',
			keyholderInviteExpiryHours: '{{n}} horas',
			keyholderInviteExpiryDays: '{{n}} días',
			keyholderInviteExpiresAt: 'Caduca {{when}}',
			keyholderInviteExpiryOutOfRange: 'Elige uno de los periodos de validez ofrecidos y vuelve a enviar.',
			keyholderInviteSendFailed: 'No se pudo enviar la invitación. Inténtalo de nuevo.',
			keyholderPolicyDuplicateName: 'Dos custodios tienen el mismo nombre. Da a cada custodio un nombre distinto.',
			keyholderInvitePickInvitee: 'Elige a quién invitar',
			keyholderInviteNoPendingInvitees: 'Todos los custodios de esta elección ya aceptaron.',
			a11yChooseNetwork: 'Elegir red',
			a11yOpenSettings: 'Abrir ajustes',
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
			questionNeedsTwoOptions: 'Las preguntas de opción necesitan al menos dos opciones.',
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
			done: 'Listo', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 10 plan 10-02 (KHUI-01/02) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholder: 'Custodio de Clave', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholderInvitation: 'Invitación de Custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			debugKeyholderInvitationSend: 'Invitación de Custodio (Enviar)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			debugKeyholderInvitationAccept: 'Invitación de Custodio (Aceptar)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// D-03/D-05/D-09 ballot confirmation actions (31-05)
			submitForConfirmation: 'Enviar para confirmación',
			withdrawConfirmation: 'Retirar',
			statusProposed: 'Propuesto',
			statusConfirmed: 'Confirmado',
			statusAwaitingConfirmation: 'Esperando Confirmación',
			ballotSubmitFailed: 'No se pudo enviar la boleta para confirmación. Inténtalo de nuevo.',
			ballotWithdrawFailed: 'No se pudo retirar la boleta de la confirmación. Inténtalo de nuevo.',
			ballotProposeFailed: 'No se pudo guardar la boleta. Inténtalo de nuevo.',
			ballotStateLoadFailed: 'No se pudo comprobar si esta boleta está en confirmación, así que la edición está en pausa.',
			ballotStateRetry: 'Intentar de Nuevo',
			// Review round 2 (chunk B): ballot confirmation, request approval, invitation send, network/election load copy
			ballotProposeRefusedLocked: 'Otro funcionario envió esta boleta para confirmación, así que tus cambios no se guardaron. Se muestra la versión enviada.',
			ballotProposeRefusedConfirmed: 'Esta boleta ya está confirmada, así que tus cambios no se guardaron. Se muestra la versión confirmada.',
			ballotSubmitRefusedLocked: 'Esta boleta ya está en confirmación.',
			ballotSubmitRefusedConfirmed: 'Esta boleta ya está confirmada.',
			ballotSubmitNeedsPropose: 'Tienes cambios sin guardar. Toca Proponer para guardarlos antes de enviar.',
			ballotSubmittedOwnTaskHint: 'Enviada. Confírmala desde tus Tareas.',
			ballotSubmittedOthersHint: 'Enviada. Los demás funcionarios la confirman desde sus Tareas.',
			ballotOpenTasksLink: 'Abrir Tareas',
			ballotOutForConfirmationNote: 'En confirmación. Solo el funcionario que la envió puede retirarla.',
			ballotLoadFailed: 'No se pudo cargar esta boleta. Inténtalo de nuevo.',
			registrationRequestNotFound: 'Esta solicitud aún no está en este dispositivo. Puede que todavía se esté sincronizando.',
			registrationRequestLoadFailed: 'No se pudo cargar esta solicitud. Inténtalo de nuevo.',
			priorRejectionsUnavailable: 'No se pudieron comprobar los rechazos anteriores de este solicitante, así que la aprobación está en pausa. Aún puedes rechazar.',
			registrationRequestChecklistIncomplete: 'Completa la lista de verificación antes de aprobar.',
			registrationRequestNoTask: 'Todavía no hay una tarea de aprobación para esta solicitud en este dispositivo. Sincroniza y vuelve a abrir la solicitud.',
			registrationRequestApproveFailed: 'No se pudo registrar la aprobación. Inténtalo de nuevo.',
			registrationRequestVoteFailed: 'No se pudo registrar tu voto sobre esta solicitud. Inténtalo de nuevo.',
			invitationSendFailed: 'No se pudo crear la invitación. Inténtalo de nuevo.',
			invitationNeedsAuthority: 'Abre esta pantalla desde una autoridad para enviar una invitación.',
			invitationNeedsElection: 'Abre esta pantalla desde una elección para invitar a un custodio de claves.',
			invitationNetworkStarting: 'La red todavía se está iniciando. Espera un momento e inténtalo de nuevo.',
			invitationNoNetwork: 'Primero crea o selecciona una red.',
			invitationAuthorityUnresolved: 'No se encontró la autoridad de esta red, así que no se creó ninguna invitación.',
			networkCreateFailed: 'No se pudo crear la red. Inténtalo de nuevo.',
			electionDetailsLoadFailed: 'No se pudo cargar esta elección. Inténtalo de nuevo.',
			electionBallotsLoadFailed: 'No se pudieron cargar las boletas de esta elección. Inténtalo de nuevo.',
			electionShareFailed: 'No se pudieron abrir las opciones para compartir.',
			loadRetryButton: 'Intentar de Nuevo',
			// Debug seed keys — Spanish mirrors
			debugSeedTasksTitle: 'Sembrar Tareas Pendientes (Debug)',
			debugSeedTasksSuccess: 'Tareas pendientes sembradas — ver pestaña Tareas',
			debugSeedTasksError: 'Error al sembrar: ',
			// Phase 39 plan 39-04 (DEBT-09 app-Jest gate) — DistrictsGroupsEditor range fields.
			from: 'Desde',
			to: 'Hasta',
			add: 'Agregar',
			cancel: 'Cancelar',
			// Phase 46 (D-11) — registrationPolicy* group; copy verbatim from 46-UI-SPEC.md § Copywriting Contract.
			// Navigation entry (D-11)
			registrationPolicyEntryTitle: 'Política de Registro',
			// Screen header / section titles (D-11)
			registrationPolicyFieldsSectionTitle: 'Campos',
			registrationPolicyDisclosureSectionTitle: 'Divulgación',
			registrationPolicyAttestationSectionTitle: 'Certificación',
			registrationPolicyIssuesSectionTitle: 'Problemas de la Política',
			// Scope gate (D-10) (D-11)
			registrationPolicyReadOnlyBanner:
				'Solo visualización. Necesitas el permiso {{scope}} para cambiar esta política.',
			registrationPolicyReadOnlyNoOfficerBanner:
				'Solo visualización. No eres un funcionario registrado de esta autoridad, así que los cambios están desactivados.',
			// Field editor (D-02) (D-11)
			registrationPolicyKnownFieldLastName: 'Apellido',
			registrationPolicyKnownFieldFirstName: 'Nombre',
			registrationPolicyDistrictFieldLabel: 'Distrito',
			registrationPolicyDistrictFieldHint: 'Solo si esta elección usa distritos',
			registrationPolicyCustomFieldOption: 'Personalizado…',
			registrationPolicyCustomFieldPlaceholder: 'Nombre del campo',
			registrationPolicyExtraFieldBadge: 'Campo Adicional',
			registrationPolicyExtraFieldHint:
				'Se guarda en Campos Adicionales, no en una columna dedicada',
			registrationPolicyTierLabel: 'Visibilidad',
			registrationPolicyTierPublic: 'Público',
			registrationPolicyTierSelective: 'Selectivo',
			registrationPolicyTierPrivate: 'Privado',
			registrationPolicyRequirementRequired: 'Obligatorio',
			registrationPolicyRequirementOptional: 'Opcional',
			registrationPolicyAddFieldButton: 'Agregar Campo',
			registrationPolicyNoFieldsHeading: 'Aún no hay campos configurados',
			registrationPolicyNoFieldsBody:
				'Agrega un campo arriba para definir lo que deben proporcionar los registrantes.',
			// Disclosure editor (D-03/D-04/D-05) (D-11)
			registrationPolicyAudienceLabel: 'Audiencia',
			registrationPolicyAudienceEveryone: 'Todos',
			registrationPolicyAudienceDistrict: 'Mismo distrito (votantes vecinos)',
			registrationPolicyAudienceNotSet: 'Sin definir',
			registrationPolicyAudienceDistrictUnavailableHint:
				'La divulgación por mismo distrito aún no está disponible — requiere AMBAS cosas: un campo Distrito declarado arriba Y una plantilla de boleta de esta elección que declare distritos.',
			registrationPolicyNoDisclosureHeading: 'Aún no hay campos selectivos',
			registrationPolicyNoDisclosureBody:
				'Los campos de nivel selectivo que agregues arriba en Campos aparecerán aquí para que definas a quién se divulgan.',
			registrationPolicyOrphanDisclosureFlag: 'Divulgación huérfana:',
			registrationPolicyOrphanDisclosureBody:
				'Esta regla de audiencia no corresponde a ningún campo selectivo.',
			registrationPolicyMissingAudienceFlag: 'Sin audiencia definida:',
			registrationPolicyMissingAudienceBody:
				'Este campo selectivo no puede divulgarse a nadie hasta que se defina una audiencia.',
			registrationPolicySetAudienceButton: 'Definir Audiencia',
			registrationPolicyRemoveButton: 'Eliminar',
			// Attestation editor — tri-state (D-07) (D-11)
			registrationPolicyAttestationNotConfiguredLabel: 'No configurado — obligatorio por defecto',
			registrationPolicyAttestationNotConfiguredBody:
				'No se ha definido una política, por lo que la certificación del dispositivo es OBLIGATORIA para esta elección (el valor predeterminado de falla-cerrada).',
			registrationPolicyAttestationRequiredLabel: 'Obligatorio',
			registrationPolicyAttestationRequiredBody:
				'La certificación del dispositivo es explícitamente obligatoria para esta elección.',
			registrationPolicyAttestationNotRequiredLabel: 'No obligatorio',
			registrationPolicyAttestationNotRequiredBody:
				'La certificación del dispositivo está explícitamente desactivada para esta elección.',
			registrationPolicyAttestationRequireButton: 'Exigir Certificación',
			registrationPolicyAttestationDontRequireButton: 'No Exigir Certificación',
			registrationPolicyAttestationRevertButton: 'Restablecer Predeterminado',
			// Policy editability window (D-13) (D-11)
			registrationPolicyConfirmTitle: '¿Cambiar la política de registro?',
			registrationPolicyConfirmRosterBody:
				'Esta elección ya tiene registrantes. Fueron validados contra la política anterior y no se volverán a validar.',
			registrationPolicyConfirmWindowOpenBody:
				'El registro ya está abierto para esta elección. Los registrantes que ya se inscribieron fueron validados contra la política anterior y no se volverán a validar.',
			registrationPolicyConfirmProceedButton: 'Continuar de Todos Modos',
			registrationPolicyConfirmCancelButton: 'Mantener Política Actual',
			// Per-row immediate-apply affordance (D-14) (D-11)
			registrationPolicyRowSaving: 'Guardando…',
			registrationPolicyRowSaved: 'Guardado',
			registrationPolicyRowError: 'No se pudo guardar',
			registrationPolicyRetryButton: 'Reintentar',
			// Phase 47 (D-04/D-05/D-07) — registrantList* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantListScreenTitle: 'Registrantes',
			registrantListRosterScreenTitle: 'Registrantes de {{electionTitle}}',
			registrantListSearchPlaceholder: 'Buscar por nombre',
			registrantListFilterStatusAll: 'Todos los Estados',
			registrantListFilterExpirationLabel: 'Vencimiento',
			registrantListFilterDistrictLabel: 'Distrito',
			registrantListCountLabel: 'Mostrando {{shown}} de {{total}}',
			registrantListCountUnknown: 'Mostrando {{shown}}',
			registrantListLoadMoreButton: 'Cargar Más',
			registrantListLoadingMore: 'Cargando más…',
			registrantListEndOfList: 'Fin de la lista',
			registrantListEmptyHeading: 'Ningún registrante coincide con estos filtros',
			registrantListEmptyBody: 'Prueba con un estado, distrito o término de búsqueda diferente.',
			registrantListEmptyHeadingNoFilters: 'Aún no hay registrantes',
			registrantListEmptyBodyNoFilters:
				'Los registrantes aparecerán aquí una vez que las personas se registren en esta autoridad.',
			// Phase 47 (D-10) — registrantStatus* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantStatusActive: 'Activo',
			registrantStatusSuspended: 'Suspendido',
			registrantStatusRevoked: 'Revocado',
			// Phase 47 (D-12/D-13/D-14) — registrantDetail* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantDetailScreenTitle: 'Registrante',
			registrantDetailPublicTierTitle: 'Público',
			registrantDetailSelectiveTierTitle: 'Selectivo',
			registrantDetailPrivateTierTitle: 'Privado',
			registrantDetailNoPublicTier: 'No hay detalles públicos registrados',
			registrantDetailNoSelectiveTier: 'No hay detalles selectivos registrados',
			registrantDetailNoPrivateTier: 'No hay detalles privados registrados',
			registrantDetailSignorKeyLabel: 'Firmado por',
			registrantDetailExpirationLabel: 'Vence',
			registrantDetailSelectiveAudiencePreviewTitle: 'Vista Previa de Audiencia',
			registrantDetailSelectiveAudiencePreviewHint:
				'Muestra lo que cada audiencia recibiría si esta elección divulga detalles selectivos.',
			registrantDetailSelectiveDisclosedLabel: 'Divulgado',
			registrantDetailSelectiveNotDisclosedLabel: 'No divulgado a esta audiencia',
			registrantDetailPrivateMaskedValue: '••••••',
			registrantDetailPrivateRevealHint: 'Toca para revelar',
			registrantDetailPrivateHideHint: 'Toca para ocultar',
			registrantDetailPrivateGateHeading: 'Los detalles privados requieren el permiso {{scope}}',
			// Phase 47 (D-10) — registrantLifecycle* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantLifecycleRenewButton: 'Renovar Registro',
			registrantLifecycleReinstateButton: 'Reincorporar a Activo',
			registrantLifecycleSuspendButton: 'Suspender Registrante',
			registrantLifecycleRevokeButton: 'Revocar Registro',
			registrantLifecycleRenewTitle: '¿Renovar registro?',
			registrantLifecycleRenewBody: 'Extiende el registro de {{name}} hasta {{newExpiration}}.',
			registrantLifecycleReinstateTitle: '¿Reincorporar a activo?',
			registrantLifecycleReinstateBody: 'Cambia el estado de {{name}} de {{oldStatus}} a Activo.',
			registrantLifecycleSuspendTitle: '¿Suspender a {{name}}?',
			registrantLifecycleSuspendBody:
				'Esto cambia de inmediato el estado de {{name}} a Suspendido. No hay deshacer automático — reincorporar requiere una acción firmada aparte. Escribe el nombre de {{name}} para confirmar.',
			registrantLifecycleRevokeTitle: '¿Revocar el registro de {{name}}?',
			registrantLifecycleRevokeBody:
				'Esto revoca de inmediato y de forma permanente el registro de votante de {{name}}. No hay deshacer. Escribe el nombre de {{name}} para confirmar.',
			registrantLifecycleTypedConfirmPlaceholder: 'Escribe {{name}} para confirmar',
			registrantLifecycleKeepCurrentStatus: 'Mantener Estado Actual',
			registrantLifecycleKeepCurrentExpiration: 'Mantener Vencimiento Actual',
			registrantLifecycleConfirmRenewal: 'Confirmar Renovación',
			registrantLifecycleConfirmReinstatement: 'Confirmar Reincorporación',
			// Vinculación de navegadores (pantalla, lista de navegadores vinculados, registro y ajuste del propietario).
			// Ningún número de plan ni identificador de decisión puede aparecer en estos textos.
			dashboardPairingTitle: 'Vincular un navegador',
			dashboardPairingChecking: 'Comprobando si este teléfono puede vincular un navegador…',
			dashboardPairingIdleBody:
				'Vincule el navegador de una computadora para que siga esta red en vivo. El navegador puede leer lo que usted ve y no puede cambiar nada.',
			dashboardPairingRequestButton: 'Solicitar código de vinculación',
			dashboardPairingConfirmHeading: '¿Solicitar un código de vinculación?',
			dashboardPairingConfirmBody:
				'El código permite que un navegador siga esta red como usted y lea todo lo que usted puede ver. Cualquiera que lo tenga puede usarlo una vez hasta que venza.',
			dashboardPairingWaitingHeading: 'Consultando al propietario de la red…',
			dashboardPairingWaitingBody:
				'La aplicación Authority de un propietario debe estar abierta y en línea para crear el código. Manténgala abierta.',
			dashboardPairingCancelButton: 'Cancelar solicitud de vinculación',
			dashboardPairingReadyHeading: 'Código de vinculación listo',
			dashboardPairingReadyBody:
				'Escanee este código QR con la cámara del navegador, o copie el código y péguelo allí. Funciona una vez y vence en {{minutes}} minutos.',
			dashboardPairingCountdown: 'Vence en {{remaining}}',
			dashboardPairingQrHint: 'Toque el código QR para ampliarlo',
			dashboardPairingQrTileLabel: 'Código QR de vinculación, toque para ampliarlo',
			dashboardPairingShowQrButton: 'Mostrar código QR',
			dashboardPairingCopyButton: 'Copiar código',
			dashboardPairingShareButton: 'Compartir código',
			dashboardPairingFinishButton: 'Terminar vinculación',
			dashboardPairingCopied: 'Código copiado',
			dashboardPairingCopyFailed: 'No se pudo copiar el código. Compártalo en su lugar.',
			dashboardPairingShareFailed: 'No se pudo abrir el menú para compartir. Copie el código en su lugar.',
			dashboardPairingQrWarning:
				'Cualquiera que tenga este código puede vincular un navegador como usted hasta que venza. Muéstrelo solo a su propia computadora.',
			dashboardPairingQrTooLarge: 'Este código es demasiado grande para mostrarlo como código QR. Cópielo o compártalo en su lugar.',
			dashboardPairingQrClose: 'Cerrar',
			dashboardPairingQrShareImage: 'Compartir imagen QR',
			dashboardPairingQrShareFailed: 'No se pudo compartir la imagen. Copie o comparta el código en su lugar.',
			dashboardPairingQrRenderFailed: 'No se pudo dibujar el código QR. Copie o comparta el código en su lugar.',
			dashboardPairingUsed: 'Este código ya se usó.',
			dashboardPairingPairAnotherButton: 'Vincular otro navegador',
			dashboardPairingExpired: 'Este código ha vencido. Solicite uno nuevo.',
			dashboardPairingOwnerUnreachableHeading: 'No hay ningún propietario disponible.',
			dashboardPairingOwnerUnreachableBody:
				'Mantenga abierta la aplicación Authority del propietario en su teléfono e inténtelo de nuevo.',
			dashboardPairingRetryButton: 'Reintentar solicitud',
			dashboardPairingSwitchedOff: 'El propietario desactivó la vinculación de navegadores. Pídale que la active.',
			dashboardPairingNotAllowed: 'El propietario no aceptó esta solicitud. Asegúrese de que su clave de funcionario esté vigente.',
			dashboardPairingUnavailable: 'La vinculación no está disponible en este momento.',
			dashboardPairingUnavailableNoNetwork: 'Únase primero a una red.',
			dashboardPairingUnavailableNotOfficer: 'Solo los funcionarios pueden vincular un navegador.',
			dashboardPairingUnavailableNoKey: 'Configure primero su clave de firma.',
			dashboardPairingBuildFailed: 'No se pudo crear un código de vinculación. Inténtelo de nuevo.',
			pairedBrowsersTitle: 'Navegadores vinculados',
			pairedBrowsersIntro:
				'Navegadores que siguen esta red como usted. Cada uno puede leer lo que usted ve; ninguno puede cambiar nada.',
			pairedBrowsersDefaultLabel: 'Navegador vinculado el {{date}}',
			pairedBrowsersPairedAt: 'Vinculado el {{date}}',
			pairedBrowsersLastSeenFewMinutes: 'Visto por última vez hace unos minutos',
			pairedBrowsersLastSeenMinutes: 'Visto por última vez hace {{n}} min',
			pairedBrowsersLastSeenHours: 'Visto por última vez hace {{n}} h',
			pairedBrowsersLastSeenDays: 'Visto por última vez hace {{n}} días',
			pairedBrowsersNotSeenYet: 'Aún no se ha visto',
			pairedBrowsersLastSeenFootnote: 'La última vez visto se actualiza aproximadamente cada 8 minutos.',
			pairedBrowsersStateWaiting: 'Esperando vinculación',
			pairedBrowsersStatePaired: 'Vinculado',
			pairedBrowsersStateRemovalPending: 'Retiro pendiente',
			pairedBrowsersStateRemoved: 'Quitado',
			pairedBrowsersRemoveButton: 'Quitar',
			pairedBrowsersRemoveConfirmHeading: '¿Quitar este navegador?',
			pairedBrowsersRemoveConfirmBody:
				'El navegador descartará su copia local y volverá a la pantalla de vinculación. También perderá su acceso a la red. Los datos que ya recibió no se pueden recuperar, así que quite un navegador en cuanto deje de confiar en él.',
			pairedBrowsersRemoveConfirmButton: 'Quitar navegador',
			pairedBrowsersKeepButton: 'Conservar navegador',
			pairedBrowsersRemovalPendingLine:
				'Quitado aquí. Esperando a que un propietario termine de quitarlo de la red. Esto se reintentará automáticamente.',
			pairedBrowsersEmptyHeading: 'No hay navegadores vinculados',
			pairedBrowsersEmptyBody: 'Vincule una computadora para seguir esta red en vivo.',
			pairedBrowsersPairButton: 'Vincular un navegador',
			pairedBrowsersLocalLabelsNote: 'Los nombres y las horas de vinculación se guardan solo en este teléfono.',
			pairedBrowsersLoadError: 'No se pudieron cargar los navegadores vinculados. Deslice hacia abajo para reintentar.',
			pairedBrowsersRemoveFailed: 'No se pudo quitar este navegador. Inténtelo de nuevo.',
			pairedBrowsersRemoveKeyNotCurrent:
				'Su clave de firma no está vigente. Configúrela de nuevo y luego intente quitar este navegador.',
			pairingMintLogSectionTitle: 'Vinculación de navegadores',
			pairingMintLogSwitchLabel: 'Permitir que los funcionarios vinculen navegadores',
			pairingMintLogSwitchHelpOn:
				'Cuando un funcionario pide vincular un navegador, este teléfono lo aprueba automáticamente si su clave es válida. Mantenga esta aplicación abierta para que funcione.',
			pairingMintLogSwitchHelpOff:
				'Los funcionarios no pueden vincular navegadores hasta que vuelva a activar esto. Los navegadores ya vinculados siguen funcionando.',
			pairingMintLogSwitchSaveFailed: 'No se pudo guardar este ajuste. Inténtelo de nuevo.',
			pairingMintLogTitle: 'Solicitudes de vinculación',
			pairingMintLogRow: '{{officerName}} · el {{date}}',
			pairingMintLogUnknownOfficer: 'Funcionario desconocido',
			pairingMintLogOutcomeApproved: 'Aprobada',
			pairingMintLogOutcomeKeyNotValid: 'Rechazada: clave no válida',
			pairingMintLogOutcomeSwitchOff: 'Rechazada: interruptor desactivado',
			pairingMintLogOutcomeNotOfficer: 'Rechazada: no es funcionario',
			pairingMintLogOutcomeRefused: 'Rechazada',
			pairingMintLogOutcomeUnreachable: 'Inalcanzable',
			pairingMintLogEmpty: 'Aún no hay solicitudes de vinculación.',
			pairingMintLogFootnote: 'Se muestran las últimas {{n}} solicitudes en este teléfono.',
			pairingMintLogUnreadable: 'No se pudieron leer las solicitudes de vinculación en este teléfono.',
			// Phase 47 (D-01/D-02/D-14) — registrantAccessTrail* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantAccessTrailSectionTitle: 'Historial de Acceso',
			// D-01: load-bearing framing — accountability/transparency, NOT a security control. Do not paraphrase.
			registrantAccessTrailDisclaimer:
				'Registra cuándo un funcionario vio los detalles privados de este registrante a través de esta aplicación, y qué campos fueron revelados — para rendición de cuentas y transparencia, no como control de seguridad. Solo captura el acceso realizado a través de esta aplicación; el acceso directo a la base de datos no queda registrado aquí.',
			registrantAccessTrailEmptyHeading: 'Aún no hay acceso registrado',
			registrantAccessTrailEmptyBody:
				'Los detalles privados de este registrante no se han revelado a través de esta aplicación.',
			registrantAccessTrailRow: '{{viewer}} reveló {{fields}} — {{timestamp}}',
			// Phase 47 (D-03) — associationList* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			associationListSectionTitle: 'Dispositivos Asociados',
			associationListEmptyHeading: 'No hay dispositivos asociados',
			associationListEmptyBody: 'Este registrante aún no ha asociado un dispositivo.',
			associationListDeviceKeyLabel: 'Clave del Dispositivo',
			associationListExpirationLabel: 'Vence',
			associationListRemoveButton: 'Eliminar Asociación',
			associationListRemoveTitle: '¿Eliminar esta asociación de dispositivo?',
			associationListRemoveBody:
				'{{name}} deberá asociar un dispositivo nuevamente antes de votar. Esto no cambia su estado de registro.',
			associationListRemoveConfirm: 'Eliminar Asociación',
			associationListKeepAssociation: 'Mantener Asociación',
			// Phase 47 (D-11) — attestationChallenge* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationChallengeSectionTitle: 'Certificaciones Pendientes',
			attestationChallengeEmptyHeading: 'No hay certificaciones pendientes',
			attestationChallengeEmptyBody:
				'No hay certificaciones de dispositivo pendientes para este registrante.',
			attestationChallengeDeviceKeyLabel: 'Clave del Dispositivo',
			attestationChallengeElectionLabel: 'Elección',
			attestationChallengeExpiryLabel: 'Vence',
			attestationChallengeExpireButton: 'Vencer Certificación',
			attestationChallengeExpireTitle: '¿Vencer esta certificación?',
			attestationChallengeExpireBody:
				'El dispositivo que posee esta certificación ya no podrá completarla. Una nueva certificación solo puede ser emitida por el propio intento de registro/asociación del dispositivo.',
			attestationChallengeExpireConfirm: 'Vencer Certificación',
			attestationChallengeKeepChallenge: 'Mantener Certificación',
			// Phase 47 (D-03) — attestationVerdict* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationVerdictPass: 'Aprobado',
			attestationVerdictFail: 'Rechazado',
			attestationVerdictNone: 'Sin resultado aún',
			attestationVerdictReasonLabel: 'Motivo',
			attestationVerdictVerifiedAtLabel: 'Verificado',
			// Phase 47 (D-09) — attestationProvisioning* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationProvisioningScreenTitle: 'Configuración de Certificación de Dispositivo',
			attestationProvisioningProvisionedHeading: 'Las claves de Play Console están configuradas',
			attestationProvisioningProvisionedBody:
				'La certificación de dispositivos está completamente operativa — las nuevas asociaciones de dispositivos pueden verificarse.',
			attestationProvisioningNotProvisionedHeading:
				'Las claves de Play Console no están configuradas',
			attestationProvisioningNotProvisionedBody:
				'La asociación de dispositivos fallará hasta que se configuren las claves de Play Console. Los datos de registrantes y asociaciones aún pueden verse y gestionarse con normalidad.',
			attestationProvisioningSetupLink: 'Estas claves las configura quien compila y distribuye esta aplicación. Contáctelos si sigue sin configurarse.',
			attestationProvisioningInlineBannerBody:
				'La certificación de dispositivos no está configurada. Las ceremonias de asociación fallarán hasta que esto se corrija.',
			attestationProvisioningInlineBannerLink: 'Ver estado de configuración',
			// Phase 47 (D-08/D-13) — pollingDevice* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			pollingDeviceScreenTitle: 'Dispositivos de Votación',
			pollingDeviceAddButton: 'Agregar Dispositivo',
			pollingDeviceLabelField: 'Etiqueta',
			pollingDeviceLabelPlaceholder: 'ej. Tableta del Recinto 4',
			pollingDeviceHashLabel: 'Hash del Dispositivo',
			pollingDeviceRemoveButton: 'Eliminar',
			pollingDeviceRemoveTitle: '¿Eliminar este dispositivo de votación?',
			pollingDeviceRemoveBody:
				'{{label}} ya no podrá operar como dispositivo de votación presencial para esta autoridad. Puede agregarse nuevamente en cualquier momento.',
			pollingDeviceRemoveConfirm: 'Eliminar Dispositivo',
			pollingDeviceKeepDevice: 'Mantener Dispositivo',
			pollingDeviceEmptyHeading: 'No hay dispositivos de votación en la lista blanca',
			pollingDeviceEmptyBody:
				'Agrega un dispositivo para permitirle operar como dispositivo de votación presencial para esta autoridad.',
			// Phase 47 (D-08/D-13) — authorityPeer* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			authorityPeerScreenTitle: 'Pares de Autoridad',
			authorityPeerAddButton: 'Agregar Par de Autoridad',
			authorityPeerIdLabel: 'ID del Par',
			authorityPeerIdPlaceholder: 'ID del par',
			authorityPeerRemoveButton: 'Eliminar',
			authorityPeerRemoveTitle: '¿Eliminar este par de autoridad?',
			authorityPeerRemoveBody:
				'Este par será eliminado del clúster P2P de esta autoridad. Puede agregarse nuevamente en cualquier momento.',
			authorityPeerRemoveConfirm: 'Eliminar Par',
			authorityPeerKeepPeer: 'Mantener Par',
			authorityPeerEmptyHeading: 'No hay pares de autoridad configurados',
			authorityPeerEmptyBody: 'Agrega un par para expandir el clúster P2P de esta autoridad.',
			// 47-REVIEW IN-06. Sin interpolación de {{peerId}} — ver la nota en la versión en inglés.
			authorityPeerDuplicateError: 'Ese par ya está configurado para esta autoridad.',
			// D-13: UI legibility affordance, NOT the enforcement boundary — the schema's AdminSignature CHECK is the real control.
			authorityPeerScopeReadOnlyBanner:
				'Solo visualización. Necesitas el permiso {{scope}} para cambiar pares de autoridad.',
			// Phase 47 (D-13) — registrantScope* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantScopeReadOnlyBanner:
				'Solo visualización. Necesitas el permiso {{scope}} para cambiar registrantes, asociaciones o dispositivos.',
			registrantScopeReadOnlyNoOfficerBanner:
				'Solo visualización. No eres un funcionario registrado de esta autoridad, así que los cambios están desactivados.',
			// Phase 48 (D-01/D-03/D-09) — registrationRequest* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestScreenTitle: 'Solicitudes de Registro',
			registrationRequestSearchPlaceholder: 'Buscar por nombre',
			registrationRequestFilterStatusAll: 'Todas',
			registrationRequestFilterStatusPending: 'Pendientes',
			registrationRequestFilterStatusApproved: 'Aprobadas',
			registrationRequestFilterStatusRejected: 'Rechazadas',
			registrationRequestFilterIssuerAll: 'Todas las Fuentes',
			registrationRequestFilterIssuerRegistrant: 'Enviadas por el Registrante',
			registrationRequestFilterIssuerBridge: 'Importadas por Puente',
			registrationRequestCountLabel: 'Mostrando {{shown}} de {{total}}',
			registrationRequestCountUnknown: 'Mostrando {{shown}}',
			registrationRequestSortedByReceivedLabel:
				'Ordenadas por fecha de recepción (más antiguas primero)',
			registrationRequestLoadMoreButton: 'Cargar Más',
			registrationRequestLoadingMore: 'Cargando más…',
			registrationRequestEndOfList: 'Fin de la lista',
			registrationRequestEmptyHeading: 'Ninguna solicitud coincide con estos filtros',
			registrationRequestEmptyBody: 'Prueba con un estado o fuente diferente.',
			registrationRequestEmptyHeadingNoFilters: 'Aún no hay solicitudes de registro',
			registrationRequestEmptyBodyNoFilters:
				'Las solicitudes enviadas por cualquier método de sincronización aparecerán aquí para revisión.',
			registrationRequestBulkImportSyncButton: 'Importación Masiva / Sincronizar',
			// Fase 51 (D-06/D-19) — grupo associationRequestStatus*.
			associationRequestStatusScreenTitle: 'Solicitudes de Asociación',
			associationRequestStatusEmptyHeading: 'Aún no hay solicitudes de asociación',
			associationRequestStatusEmptyBody:
				'Las solicitudes enviadas por un dispositivo, o recogidas por Sincronizar Ahora, aparecerán aquí.',
			associationRequestStatusPendingLabel: 'Pendiente',
			associationRequestStatusChallengeIssuedLabel: 'Desafío Emitido',
			associationRequestStatusAssociatedLabel: 'Asociada',
			associationRequestStatusRejectedLabel: 'Rechazada',
			associationRequestStatusSubmittedAtLabel: 'Enviada',
			associationRequestStatusReceivedAtLabel: 'Recibida',
			associationRequestStatusChallengeIssuedNote: 'Se ha emitido un desafío para esta solicitud.',
			associationRequestStatusInboxButton: 'Solicitudes de Asociación',
			registrationRequestPreviouslyRejectedFlag: 'Rechazada anteriormente',
			registrationRequestReceivedAtLabel: 'Recibida',
			registrationRequestClaimedSubmittedAtLabel: 'Envío declarado',
			registrationRequestScopeReadOnlyBanner:
				'Solo visualización. Necesitas el permiso {{scope}} para revisar solicitudes de registro.',
			registrationRequestScopeReadOnlyNoOfficerBanner:
				'Solo visualización. No eres un funcionario registrado de esta autoridad, así que los cambios están desactivados.',
			registrationRequestStatusPending: 'Pendiente',
			registrationRequestStatusApproved: 'Aprobada',
			registrationRequestStatusRejected: 'Rechazada',
			registrationRequestStatusClosedDuplicate: 'Cerrada',
			// Phase 48 (D-06/D-07) — registrationRequestApproval* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestApprovalScreenTitle: 'Detalle de la Solicitud',
			registrationRequestApprovalSummaryTitle: 'Solicitud',
			registrationRequestApprovalReceivedAtLabel: 'Recibida',
			registrationRequestApprovalSubmittedAtLabel: 'Envío declarado',
			registrationRequestApprovalRequesterKeyLabel: 'Clave del Solicitante',
			registrationRequestFieldFirstName: 'Nombre',
			registrationRequestFieldLastName: 'Apellido',
			registrationRequestFieldDob: 'Fecha de nacimiento',
			registrationRequestFieldEmail: 'Correo electrónico',
			registrationRequestFieldPhone: 'Número de teléfono',
			registrationRequestFieldAddressLine1: 'Dirección, línea 1',
			registrationRequestFieldAddressLine2: 'Dirección, línea 2',
			registrationRequestFieldAddressLine3: 'Dirección, línea 3',
			registrationRequestFieldParty: 'Partido',
			registrationRequestApprovalApproveButton: 'Aprobar Registro',
			registrationRequestApprovalRejectButton: 'Rechazar Solicitud',
			registrationRequestApprovalApprovedByLabel: 'Aprobada por {{officer}} el {{date}}',
			registrationRequestApprovalViewRegistrantButton: 'Ver Registrante',
			// Phase 48 (D-06) — registrationRequestReject* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestRejectTitle: '¿Rechazar esta solicitud?',
			registrationRequestRejectBody:
				'Esto quedará registrado de forma permanente con tu nombre. Si {{name}} vuelve a enviar una solicitud, este rechazo y tu motivo se mostrarán a quien lo revise después.',
			registrationRequestRejectReasonPlaceholder: 'Motivo del rechazo',
			registrationRequestRejectConfirmButton: 'Confirmar Rechazo',
			registrationRequestRejectKeepReviewingButton: 'Seguir Revisando',
			registrationRequestRejectChecklistRequired: 'Completa la lista de verificación antes de rechazar.',
			registrationRequestRejectFailed: 'No se pudo registrar el rechazo. Inténtalo de nuevo.',
			registrationRequestUnverifiable: 'La firma de esta solicitud no se puede verificar, así que no se puede aprobar ni rechazar aquí. No se usó ninguna firma tuya.',
			// Phase 48 (D-03) — bridgeSource* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			bridgeSourceBadgeLabel: 'Importación por Puente',
			bridgeSourceCalloutHeading: 'Enviada por un puente de importación',
			bridgeSourceCalloutBody:
				'Esta solicitud fue firmada por {{bridgeLabel}}, un puente de importación, en nombre del remitente. Es una afirmación del puente, no una firma del propio registrante. Verifica en consecuencia.',
			// Phase 48 (D-07) — verificationChecklist* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			verificationChecklistSectionTitle: 'Verificación Fuera de Banda',
			verificationChecklistItemId: 'Verificó identificación oficial con fotografía',
			verificationChecklistItemRoll: 'Comprobó contra el padrón electoral existente',
			verificationChecklistItemEligibility:
				'Confirmó elegibilidad (edad, residencia, ciudadanía según la política)',
			verificationChecklistItemNone: 'No se realizó verificación adicional fuera de banda',
			verificationChecklistBindingNotice:
				'Esta lista se convierte en parte de tu aprobación firmada y no puede modificarse después.',
			verificationChecklistDecidedAtLabel: 'Registrado al decidir',
			// Phase 48 (D-06) — priorRejections* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			priorRejectionsCalloutHeading: 'Este solicitante fue rechazado anteriormente',
			priorRejectionsCalloutRow: 'Rechazado el {{date}} por {{officer}} — {{reason}}',
			// Phase 48 (D-09) — transparencyStats* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			transparencyStatsSectionTitle: 'Transparencia',
			transparencyStatsPendingLabel: 'Pendientes',
			transparencyStatsApprovedLabel: 'Aprobadas',
			transparencyStatsRejectedLabel: 'Rechazadas',
			transparencyStatsMedianTimeLabel: 'Tiempo medio de decisión',
			transparencyStatsMedianTimeUnknown: 'Aún no hay datos suficientes',
			// Phase 48 (D-01/D-11) — bulkImportSync* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			bulkImportSyncScreenTitle: 'Importación Masiva / Sincronizar',
			bulkImportSyncFilesystemHeading: 'Sistema de Archivos',
			bulkImportSyncRestHeading: 'Webhook / REST',
			bulkImportSyncNeverSyncedBody: 'Aún no sincronizado',
			bulkImportSyncSyncedBody: 'Sincronización completada.',
			bulkImportSyncErrorBody:
				'La sincronización falló. No hay ningún método de sincronización conectado, o no se pudo contactar con el que está conectado.',
			bulkImportSyncLastSyncedLabel: 'Última sincronización correcta {{date}}',
			bulkImportSyncImportedCountLabel: '{{count}} importadas',
			bulkImportSyncPendingCountLabel: '{{count}} pendientes de revisión',
			bulkImportSyncErrorCountLabel: '{{count}} errores',
			bulkImportSyncNowButton: 'Sincronizar Ahora',
			bulkImportSyncErrorsSectionTitle: 'Errores de Sincronización',
			// 62-UI-SPEC Surface 1 — peerSyncCard* group (D-31). Consumer: 62-21.
			peerSyncCardHeading: 'Entre Pares (No Verificado en Dispositivos)',
			peerSyncCardCaveat:
				'Este método de sincronización está completo en código, pero la entrega entre pares aún no se ha comprobado en dispositivos. Usa la sincronización por Sistema de Archivos o REST para resultados confiables.',
			peerSyncCardPendingLabel: '{{count}} pendientes',
			peerSyncCardSyncedLabel: '{{count}} sincronizadas',
			peerSyncCardFailedLabel: '{{count}} fallidas',
			peerSyncCardTryButton: 'Probar Sincronización P2P (No Verificado)',
			// 62-UI-SPEC Surface 1 — registrationBridgeConfig* group (D-29). Consumer: 62-25.
			registrationBridgeConfigHeading: 'Puente de Registro (REST)',
			registrationBridgeConfigUrlLabel: 'URL del Puente',
			registrationBridgeConfigUrlPlaceholder: 'https://tu-puente.ejemplo.org',
			registrationBridgeConfigSaveButton: 'Guardar URL del Puente',
			registrationBridgeConfigInvalidUrl: 'Introduce una URL https válida',
			registrationBridgeConfigSavedConfirm: 'URL del puente guardada',
			registrationBridgeConfigUnsetHint: 'Guarda una URL del puente arriba para activar la sincronización REST.',
			registrationBridgeConfigSaveError: 'No se pudo guardar la URL del puente. Inténtalo de nuevo.',
			registrationBridgeConfigCoSignRequired:
				'Esta autoridad requiere que más de un funcionario apruebe este cambio. Guardar la URL del puente no es compatible con esa configuración, así que no se guardó nada.',
			// 62-UI-SPEC Surface 2 — networkFounding* group (D-36). Consumer: 62-23.
			networkFoundingExportButton: 'Compartir Red',
			networkFoundingExportConfirmHeading: '¿Compartir esta red con otro dispositivo?',
			networkFoundingExportConfirmBody:
				'Esto crea un archivo con los registros fundacionales de esta red, firmados por sus funcionarios originales. Quien lo importe se unirá exactamente a la misma red.',
			networkFoundingExportShareButton: 'Compartir Archivo',
			networkFoundingExportError: 'No se pudo crear el archivo de la red. Inténtalo de nuevo.',
			networkFoundingImportButton: 'Importar Red',
			networkFoundingImportScreenTitle: 'Importar Paquete Fundacional',
			networkFoundingImportChooseFileButton: 'Elegir Archivo',
			networkFoundingImportValidating: 'Verificando firmas…',
			networkFoundingImportInvalidSignature:
				'Las firmas de este archivo no son válidas. Puede estar dañado o alterado.',
			networkFoundingImportAlreadyJoined: 'Ya tienes esta red.',
			networkFoundingImportSuccess: 'Red unida',
			networkFoundingImportGenericError: 'No se pudo importar este archivo.',
			networkFoundingExportCancelButton: 'No Compartir',
			networkFoundingExportGenerating: 'Preparando el archivo de la red…',
			networkFoundingExportSaveButton: 'Guardar en este teléfono',
			networkFoundingExportDoneButton: 'Listo',
			networkFoundingExportReadyBody:
				'El archivo de la red está listo. Compártelo, o guárdalo en este teléfono y envíalo después.',
			networkFoundingExportSaved: 'Guardado. Ahora puedes enviar el archivo desde Archivos.',
			networkFoundingExportTextFallback:
				'Esta versión de la app no pudo adjuntar un archivo, así que la red se compartió como texto. Guárdalo como archivo .json antes de importar.',
			networkFoundingImportViewNetworkButton: 'Ver Red',
			networkFoundingImportChooseAnotherFileButton: 'Elegir Otro Archivo',
			// 62-UI-SPEC Surface 3 — possibleDuplicate* group (D-44). Consumer: 62-27.
			possibleDuplicateHeading: 'Esto podría ser una solicitud duplicada',
			possibleDuplicateBody:
				'Otra solicitud pendiente de {{name}} parece similar. Decidir esta cerrará la otra como duplicada.',
			possibleDuplicateViewOtherButton: 'Ver Otra Solicitud',
			possibleDuplicateClosedLabel: 'Cerrada como duplicada de otra solicitud',
			possibleDuplicateCheckFailed:
				'No se pudo comprobar si hay solicitudes duplicadas. La aprobación queda en pausa hasta que esta comprobación funcione.',
			// 62-UI-SPEC Surface 4 — associationApproval* group (D-41, D-45). Consumer: 62-27.
			associationApprovalScreenTitle: 'Solicitud de Cambio de Dispositivo',
			associationApprovalNewDeviceLabel: 'Dispositivo nuevo',
			associationApprovalExistingDeviceLabel: 'Dispositivo actual (se retirará)',
			associationApprovalCodeMatchedBadge: 'Coincide por código de registro',
			associationApprovalIdentityMatchedBanner:
				'Este votante introdujo sus datos de identidad en lugar de un código. Compáralos con el registro del registrante antes de aprobar.',
			associationApprovalApproveButton: 'Aprobar Dispositivo Nuevo',
			associationApprovalApproveConfirmHeading: '¿Retirar el dispositivo actual?',
			// Deliberate deviation from the 62-UI-SPEC row (62-18: retirement follows the new
			// device's attestation, not the approve action, so "de inmediato" would be false).
			associationApprovalApproveConfirmBody:
				'Aprobar esta solicitud retira el dispositivo actual de {{registrantName}} en cuanto el nuevo dispositivo termine de configurarse. Ese dispositivo ya no podrá votar. Esta acción no se puede deshacer.',
			associationApprovalRejectButton: 'Rechazar Solicitud',
			associationApprovalApproveConfirmButton: 'Aprobar y Retirar Dispositivo',
			associationApprovalKeepReviewingButton: 'Seguir Revisando',
			associationApprovalLoadError: 'No se pudo cargar esta solicitud de cambio de dispositivo. Inténtalo de nuevo.',
			associationApprovalDecisionError: 'No se pudo registrar tu decisión. Inténtalo de nuevo.',
			associationApprovalQueueRowTitle: 'Cambio de dispositivo: {{registrantName}}',
			associationApprovalCodeUnmatchedBanner:
				'El código de registro que introdujo este votante no coincide con ningún registrante. Solo puedes rechazar esta solicitud.',
			associationApprovalCodeUnverifiableBanner:
				'No se pudo comprobar el código de registro con el registro del registrante. Solo puedes rechazar esta solicitud.',
			associationApprovalNoEvidenceBanner:
				'Este votante no envió ni un código de registro ni datos de identidad. Solo puedes rechazar esta solicitud.',
			associationApprovalCandidatesHeading: 'Posibles registrantes',
			associationApprovalEnteredFieldsHeading: 'Introducido por el votante',
			associationApprovalRegistrantRecordHeading: 'Registro del registrante',
			associationApprovalCoSignRequired:
				'Esta autoridad necesita a más de un funcionario para aprobar cambios de dispositivo, y la firma conjunta aún no está disponible para ellos.',
			// 62-UI-SPEC Surface 4 settings toggle — registrationPolicyReassociation* group (D-46). Consumer: 62-27.
			registrationPolicyReassociationHeading: 'Solicitudes de Cambio de Dispositivo',
			registrationPolicyReassociationManual: 'Revisar cada una manualmente',
			registrationPolicyReassociationAutomatic: 'Procesar automáticamente, como un primer dispositivo',
			registrationPolicyReassociationDefaultNote: 'Se recomienda la revisión manual y es la opción predeterminada.',
			registrationPolicyReassociationSaveError: 'No se pudo guardar esta configuración. Inténtalo de nuevo.',
			registrationPolicyReassociationCoSignRequired:
				'Esta autoridad necesita a más de un funcionario para cambiar esta configuración, y la firma conjunta aún no está disponible para ella.',
			registrationPolicyReassociationLoadError: 'No se pudo leer esta configuración. Inténtalo más tarde.',
			// 62-UI-SPEC Surface 5 — signatureTaskThreshold* group. Consumers: 62-12, 62-27.
			signatureTaskThresholdProgress: '{{signed}} de {{threshold}} firmas',
			signatureTaskThresholdReached: 'Umbral alcanzado — aún se pueden añadir más firmas',
			signatureTaskThresholdVoteRecorded: 'Tu decisión quedó registrada. Esperando a otros funcionarios.',
			signatureTaskThresholdUnreachable:
				'Ya no quedan suficientes funcionarios que puedan aprobar esta solicitud, así que queda rechazada.',
			// 62-UI-SPEC Surface 6 — keyholderDkg* group. Consumer: 62-26.
			keyholderDkgStatusPending: 'Esperando a que otros custodios se unan',
			keyholderDkgStatusThresholdTooLow:
				'La generación de clave necesita un umbral de al menos 2 custodios. Revisa la elección para requerir 2 o más custodios.',
			keyholderDkgStatusInProgress: 'Generando material de clave…',
			keyholderDkgStatusComplete: 'Generación de clave completa',
			keyholderDkgStatusComplaint:
				'Se encontró un problema con los datos de otro custodio. La generación se reiniciará.',
			keyholderDkgStatusHeading: 'Generación de Clave',
			// 62-UI-SPEC Surface 6 — keyholderRelease[A-Z]* group (bare `keyholderRelease` above is
			// pre-existing and NOT part of this group). Consumer: 62-29.
			keyholderReleaseScreenTitle: 'Liberar tu Parte de la Clave',
			keyholderReleaseBody:
				'Esta elección ha entrado en el período de liberación de claves. Liberar tu parte ayuda a reconstruir la clave de descifrado una vez que suficientes custodios hayan liberado la suya.',
			keyholderReleaseButton: 'Liberar mi Parte',
			keyholderReleaseSuccess: 'Tu parte ha sido liberada',
			// Resultados de la elección (descifrar + validar + contar tras la liberación de claves)
			resultsEntryTitle: 'Resultados',
			resultsScreenTitle: 'Resultados de la Elección',
			resultsComputing: 'Descifrando y contando los votos en este dispositivo…',
			resultsLoadFailed: 'No se pudieron leer los resultados en este dispositivo. Toca Actualizar para intentarlo de nuevo.',
			resultsNoElection: 'Esta elección aún no está en este dispositivo. Sincroniza y toca Actualizar.',
			resultsLockedTitle: 'Los resultados están bloqueados',
			resultsLockedBody: 'Los votos siguen cifrados hasta que suficientes custodios liberen sus partes de la clave.',
			resultsReleasedCount: 'Partes de la clave liberadas: {{released}} de {{needed}} necesarias',
			resultsNoElectionKey: 'Los custodios aún no han terminado de generar la clave de la elección.',
			resultsReleaseFrom: 'Los custodios pueden liberar sus partes desde {{date}}.',
			resultsUnavailableTitle: 'No se pudieron calcular los resultados',
			resultsUnavailableReason: 'Motivo: {{reason}}',
			resultsValidVotes: 'Votos válidos: {{count}}',
			resultsBlocks: 'Bloques de votos: {{count}}',
			resultsInvalidVotes: 'Votos inválidos (no contados): {{count}}',
			resultsExcludedVotes: 'Votos en bloques rechazados (no contados): {{count}}',
			resultsKeyholdersUsed: 'Descifrado con {{count}} partes de la clave liberadas',
			resultsNoBallots: 'No se encontró ninguna boleta confirmada para esta elección.',
			resultsBallotVotes: 'Boletas válidas: {{count}}',
			resultsOptionCount: '{{count}} ({{percent}}%)',
			resultsBlank: 'En blanco: {{count}}',
			resultsNotCounted: 'Este tipo de pregunta aún no se cuenta. Respondida: {{count}}',
			resultsTallyRoot: 'Raíz del recuento: {{root}}…',
			resultsRefresh: 'Actualizar',
			resultsNoBlocksYet: 'Todavía no ha llegado ningún bloque de votos a este dispositivo, así que no se cuenta nada. Espera un minuto y toca Actualizar.',
			resultsReceivedSoFar: 'Contado con los bloques de votos que este dispositivo ha recibido hasta ahora. Toca Actualizar para volver a contar.',
			resultsPublishedTitle: 'Recuento publicado',
			resultsPublishedMatches: 'Un funcionario publicó este recuento el {{date}}. Coincide con el recuento de este dispositivo.',
			resultsPublishedDiffers: 'Un funcionario publicó un recuento de {{published}} bloques de votos, y este dispositivo contó {{local}}. Puede que este dispositivo aún no tenga todos los bloques de votos.',
			resultsPublishedInvalid: 'Se publicó un recuento, pero no superó su comprobación de firma o de coherencia. No confíes en él.',
			resultsNotPublishedTitle: 'Aún no publicado',
			resultsPublishOfficerOnly: 'Un funcionario de esta autoridad publica el recuento. Después, votantes y custodios lo ven junto al suyo.',
			resultsPublishWaitingForBlocks: 'Todavía están llegando bloques de votos a este dispositivo. Podrás publicar cuando hayan llegado.',
			resultsPublishExplain: 'Publicar firma este recuento con tu clave para que todos los dispositivos puedan comprobarlo. Un recuento publicado no se puede cambiar.',
			resultsPublish: 'Publicar resultados',
			resultsPublishing: 'Publicando…',
			resultsPublishConfirmTitle: '¿Publicar estos resultados?',
			resultsPublishConfirmBody: 'Vas a publicar el recuento de {{blocks}} bloques de votos ({{votes}} votos válidos) de este dispositivo. No se podrá cambiar después. Si esperas más bloques, espera y toca Actualizar primero.',
			resultsPublishCancel: 'Cancelar',
			resultsPublishConfirm: 'Publicar',
			resultsPublishNoKey: 'Este dispositivo no tiene clave de firma, así que no puede publicar. Configura una en Ajustes.',
			resultsPublishConflict: 'Ya hay publicado un recuento distinto para esta elección. No se escribió nada.',
			resultsPublishKeyMismatch: 'La clave de firma de este dispositivo no es una de tus claves registradas, así que no se publicó nada.',
			resultsPublishInvalid: 'Este recuento no superó su propia comprobación de coherencia, así que no se publicó. Toca Actualizar para volver a contar.',
			resultsPublishNotOfficer: 'Solo un funcionario actual de esta autoridad puede publicar el recuento. No se escribió nada.',
			resultsPublishKeysNotReleased: 'Las partes de la clave aún no están todas liberadas en este dispositivo, así que no se publicó nada.',
			resultsPublishFailed: 'No se pudieron publicar los resultados. Inténtalo de nuevo.',
			keyholderReleaseError: 'No se pudo liberar tu parte. Inténtalo de nuevo.',
			keyholderReleaseInProgress: 'Liberando tu parte…',
			// officerIntakeKey* group — gap-fill, not in 62-UI-SPEC (D-04 recipient key). Consumer: 62-21.
			officerIntakeKeyHeading: 'Recepción Cifrada',
			officerIntakeKeyBody:
				'Registra una clave de cifrado para que los datos de registro de los votantes se cifren para ti. La clave privada permanece en este dispositivo.',
			officerIntakeKeyEnableButton: 'Activar Recepción Cifrada',
			officerIntakeKeyEnabledConfirm: 'Recepción cifrada activada',
			officerIntakeKeyError: 'No se pudo activar la recepción cifrada. Inténtalo de nuevo.',
			// registrationContent* group — gap-fill (D-49 sealed registration content, 62-31). Consumer: 62-27.
			registrationContentNotRecipient:
				'Esta solicitud se selló antes de que este dispositivo pudiera leerla. Otro funcionario puede revisarla.',
			registrationContentNoKey: 'Activa la recepción cifrada en este dispositivo para leer las solicitudes.',
			registrationContentUnreadable: 'No se pudo leer esta solicitud en este dispositivo.',
			registrationContentTampered:
				'El contenido de esta solicitud no coincide con lo que firmó el solicitante. No se puede aprobar.',
			// registrantPrivate* group — gap-fill (D-51 late-officer residual). Consumer: 62-32.
			registrantPrivateNotRecipient:
				'Estos datos privados se sellaron antes de que fueras funcionario, así que no se pueden mostrar en este dispositivo.',
			registrantPrivateUnreadable: 'No se pudieron leer estos datos privados en este dispositivo.',
			registrantSelectiveNotRecipient:
				'Estos datos de divulgación selectiva se sellaron antes de que fueras funcionario, así que no se pueden mostrar en este dispositivo.',
			registrantSelectiveUnreadable: 'No se pudieron leer estos datos de divulgación selectiva en este dispositivo.',
			registrantSelectiveTampered:
				'Estos datos de divulgación selectiva no coinciden con el registro firmado del registrante. No confíes en ellos.',
			keyholderDkgStatusFailed: 'Requiere atención. Un funcionario debe revisar esta generación de clave.',
			officerIntakeKeySupersededBody:
				'La recepción cifrada está activada para tu cuenta en otro de tus dispositivos. Las nuevas solicitudes se sellan para ese dispositivo.',
			officerIntakeRenewalFailedBody:
				'Tu nueva clave de firma está lista, pero la recepción cifrada no se renovó. Vuelve a activarla en Importación Masiva / Sincronizar.',
			errorLoadFailedGeneric: 'No se pudo cargar. Inténtalo de nuevo.',
			errorActionFailedGeneric: 'No se pudo completar. Inténtalo de nuevo.',
			validationRequired: 'Falta un campo obligatorio. Complétalo e inténtalo de nuevo.',
			validationInvalid: 'Uno de los valores no es válido. Revisa el formulario e inténtalo de nuevo.',
			dkgOverdueNotice: 'Sin respuesta en unas {{hours}} horas de: {{names}}.',
			dkgOverdueHelp:
				'La generación de clave solo continúa cuando todos los custodios participan, y no ocurre nada automáticamente. Pídeles que abran la pantalla de custodio de esta elección en la aplicación de su propio dispositivo.',
			dkgOverdueUnnamed: 'un custodio que no está en la lista de esta elección',
			keyholderStatusAcceptAgain: 'Debe aceptar de nuevo',
			keyholderReacceptOfficerNote:
				'Este custodio aceptó una versión anterior de esta elección. La elección cambió desde entonces y los custodios aceptan cada versión por separado, para que la clave de la elección la generen solo custodios que aceptaron la versión actual. Envía una nueva invitación y pídele que la acepte.',
			keyholderReacceptAcceptNote:
				'Los custodios aceptan una versión de una elección. Si la elección cambia después de que aceptes, un funcionario te envía una nueva invitación y vuelves a aceptar, para que la clave de la elección siempre corresponda a la versión que aceptaste.',
			reassociationReviewAuthorityWide: 'Esta configuración se aplica a todas las elecciones de esta autoridad.',
			reassociationReviewNoteCurrent: 'Configuración actual: {{value}}',
			reassociationReviewNoteWhere: 'Para cambiarla, abre {{screen}} de esta autoridad.',
			sealedBeforeOfficerExplanation:
				'Los datos sellados solo pueden leerlos los funcionarios que podían leerlos cuando se sellaron. Los funcionarios añadidos después, o que activaron la recepción cifrada después, nunca obtienen acceso. Es intencional: nadie puede ampliar después quién lee los datos de un votante. Un funcionario que podía leerlos en ese momento se encarga de este registro.',
		},
	},
};

const deviceLanguage = getLocales()[0]?.languageCode ?? 'en';

// Guard: a re-evaluation of this module (Fast Refresh) must not re-run init() and reset the
// language the user chose back to the device locale.
if (!i18n.isInitialized)
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
