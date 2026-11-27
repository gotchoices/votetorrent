/**
 * relayAddressValidation.test.ts — helper CONTRACT coverage (R4 / D-11).
 *
 * Every assertion below injects its own `parse` function (a plain `jest.fn()` that throws for a
 * named string and returns `{}` otherwise). This suite asserts the helper's CONTRACT — trim/drop
 * normalization, first-throwing-address selection, "input unchanged" for `findInvalidRelayAddress`
 * — and makes NO claim about multiaddr grammar. It never imports, mocks or unmocks
 * `@multiformats/multiaddr` in any form, so it is immune to D-15's mock-vs-real blind spot by
 * construction. Grammar/validity claims (does the REAL 13.0.3 parser accept or reject a given
 * address) are owned exclusively by `scripts/assert-relay-multiaddr-fixtures.mjs` — see that file
 * for the real-parser + mock-discrimination evidence (D-15).
 */

import { readFileSync } from "fs";
import path from "path";
import { normalizeRelayAddresses, findInvalidRelayAddress } from "../relayAddressValidation";

describe("normalizeRelayAddresses", () => {
	it("trims every entry", () => {
		expect(normalizeRelayAddresses([" a ", "b\t", "\nc"])).toEqual(["a", "b", "c"]);
	});

	it("drops entries that are empty after trimming", () => {
		expect(normalizeRelayAddresses(["a", "   ", "", "b"])).toEqual(["a", "b"]);
	});

	it("returns a new array and does not mutate the input", () => {
		const input = [" a ", "b"];
		const inputCopy = [...input];
		const result = normalizeRelayAddresses(input);
		expect(result).not.toBe(input);
		expect(input).toEqual(inputCopy);
	});

	it('normalizes ["  "] to [] — whitespace-only is ABSENT, not INVALID (keeps errRelayRequired ownership)', () => {
		expect(normalizeRelayAddresses(["  "])).toEqual([]);
	});

	it('normalizes [" /ip4/127.0.0.1/tcp/4001 "] to ["/ip4/127.0.0.1/tcp/4001"]', () => {
		expect(normalizeRelayAddresses([" /ip4/127.0.0.1/tcp/4001 "])).toEqual([
			"/ip4/127.0.0.1/tcp/4001",
		]);
	});
});

describe("findInvalidRelayAddress", () => {
	function throwingParse(badValues: readonly string[]) {
		return jest.fn((value: string) => {
			if (badValues.includes(value)) throw new Error(`invalid: ${value}`);
			return {};
		});
	}

	it("returns undefined when the injected parse throws for none of the addresses", () => {
		const parse = throwingParse([]);
		expect(findInvalidRelayAddress(["a", "b", "c"], parse)).toBeUndefined();
		expect(parse).toHaveBeenCalledTimes(3);
	});

	it("returns undefined for an empty address list without calling parse", () => {
		const parse = throwingParse(["irrelevant"]);
		expect(findInvalidRelayAddress([], parse)).toBeUndefined();
		expect(parse).not.toHaveBeenCalled();
	});

	it("returns the FIRST address for which the injected parse throws", () => {
		const parse = throwingParse(["b", "c"]);
		expect(findInvalidRelayAddress(["a", "b", "c"], parse)).toBe("b");
		// short-circuits: never probes "c" once "b" has already failed
		expect(parse).toHaveBeenCalledTimes(2);
	});

	it("is called with already-normalized input and does not re-normalize — a raw un-trimmed string is passed to parse unchanged", () => {
		const parse = jest.fn(() => ({}));
		findInvalidRelayAddress(["  /already/not/trimmed  "], parse);
		expect(parse).toHaveBeenCalledWith("  /already/not/trimmed  ");
	});

	it("treats any returned value (including undefined) from parse as VALID — only a throw means invalid", () => {
		const parse = jest.fn((value: string) => (value === "returns-undefined" ? undefined : { ok: true }));
		expect(findInvalidRelayAddress(["returns-undefined", "returns-object"], parse)).toBeUndefined();
	});
});

describe("relay-address-fixtures.json corpus is well-formed", () => {
	it("parses, is non-empty, every entry has all three keys, expected is one of the two literals, and both literals are represented", () => {
		const fixturePath = path.join(__dirname, "../../../__fixtures__/relay-address-fixtures.json");
		const raw = readFileSync(fixturePath, "utf8");
		const parsed = JSON.parse(raw) as { fixtures: Array<Record<string, unknown>> };

		expect(Array.isArray(parsed.fixtures)).toBe(true);
		expect(parsed.fixtures.length).toBeGreaterThan(0);

		const seenExpected = new Set<string>();
		for (const entry of parsed.fixtures) {
			expect(typeof entry.address).toBe("string");
			expect(typeof entry.expected).toBe("string");
			expect(typeof entry.why).toBe("string");
			expect(["valid", "invalid"]).toContain(entry.expected);
			seenExpected.add(entry.expected as string);
		}
		expect(seenExpected.has("valid")).toBe(true);
		expect(seenExpected.has("invalid")).toBe(true);
	});
});
