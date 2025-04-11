import type {Authority, Administrator} from '@votetorrent/vote-core';

export type RootStackParamList = {
	Home: undefined;
	AuthorityDetails: {authority: Authority};
	Networks: undefined;
	AdministratorDetails: {administrator: Administrator};
	AddNetwork: undefined;
	Hosting: undefined;
	ReplaceAdministration: {
		authority: Authority;
		administrator?: Administrator;
		removeAdministrator?: boolean;
	};
	EditAdministrator: {
		authority: Authority;
		administratorSid?: string;
	};
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
