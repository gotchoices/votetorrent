import type {
	Authority,
	Administrator,
	DefaultUser,
	IDefaultUserEngine,
	User,
	IUserEngine,
	AdornedNetworkReference,
	ReleaseKeyTask,
	SignatureTask,
	SID,
	IElectionEngine,
} from '@votetorrent/vote-core';

export type RootStackParamList = {
	Home: undefined;
	Networks: undefined;
	AddNetwork: undefined;
	NetworkDetails: { network: AdornedNetworkReference };
	Hosting: undefined;
	AuthorityDetails: { authority: Authority };
	AdministratorDetails: { administrator: Administrator };
	ReplaceAdministration: {
		authority: Authority;
		administrator?: Administrator;
		removeAdministrator?: boolean;
	};
	EditAdministrator: {
		authority: Authority;
		administratorSid?: string;
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
