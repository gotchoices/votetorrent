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
	AuthorityDetails: { authority: Authority };
	// Phase 8 plan 08-01: typed entry for ProposedAdministration (screen lands in 08-02 per D-04)
	ProposedAdministration: { authorityId: string };
	OfficerDetails: { officer: Officer };
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
};
