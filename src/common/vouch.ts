import { AuthorizedTimestamp } from "./authorized-timestamp";

export interface VouchDate {
    approx: boolean;
    year: number;
    month?: number;
    day?: number;
}

export interface Vouch {
    /** TSA timestamp of registration */
    timestamp: AuthorizedTimestamp,
    /** The CID of the registrant making the assertion */
    registrantCid: string;
    /** The CID of the registrant being vouched for */
    otherCid: string;
    /** What is being asserted */
    assertion: "resident" | "not";
    /** Confidence in the assertion - if none, doesn't matter what is being asserted */
    certainty: "none" | "low" | "medium" | "high";
    /** The first known residency, or known non-residency*/
    from?: VouchDate;
    /** The most recent known residency, or known non-residency */
    to?: "present" | VouchDate;
}
