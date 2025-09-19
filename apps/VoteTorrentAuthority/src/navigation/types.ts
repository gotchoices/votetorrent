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
		officerSid?: string;
	};
	DefaultUser: { defaultUser: DefaultUser; defaultUserEngine: IDefaultUserEngine };
	UserDetails: { user: User; userEngine: IUserEngine };
	ReviseUser: { user: User; userEngine: IUserEngine };
	AddKey: { user: User; userEngine: IUserEngine };
	RevokeKey: { user: User; userEngine: IUserEngine };
	AddDevice: undefined;
	KeyTask: { task: ReleaseKeyTask };
	SignatureTask: { task: SignatureTask };
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
