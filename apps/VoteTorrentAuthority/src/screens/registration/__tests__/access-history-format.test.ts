import { formatAccessTimestamp, joinFieldNames, resolveViewerLabel } from "../access-history-format";

/**
 * access-history-format.test.ts — renderer-free unit proof for the three
 * pure D-01 trail formatters. No `react-test-renderer` import; the module
 * under test is React-free, theme-free and engine-free, so this file has
 * nothing to mock.
 */
describe("formatAccessTimestamp", () => {
	it("formats a Z-suffixed ISO timestamp as 'YYYY-MM-DD HH:MM UTC'", () => {
		expect(formatAccessTimestamp("2026-08-03T14:02:37.000Z")).toBe("2026-08-03 14:02 UTC");
	});

	it("normalizes an offset ISO string to UTC rather than echoing the input's offset", () => {
		expect(formatAccessTimestamp("2026-08-03T14:02:37+02:00")).toBe("2026-08-03 12:02 UTC");
	});

	it("returns an unparseable string unchanged rather than throwing or rendering 'Invalid Date'", () => {
		expect(formatAccessTimestamp("not-a-date")).toBe("not-a-date");
	});

	it("returns an empty string unchanged rather than throwing", () => {
		expect(formatAccessTimestamp("")).toBe("");
	});
});

describe("joinFieldNames", () => {
	it("joins field names with ', ', preserving the caller's order exactly (the engine already sorted it)", () => {
		expect(joinFieldNames(["ssn", "dob"])).toBe("ssn, dob");
	});

	it("drops empty, whitespace-only and non-string entries", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(joinFieldNames(["ssn", "", "  ", "dob", 42 as any])).toBe("ssn, dob");
	});

	it("returns '' for an empty array", () => {
		expect(joinFieldNames([])).toBe("");
	});

	it("returns '' for undefined", () => {
		expect(joinFieldNames(undefined)).toBe("");
	});

	it("returns '' for a non-array input without throwing", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(joinFieldNames("not-an-array" as any)).toBe("");
	});

	it("negative space: joinFieldNames does not filter values — the names-only guarantee is the engine's, not this module's. This assertion exists to document that boundary precisely, so nobody later mistakes this formatter for a second security filter and weakens the engine one.", () => {
		expect(joinFieldNames(["000-00-0000"])).toBe("000-00-0000");
	});
});

describe("resolveViewerLabel", () => {
	it("returns the trimmed resolved name when present", () => {
		expect(resolveViewerLabel("u-0123456789", "Jane Officer")).toBe("Jane Officer");
	});

	it("falls back to the truncated id when the resolved name is whitespace-only", () => {
		expect(resolveViewerLabel("u-0123456789", "   ")).toBe("u-012...");
	});

	it("falls back to the truncated id when no resolved name is supplied", () => {
		expect(resolveViewerLabel("u-0123456789")).toBe("u-012...");
	});

	it("returns the id unchanged when shorter than the truncation keep", () => {
		expect(resolveViewerLabel("abcd")).toBe("abcd");
	});
});
