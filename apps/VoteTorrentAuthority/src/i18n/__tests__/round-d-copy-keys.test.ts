/**
 * round-d-copy-keys.test.ts — the round-d Authority copy catalog (14 keys, en + es).
 * Renderer-free: asserts only against the imported `resources` object.
 */
import { resources } from "../index";

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const KEYS = [
	"bootNetworkLoadFailed",
	"bootTryAgain",
	"bootStartFresh",
	"authorityNotOnNetworkTitle",
	"authorityNotOnNetworkBody",
	"authorityDetailsLoadFailed",
	"authoritiesLoadFailed",
	"authorityPinFailed",
	"officersLoadFailed",
	"invitedAuthoritiesLoadFailed",
	"peerWriteUnavailable",
	"electionsLoadFailed",
	"tasksLoadFailed",
	"settingsLoadFailed",
] as const;

describe("round-d copy catalog", () => {
	it.each(KEYS)("%s exists in en and es, translated", (key) => {
		expect(typeof en[key]).toBe("string");
		expect(en[key].length).toBeGreaterThan(0);
		expect(typeof es[key]).toBe("string");
		expect(es[key].length).toBeGreaterThan(0);
		expect(es[key]).not.toBe(en[key]);
	});

	it.each(KEYS)("%s carries no GSD numbers", (key) => {
		for (const value of [en[key], es[key]]) {
			expect(value).not.toMatch(/\d{2,}/);
			expect(value).not.toMatch(/\b(phase|fase|plan)\b/i);
		}
	});

	it("authorityNotOnNetworkBody promises nothing about pins", () => {
		expect(en.authorityNotOnNetworkBody).not.toMatch(/pin/i);
		expect(es.authorityNotOnNetworkBody).not.toMatch(/marc/i);
	});
});
