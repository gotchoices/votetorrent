/**
 * The approval, invitation, ballot, election and add-network screens held to the strict raw-error
 * rule (C12 / O-09), relative to src, posix separators.
 *
 * One list, shared by both guards: raw-error-message-strict.guard.test.ts scans these files with
 * no allowance, and raw-error-message-guard.test.ts refuses any exemption naming one of them. The
 * two copies used to drift apart (REVIEW CR-R5-01), so neither guard keeps its own copy, and both
 * assert that every entry exists on disk.
 *
 * Lives outside __tests__ so jest does not collect it as a suite.
 */
export const STRICT_RAW_ERROR_FILES: readonly string[] = [
	'screens/registration/RegistrationRequestApprovalScreen.tsx',
	'screens/admin/AdministratorInvitationScreen.tsx',
	'screens/authorities/AuthorityInvitationScreen.tsx',
	'screens/keyholder/KeyholderInvitationScreen.tsx',
	'screens/ballots/EditBallotScreen.tsx',
	'screens/elections/ElectionDetailsScreen.tsx',
	'screens/networks/AddNetworkScreen.tsx',
];
