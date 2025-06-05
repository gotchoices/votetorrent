import type { Signature } from './signature';
import type { Timestamp } from './types';

export type Proposal<T> = {
	proposed: T;
	/** The timestamp of the proposal (untrusted) */
	timestamp: Timestamp;
	/** The signatures of the proposal */
	signatures: Signature[];
}
