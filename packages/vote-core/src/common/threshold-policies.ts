import type { Scope } from "../authority/models";

export type ThresholdPolicy = {
	/** The threshold policy */
	policy: Scope;

	/** The threshold value */
	threshold: number;
}