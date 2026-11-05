import { KEYHOLDER_POLICY_ERROR_KEY, validateKeyholderPolicy } from "../keyholder-policy";

describe("validateKeyholderPolicy", () => {
	it("refuses fewer than two keyholders", () => {
		expect(validateKeyholderPolicy(["A"], 1)).toEqual({ ok: false, reason: "too-few-keyholders" });
		expect(validateKeyholderPolicy([], 0)).toEqual({ ok: false, reason: "too-few-keyholders" });
	});
	it("refuses a threshold below 2", () => {
		expect(validateKeyholderPolicy(["A", "B"], 1)).toEqual({ ok: false, reason: "threshold-too-low" });
	});
	it("refuses a threshold above the keyholder count", () => {
		expect(validateKeyholderPolicy(["A", "B"], 3)).toEqual({ ok: false, reason: "threshold-above-count" });
	});
	it("accepts 2-of-2 and 2-of-3", () => {
		expect(validateKeyholderPolicy(["A", "B"], 2)).toEqual({ ok: true });
		expect(validateKeyholderPolicy(["A", "B", "C"], 2)).toEqual({ ok: true });
	});
	it("refuses two keyholders with the same name (trimmed, case-insensitive, NFC)", () => {
		expect(validateKeyholderPolicy(["Kay", " kay "], 2)).toEqual({ ok: false, reason: "duplicate-keyholder-name" });
		expect(validateKeyholderPolicy(["K\u00e1y", "Ka\u0301y"], 2)).toEqual({ ok: false, reason: "duplicate-keyholder-name" });
		expect(KEYHOLDER_POLICY_ERROR_KEY["duplicate-keyholder-name"]).toBe("keyholderPolicyDuplicateName");
	});
	it("distinct names still pass", () => {
		expect(validateKeyholderPolicy(["Kay", "Kai"], 2)).toEqual({ ok: true });
	});
});
