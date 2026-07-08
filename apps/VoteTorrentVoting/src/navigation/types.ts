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

// Vote tab: Home root + Ballot pushed + the 4 question/info modals (D-09 topology).
export type VoteStackParamList = {
	Home: undefined;
	Ballot: undefined;
	IndividualQuestion: undefined;
	ElectionInfo: undefined;
	OfficeInfo: undefined;
	CandidateInfo: undefined;
};

// Registration tab: root + Device Attestation + Confirmation modals.
export type RegistrationStackParamList = {
	RegistrationHome: undefined;
	DeviceAttestation: undefined;
	Confirmation: undefined;
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
