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
	// Phase 7 onboarding routes (07-05) — standalone screens per D-09
	OnboardingFrame2: { taskId?: string };
	OnboardingFrame7: { taskId?: string };
	OnboardingFrame18: { taskId?: string };
	OnboardingFrame19: { taskId?: string };
	OnboardingFrame20: { taskId?: string };
	OnboardingFrame21: { taskId?: string };
	// Dev-entry route per D-12 (temporary; replaced by real callers in phases 8–10)
	OnboardingDebug: undefined;
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
