/**
 * ElectionTimelineList.i18n.test.tsx — Phase 59 plan 59-01.
 *
 * Split from ElectionTimelineList.test.tsx because that file mocks
 * react-i18next with an identity t() (needed to assert EVENT_ORDER
 * completeness/order by raw member name); jest.mock() is file-scoped, and
 * importing the real src/i18n/index.ts resources map into that same file
 * would call the mocked (undefined) initReactI18next and crash. Renderer-
 * free, following src/i18n/__tests__/registrant-keys.test.ts's convention
 * of importing only the exported `resources` object.
 *
 * Asserts the two new D-08 events' Authority labels resolve in BOTH
 * languages — the identity-t mock in the sibling file deliberately cannot
 * see this (it echoes the key, not the resolved value).
 */
import { resources } from "../../../i18n";

describe("ElectionTimelineList Authority i18n — accruingVotes / hashingVotes", () => {
	it("accruingVotes resolves to a non-empty string in EN", () => {
		expect(typeof resources.en.translation.accruingVotes).toBe("string");
		expect(resources.en.translation.accruingVotes.length).toBeGreaterThan(0);
	});

	it("hashingVotes resolves to a non-empty string in ES", () => {
		expect(typeof resources.es.translation.hashingVotes).toBe("string");
		expect(resources.es.translation.hashingVotes.length).toBeGreaterThan(0);
	});

	it("accruingVotes resolves to a non-empty string in ES", () => {
		expect(typeof resources.es.translation.accruingVotes).toBe("string");
		expect(resources.es.translation.accruingVotes.length).toBeGreaterThan(0);
	});

	it("hashingVotes resolves to a non-empty string in EN", () => {
		expect(typeof resources.en.translation.hashingVotes).toBe("string");
		expect(resources.en.translation.hashingVotes.length).toBeGreaterThan(0);
	});
});
