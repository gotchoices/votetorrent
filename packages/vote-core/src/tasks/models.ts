import type { ElectionDetails, ElectionInit, Ballot } from '../election';
import type { NetworkReference, NetworkInit } from '../network';
import type { AdminInit, AuthorityInit, Authority } from '../authority';
import type { Proposal, Signature } from '../common';

export type Task = {
	type: string;
};

export type ReleaseKeyTask = Task & {
	type: 'release-key';
	network: NetworkReference;
	election: ElectionDetails;
	userId: string;
};

export type SignatureTask = Task & {
	type: 'signature';
	network: NetworkReference;
	userId: string;
	signatureType:
		| 'admin'
		| 'authority'
		| 'ballot'
		| 'election'
		| 'election-revision'
		| 'network';
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
	network: Proposal<NetworkInit>;
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
	ballot: Proposal<Ballot>;
};

export type SignatureResult = {
	isAccepted: boolean;
	signature: Signature;
};
