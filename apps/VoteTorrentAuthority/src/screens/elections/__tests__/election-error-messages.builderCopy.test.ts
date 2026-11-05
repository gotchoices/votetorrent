import { mapElectionError } from "../election-error-messages";

const t = (key: string) => key;
const builderErr = (errors: Array<{ path: string; code: string; message: string }>) => ({
	name: "BuilderValidationError",
	errors,
});

describe("mapElectionError builder validation copy", () => {
	it("V-1: an unmapped missing field shows translated required copy, never the builder text", () => {
		const out = mapElectionError(
			builderErr([{ path: "election.ballots[0].name", code: "MISSING", message: "election.ballots[0].name is required" }]),
			t,
		);
		expect(out).toBe("validationRequired");
		expect(out).not.toContain("is required");
		expect(out).not.toContain("ballots");
	});

	it("V-1: an unmapped invalid field shows translated invalid copy", () => {
		const out = mapElectionError(
			builderErr([{ path: "election.ballots[0].name", code: "INVALID", message: "election.ballots[0].name is bad" }]),
			t,
		);
		expect(out).toBe("validationInvalid");
	});

	it("V-1: an unknown code shows the generic validation copy", () => {
		const out = mapElectionError(
			builderErr([{ path: "election.questions", code: "NO_QUESTIONS", message: "needs at least one question" }]),
			t,
		);
		expect(out).toBe("validationFailed");
		expect(out).not.toContain("question");
	});

	it("V-2: mapped cases are unchanged", () => {
		expect(mapElectionError(builderErr([{ path: "x", code: "THRESHOLD_EXCEEDS_KEYHOLDERS", message: "m" }]), t)).toBe(
			"errThresholdExceedsKeyholders",
		);
		expect(mapElectionError(builderErr([{ path: "x", code: "TIMELINE_ORDER", message: "m" }]), t)).toBe("errTimelineOrder");
		expect(mapElectionError(builderErr([{ path: "election.revisionDeadline", code: "INVALID", message: "m" }]), t)).toBe(
			"errRevisionDeadlineInvalid",
		);
		expect(mapElectionError(builderErr([{ path: "election.date", code: "MISSING", message: "m" }]), t)).toBe(
			"errElectionDateInvalid",
		);
		expect(mapElectionError(builderErr([{ path: "election.title", code: "EMPTY", message: "m" }]), t)).toBe("errTitleRequired");
		expect(mapElectionError(new Error("BallotDeadlineValid failed"), t)).toBe("errBallotDeadlineAfterDate");
		expect(mapElectionError(new Error("RevisionDeadline Date"), t)).toBe("errRevisionDeadlineAfterDate");
		expect(mapElectionError(new Error("tallyingStarts"), t)).toBe("errTimelineOrder");
		expect(mapElectionError(new Error("boom"), t)).toBe("errCouldNotSaveElection");
	});
});
