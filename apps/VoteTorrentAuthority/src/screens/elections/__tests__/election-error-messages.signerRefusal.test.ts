import { mapElectionError } from "../election-error-messages";

const t = (key: string) => key;

// Session 1 Pixel_8 A-9 (2026-10-08): on a network where the device holds no officer seat, Create
// Election was refused with `ConstraintError: CHECK constraint failed: SignerKeyValid`, and the
// screen said "Could not save the election. Please review the dates and try again." The dates
// were fine; the signer was not an officer.
const constraintError = (name: string) =>
	Object.assign(new Error(`CHECK constraint failed: ${name}`), { name: "ConstraintError" });

describe("mapElectionError signer refusals", () => {
	it.each(["SignerKeyValid", "OfficerValid"])("a %s refusal says the device holds no officer seat, not the dates", (name) => {
		const out = mapElectionError(constraintError(name), t);
		expect(out).toBe("errElectionSignerNotOfficer");
		expect(out).not.toBe("errCouldNotSaveElection");
	});

	it("an unrelated constraint still falls back to the generic save copy (guard)", () => {
		expect(mapElectionError(constraintError("SomethingElseValid"), t)).toBe("errCouldNotSaveElection");
	});
});
