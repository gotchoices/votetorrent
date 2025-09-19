import type { ElectionDetails, ElectionInit, BallotInit } from '../election';
import type { NetworkReference, NetworkInit } from '../network';
import type { SID } from '../index';
import type { AdminInit, AuthorityInit, Authority } from '../authority';
import type { Proposal, Signature } from '../common';

export type Task = {
	type: string;
};

export type ReleaseKeyTask = Task & {
	type: 'release-key';
	network: NetworkReference;
	election: ElectionDetails;
	userSid: SID;
};

export type SignatureTask = Task & {
	type: 'signature';
	network: NetworkReference;
	userSid: SID;
	signatureType:
		| 'admin'
		| 'authority'
		| 'network'
		| 'election'
		| 'election-revision'
		| 'ballot';
};

export type AdminSignatureTask = SignatureTask & {
	signatureType: 'admin';
	administration: Proposal<AdminInit>;
	authority: Authority;
};

export type AuthoritySignatureTask = SignatureTask & {
	signatureType: 'authority';
	authority: Proposal<AuthorityInit>;
};

export type NetworkSignatureTask = SignatureTask & {
	signatureType: 'network';
	networkRevision: Proposal<NetworkInit>;
};

export type ElectionSignatureTask = SignatureTask & {
	signatureType: 'election';
	election: Proposal<ElectionInit>;
};

export type ElectionRevisionSignatureTask = SignatureTask & {
	signatureType: 'election-revision';
	election: Proposal<ElectionInit>;
};

export type BallotSignatureTask = SignatureTask & {
	signatureType: 'ballot';
	ballot: Proposal<BallotInit>;
};

export type SignatureResult = {
	isAccepted: boolean;
	signature: Signature;
};
