export type Proposal<T> = {
	proposed: T;
	/** The ids of officers that have signed the proposal */
	signers: string[];
};
