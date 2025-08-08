import type { Signature } from './signature.js';

export type Signed<T extends Record<string, string>> = {
	content: T;
	signature: Signature;
};
