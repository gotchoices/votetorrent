import type { Scope } from '../authority';
import type { Signature } from '../common';
import type { SigningResult } from './models';

export type ISigningEngine = {
	sign(nonce: string, signature: Signature): Promise<boolean>; //true if the threshold has been reached and an AdminSignature has been created
	startSigningSession(
		authorityId: string,
		digest: string,
		scope: Scope,
		signature: Signature
	): Promise<SigningResult>;
};
