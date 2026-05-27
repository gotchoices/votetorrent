import type {
	Authority,
	Officer,
	DefaultUser,
	IDefaultUserEngine,
	User,
	IUserEngine,
	ReleaseKeyTask,
	SignatureTask,
	IElectionEngine,
	NetworkReference,
} from '@votetorrent/vote-core';

export type RootStackParamList = {
	Home: undefined;
	Networks: undefined;
	AddNetwork: undefined;
	NetworkDetails: { network: NetworkReference };
	Hosting: undefined;
	// Phase 8 plan 08-06 — Networks routes (NETUI-05, NETUI-06; D-12 / D-13)
	NetworkStatistics: { networkId: string };
	NetworkRevision: { networkId: string };
	AuthorityDetails: { authority: Authority };
	// Phase 8 plan 08-01: typed entry for ProposedAdministration (screen lands in 08-02 per D-04)
	ProposedAdministration: { authorityId: string };
	OfficerDetails: { officer: Officer };
	// Phase 8 plan 08-03 — Administrator + Authority invitation routes (D-08, D-09)
	AdministratorInvitation: { mode: "send" | "accept"; invitationId?: string; authority?: Authority };
	AuthorityInvitation: { mode: "send" | "accept"; invitationId?: string };
	ReplaceAdmin: {
		authority: Authority;
		officer?: Officer;
		removeOfficer?: boolean;
	};
	EditOfficer: {
		authority: Authority;
		officerId?: string;
	};
	DefaultUser: { defaultUser: DefaultUser; defaultUserEngine: IDefaultUserEngine };
	UserDetails: { user: User; userEngine: IUserEngine };
	ReviseUser: { user: User; userEngine: IUserEngine };
	AddKey: { user: User; userEngine: IUserEngine };
	RevokeKey: { user: User; userEngine: IUserEngine };
	AddDevice: undefined;
	KeyTask: { task: ReleaseKeyTask };
	SignatureTask: { task: SignatureTask };
	// Phase 7 scaffold routes (07-05; renamed by 07-08) — standalone screens per D-09; real impls land in Phases 8–10
	EditElection: { taskId?: string };
	AuthorityDetail: { taskId?: string };
	EditElectionWithFilter: { taskId?: string };
	EditRevisionForm: { taskId?: string };
	ProposedElection: { taskId?: string };
	ProposedRevision: { taskId?: string };
	// Dev-entry route per D-12 — temporary; replaced by real callers in phases 8–10 (renamed by 07-08)
	ScreenScaffoldsDebug: undefined;
	ElectionDetails: { electionEngine: IElectionEngine };
	EditBallot: undefined;
	// Phase 9 plan 09-01 — type entries for routes whose screens land in later
	// plans (CreateElection in 09-02, CreateBallot in 09-04). Stack.Screen
	// registration is deferred; only the type signature is added here so the
	// navigate(...) calls in ElectionsScreen / ElectionDetailsScreen compile.
	CreateElection: undefined;
	CreateBallot: { electionId: string };
};

export type TabParamList = {
	Elections: undefined;
	Signers: undefined;
	Authorities: undefined;
	Settings: undefined;
};

export type NavigationProp = {
	navigate: (screen: keyof RootStackParamList, params?: any) => void;
	setOptions: (options: any) => void;
	goBack: () => void;
};
