/**
 * Per-tab param-list types (D-08/D-09) — mirrors Authority's flat-object-literal style
 * (`apps/VoteTorrentAuthority/src/navigation/types.ts`), NOT a class/enum. Unlike Authority's
 * single flat `RootStackParamList`, Voting's `RootNavigator` IS the `Tab.Navigator` itself and
 * each `Tab.Screen`'s `component` is its own `createNativeStackNavigator()` instance owning that
 * tab's full screen list including modals (D-08) — so there is one param list per tab stack
 * plus a `RootTabParamList` for the tab navigator.
 *
 * All params are `undefined` this phase — no route params for placeholders (39-05 scope). Wired
 * together by 39-07's RootNavigator.
 */

// Vote tab: Home root + Ballot pushed + the 4 question/info modals (D-09 topology) +
// ValidationDetails (HOME-03/D-11 trust-story drill-in, plain push — not a modal).
export type VoteStackParamList = {
	Home: undefined;
	Ballot: undefined;
	IndividualQuestion: undefined;
	ElectionInfo: undefined;
	OfficeInfo: undefined;
	CandidateInfo: undefined;
	ValidationDetails: undefined;
	// Phase 42 (VOTE-04, D-05) — per-office selection summary + final Submit. All `undefined`
	// like every other entry above: selection state (selectionMap, currentQuestionIndex) lives
	// on BallotSelectionProvider, never a navigation param.
	ReviewSubmit: undefined;
};

// Registration tab: root + Device Attestation + Confirmation modals + the 3 form-step
// routes (RegisterPersonal/RegisterAddressParty/RegisterConfirm, 41-06/07/08) + the
// RegistrationInfo help modal (41-08). All `undefined` — draft state lives in
// `RegistrationDraftProvider`, not navigation params (RESEARCH Pattern 1/2).
export type RegistrationStackParamList = {
	RegistrationHome: undefined;
	DeviceAttestation: undefined;
	Confirmation: undefined;
	RegisterPersonal: undefined;
	RegisterAddressParty: undefined;
	RegisterConfirm: undefined;
	RegistrationInfo: undefined;
};

// Scan tab: single root screen, no modals.
export type ScanStackParamList = {
	ScanHome: undefined;
};

// Settings tab: single root screen, no modals.
export type SettingsStackParamList = {
	SettingsHome: undefined;
};

// The 4 tabs, in D-09 locked order: Vote · Registration · Scan · Settings.
export type RootTabParamList = {
	Vote: undefined;
	Registration: undefined;
	Scan: undefined;
	Settings: undefined;
};
